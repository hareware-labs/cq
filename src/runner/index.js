import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { StreamParser } from './stream.js';
import { buildPrompt } from './prompt.js';
import { classifyExit } from '../limits/index.js';
import { cqPaths } from '../util/paths.js';

export const STDERR_TAIL_BYTES = 4096;

/**
 * Probe which optional flags this CLI accepts.
 *
 * `--max-turns` is functional in 2.1.261 but absent from `--help`, so it can be removed
 * without a deprecation cycle. Probing once and caching means a future removal degrades
 * to "cq stops passing it" rather than "every task fails with unknown option".
 */
export function probeCapabilities(bin = 'claude') {
  const caps = { max_turns: false, max_budget_usd: false, version: null, probed_at: Date.now() };
  try {
    caps.version = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch { return caps; }
  try {
    const help = execFileSync(bin, ['--help'], { encoding: 'utf8', timeout: 20_000 });
    caps.max_budget_usd = help.includes('--max-budget-usd');
    // Undocumented flags need an actual probe: absence from --help proves nothing.
    caps.max_turns = help.includes('--max-turns') || probeFlag(bin, '--max-turns');
  } catch { /* keep the conservative defaults */ }
  return caps;
}

/**
 * Does `bin` accept `flag`?
 *
 * Deliberately passes NO prompt and closes stdin, so the CLI rejects the invocation
 * before it ever reaches the API -- the probe must never cost usage. Verified against
 * 2.1.261: with a prompt absent it exits with "Input must be provided either through
 * stdin or as a prompt argument", while an unrecognised flag is rejected earlier still
 * by argument parsing. Only that second message means the flag is gone.
 */
export function probeFlag(bin, flag) {
  try {
    execFileSync(bin, ['--print', '--output-format', 'stream-json', flag, '1'],
      { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch (err) {
    const out = `${err.stderr ?? ''}${err.stdout ?? ''}`;
    return !new RegExp(`unknown option.*${flag.replace(/-/g, '\\-')}`).test(out);
  }
}

/** Re-probe at most this often; a CLI's flags do not change between two task runs. */
export const CAPS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Cached capability probe. Probing costs no usage but does cost a few seconds of CLI
 * startup, which is pure overhead on every `cq run`.
 */
export function cachedCapabilities(bin, cached, { now = Date.now() } = {}) {
  const version = currentVersion(bin);
  const fresh = cached?.probed_at && (now - cached.probed_at) < CAPS_TTL_MS;
  if (fresh && cached.version && cached.version === version) return cached;
  return probeCapabilities(bin);
}

function currentVersion(bin) {
  try { return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim(); }
  catch { return null; }
}

/** Assemble argv for one task run. Exported so tests can assert it without spawning. */
export function buildArgs(task, {
  resume = null, model = 'sonnet', maxTurns = null, maxBudgetUsd = null,
  permissionMode = 'bypassPermissions', allowedTools = null, caps = {},
} = {}) {
  const args = ['--print', '--output-format', 'stream-json', '--verbose'];
  // --verbose is mandatory with stream-json in print mode (verified: omitting it exits
  // 1 with "requires --verbose").

  // Always explicit. The ambient default is Opus, which billed $0.04 for a five-token
  // reply in the observed sample -- never inherit it.
  args.push('--model', model);

  if (resume) args.push('--resume', resume);
  if (maxTurns && caps.max_turns !== false) args.push('--max-turns', String(maxTurns));
  if (maxBudgetUsd && caps.max_budget_usd !== false) args.push('--max-budget-usd', String(maxBudgetUsd));
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(','));
  return args;
}

/**
 * Convert a `max_turns` budget into a dollar cap.
 *
 * A backstop, not an estimate: it exists so an undocumented `--max-turns` disappearing
 * cannot produce an unbounded run. Deliberately generous -- a task killed by the money
 * cap loses its work, so this should only ever fire when something is genuinely wrong.
 */
export function budgetForTurns(maxTurns, model = 'sonnet') {
  const perTurn = /opus/i.test(model) ? 0.25 : 0.05;
  return Math.max(1, Math.ceil((maxTurns ?? 40) * perTurn));
}

/**
 * Run exactly one task in a fresh `claude -p` process.
 *
 * Never throws for task-level problems: a crashing task must not take the daemon with
 * it. Spawn failures, non-zero exits, malformed output and timeouts all come back as a
 * resolved outcome object.
 */
export async function runTask(task, opts = {}) {
  const {
    root = process.cwd(), bin = 'claude', model = 'sonnet', maxTurns = 40,
    resume = null, handoff = null, inboxAnswers = [], includeProtocol = true,
    permissionMode = 'bypassPermissions', allowedTools = null, caps = {},
    timeoutMs = 60 * 60 * 1000, env = process.env, onEvent = null, signal = null,
    maxBudgetUsd = null,
  } = opts;

  const paths = cqPaths(root);
  mkdirSync(paths.logs, { recursive: true });

  const prompt = buildPrompt(task, { root, includeProtocol, handoff, inboxAnswers });
  const args = buildArgs(task, {
    resume, model, maxTurns,
    maxBudgetUsd: maxBudgetUsd ?? budgetForTurns(maxTurns, model),
    permissionMode, allowedTools, caps,
  });
  args.push(prompt);

  const parser = new StreamParser();
  parser.onEvent = onEvent;
  const log = createWriteStream(paths.taskLog(task.id), { flags: 'a' });
  const errLog = createWriteStream(paths.taskErr(task.id), { flags: 'a' });
  log.write(JSON.stringify({
    type: 'cq_run_start', task_id: task.id, at: new Date().toISOString(),
    model, max_turns: maxTurns, resume, attempt: (task.attempts ?? 0) + 1,
    args: args.slice(0, -1), prompt_chars: prompt.length,
  }) + '\n');

  const started = Date.now();
  let stderrBuf = '';
  let child;
  try {
    child = spawn(bin, args, {
      cwd: root,
      // stdin is /dev/null: the prompt goes in argv, and an open stdin lets a confused
      // CLI wait forever for input nobody will type.
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch (err) {
    log.end(); errLog.end();
    return outcome({ task, error: err, exitCode: null, parser, started, args, spawnFailed: true });
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { log.write(chunk); parser.push(chunk); });
  child.stderr.on('data', (chunk) => {
    errLog.write(chunk);
    stderrBuf = (stderrBuf + chunk).slice(-STDERR_TAIL_BYTES);
  });

  let timedOut = false;
  let aborted = false;
  const timer = timeoutMs ? setTimeout(() => { timedOut = true; kill(child); }, timeoutMs) : null;
  const onAbort = () => { aborted = true; kill(child); };
  if (signal?.aborted) onAbort();   // already aborted before we got here: no event will fire
  else signal?.addEventListener('abort', onAbort, { once: true });

  const { code, signalName, spawnError } = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    child.on('error', (err) => done({ code: null, signalName: null, spawnError: err }));
    child.on('close', (c, s) => done({ code: c, signalName: s, spawnError: null }));
  });

  if (timer) clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  parser.end();
  await Promise.all([endStream(log), endStream(errLog)]);

  return outcome({
    task, parser, started, args, exitCode: code, signalName,
    error: spawnError, stderrTail: stderrBuf, timedOut, aborted,
    spawnFailed: Boolean(spawnError),
  });
}

function kill(child) {
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  // SIGKILL after a grace period, so a wedged child cannot hold the daemon.
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10_000).unref();
}

function endStream(s) {
  return new Promise((res) => s.end(res));
}

/**
 * Classify one finished run into exactly one disposition. The scheduler consumes this
 * and does no stream inspection of its own.
 */
function outcome({
  task, parser, started, args, exitCode, signalName = null, error = null,
  stderrTail = '', timedOut = false, aborted = false, spawnFailed = false,
}) {
  const s = parser.summary();
  const finalText = s.final_text ?? '';
  const limitFromStream = s.rate_limit?.status === 'rejected' ? s.rate_limit : null;
  const limitFromExit = limitFromStream ? null : classifyExit({ exitCode, stderr: stderrTail, finalText });

  let disposition;
  if (spawnFailed) disposition = 'spawn_failed';
  else if (aborted) disposition = 'aborted';
  // A timeout we imposed is never a rate limit, even when the killed process's output
  // happens to mention one. Checking the limit first parked instead of retrying.
  else if (timedOut) disposition = 'timeout';
  else if (limitFromStream || limitFromExit) disposition = 'rate_limited';
  else if (s.result_subtype === 'error_max_turns' || s.terminal_reason === 'max_turns') disposition = 'max_turns';
  else if (exitCode === 0 && s.saw_result && !s.is_error) disposition = 'success';
  else disposition = 'failed';

  return {
    task_id: task.id,
    disposition,
    exit_code: exitCode,
    signal: signalName,
    session_id: s.session_id,
    cost_usd: s.cost_usd,
    num_turns: s.num_turns,
    usage: s.usage,
    model_usage: s.model_usage,
    duration_ms: Date.now() - started,
    cli_duration_ms: s.duration_ms,
    final_text: finalText,
    rate_limit: s.rate_limit,
    limit_signal: limitFromStream ? 'rate_limit_event' : (limitFromExit ? 'exit_signature' : null),
    limit_decision: limitFromExit,
    stderr_tail: stderrTail.slice(-STDERR_TAIL_BYTES),
    error: error ? `${error.code ?? ''} ${error.message}`.trim() : null,
    saw_result: s.saw_result,
    bad_lines: s.bad_lines,
    unknown_types: s.unknown_types,
    args: args.slice(0, -1),
  };
}
