import { Command, Option, InvalidArgumentError } from 'commander';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue, selectNext, MAX_ATTEMPTS, TERMINAL_STATUSES } from '../queue/index.js';
import { Scheduler, fmtDur } from '../scheduler/index.js';
import { Status } from '../scheduler/status.js';
import { Inbox } from '../inbox/index.js';
import { runPlan, readBrief } from '../plan/index.js';
import { probeCapabilities } from '../runner/index.js';
import { cqPaths } from '../util/paths.js';
import * as daemon from '../daemon/index.js';
import {
  dim, bold, red, green, yellow, cyan, magenta, STATUS_MARK, usd, bar,
  countdown, table, truncate,
} from './format.js';

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const TEMPLATES = fileURLToPath(new URL('../../templates/', import.meta.url));
const CLI_PATH = fileURLToPath(new URL('../../bin/cq.js', import.meta.url));

const root = () => resolve(process.env.CQ_ROOT ?? process.cwd());
const die = (msg) => { console.error(red('error: ') + msg); process.exitCode = 1; };

export function buildCli() {
  const program = new Command();
  program
    .name('cq')
    .description('CQ — calling any station. A usage-aware supervisor for Claude Code:\n' +
                 'runs a task queue unattended, parks when the window is exhausted,\n' +
                 'and resumes when it resets.')
    .version(PKG.version)
    .showHelpAfterError();

  // ---------------------------------------------------------------- init
  program.command('init')
    .description('create .cq/ and add the worker protocol to CLAUDE.md')
    .option('--no-claude-md', 'skip writing the CLAUDE.md snippet')
    .action((opts) => {
      const r = root();
      const paths = cqPaths(r);
      const q = new Queue(r);
      const existed = q.exists();
      q.init();
      new Inbox(r).init();
      mkdirSync(paths.logs, { recursive: true });

      console.log(`${existed ? dim('exists') : green('created')}  ${paths.tasks}`);
      console.log(`${green('ready')}    ${paths.cq}/  ${dim('(inbox.md, status.json, logs/)')}`);

      if (opts.claudeMd) {
        const snippet = readFileSync(join(TEMPLATES, 'target-CLAUDE.md'), 'utf8');
        const md = join(r, 'CLAUDE.md');
        const current = existsSync(md) ? readFileSync(md, 'utf8') : '';
        if (/Running under cq/.test(current)) {
          console.log(`${dim('exists')}   CLAUDE.md already carries the worker protocol`);
        } else {
          appendFileSync(md, (current && !current.endsWith('\n') ? '\n' : '') + '\n' + snippet);
          console.log(`${green('appended')} CLAUDE.md  ${dim('(the protocol now lives in the repo, not in every prompt)')}`);
        }
      }

      // .cq holds logs and machine state; it does not belong in the target's history.
      const gi = join(r, '.gitignore');
      const giBody = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
      if (!/^\.cq\/?$/m.test(giBody)) {
        appendFileSync(gi, (giBody && !giBody.endsWith('\n') ? '\n' : '') + '.cq/\n');
        console.log(`${green('appended')} .gitignore  ${dim('(.cq/)')}`);
      }
      console.log(`\nnext: ${bold('cq add')} "a task" ${dim('or')} ${bold('cq plan brief.md')}, then ${bold('cq run')}`);
    });

  // ---------------------------------------------------------------- add
  program.command('add')
    .description('add a task to the queue')
    .argument('[prompt...]', 'the task prompt (or pipe it on stdin)')
    .option('-t, --title <title>', 'short title')
    .option('-c, --context <files...>', 'context files the worker should be given')
    .option('-d, --depends-on <ids...>', 'task ids that must finish first')
    .option('-p, --priority <n>', 'lower runs first (1-5)',
      numberOption('--priority', { min: 1, max: 5, integer: true }), 2)
    .addOption(new Option('-m, --model <model>', 'model for this task').choices(['sonnet', 'opus', 'fable']))
    .option('--max-turns <n>', 'turn cap for this task',
      numberOption('--max-turns', { min: 1, max: 1000, integer: true }))
    .action((words, opts) => withQueue((q) => {
      const prompt = words.length ? words.join(' ') : readBrief('-');
      if (!prompt.trim()) return die('a task needs a prompt (as an argument or on stdin)');
      const t = q.addTask({
        title: opts.title ?? truncate(prompt, 60),
        prompt: prompt.trim(),
        context_files: opts.context ?? [],
        depends_on: opts.dependsOn ?? [],
        priority: opts.priority,
        model: opts.model ?? null,
        max_turns: opts.maxTurns ?? null,
      });
      console.log(`${green('+')} ${bold(t.id)}  ${t.title}`);
    }));

  // ---------------------------------------------------------------- plan
  program.command('plan')
    .description('decompose a large brief into a dependency-ordered task list (one Opus call)')
    .argument('[file]', 'brief file, or - for stdin')
    .option('--model <model>', 'planning model', 'opus')
    .option('-o, --out <file>', 'write the queue here instead of .cq/tasks.json')
    .option('--dry-run', 'print the plan without writing it')
    .option('--append', 'append to the existing queue instead of replacing it')
    .action(async (file, opts) => {
      const r = root();
      let brief;
      try { brief = readBrief(file); }
      catch (err) { return die(`could not read the brief: ${err.message}`); }
      if (!brief.trim()) return die('the brief is empty');

      console.error(dim(`planning with ${opts.model} (one call, one turn, no tools)…`));
      let out;
      try { out = await runPlan(brief, { bin: binName(), model: opts.model, cwd: r }); }
      catch (err) { return die(err.message); }

      printPlan(out.queue);
      for (const n of out.notes) console.error(dim(`  repaired: ${n}`));
      if (out.cost_usd != null) console.error(dim(`\nplanning cost ${usd(out.cost_usd)}`));

      if (opts.dryRun) return console.error(dim('\n--dry-run: nothing written'));

      const target = opts.out ? resolve(opts.out) : cqPaths(r).tasks;
      const q = new Queue(r);
      if (opts.append && q.exists()) {
        const merged = q.read();
        const offset = merged.tasks.length;
        const remap = new Map(out.queue.tasks.map((t, i) => [t.id, `t-${String(offset + i + 1).padStart(3, '0')}`]));
        for (const t of out.queue.tasks) {
          merged.tasks.push({ ...t, id: remap.get(t.id), depends_on: t.depends_on.map((d) => remap.get(d)) });
        }
        q.write(merged);
        console.error(`\n${green('appended')} ${out.queue.tasks.length} task(s) to ${target}`);
      } else {
        mkdirSync(cqPaths(r).logs, { recursive: true });
        writeFileSync(target, JSON.stringify(out.queue, null, 2) + '\n');
        console.error(`\n${green('wrote')} ${target}  ${dim(`(${out.queue.tasks.length} tasks)`)}`);
      }
      console.error(`review it, then ${bold('cq run')}`);
    });

  // ---------------------------------------------------------------- run
  program.command('run')
    .description('run the queue in the foreground until it is empty or parked')
    .option('--once', 'run a single task and exit')
    .option('--force', 'ignore a persisted park and start now')
    .option('--parallel <n>', 'run N tasks at once (default 1)',
      numberOption('--parallel', { min: 1, max: 32, integer: true }), 1)
    .option('--park-at <fraction>', 'park at this window utilization',
      numberOption('--park-at', { min: 0, max: 1 }), 0.92)
    .option('--allow-overage', 'keep going into billed overage')
    .addOption(new Option('--permission-mode <mode>',
      'permission mode passed to Claude Code (default bypassPermissions: no prompts)')
      .choices(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
      .default('bypassPermissions'))
    .option('--no-recommend', 'ignore follow-up tasks that workers recommend')
    .option('--task <id>', 'run only this task')
    .option('--timeout <minutes>', 'kill a task that runs longer than this',
      numberOption('--timeout', { min: 1, max: 1440 }), 60)
    .action(async (opts) => {
      const r = root();
      if (!new Queue(r).exists()) return die('no queue here. Run `cq init` first.');

      if (opts.parallel > 1) {
        console.error(yellow(`warning: --parallel ${opts.parallel} multiplies your burn rate by ${opts.parallel}`) +
          dim(`\n  N workers share one rate-limit window: they exhaust it ${opts.parallel}x sooner,\n` +
              '  so the queue does not finish sooner — it just parks sooner. Sequential is the default\n' +
              '  for a reason. Parallel is only worth it when tasks are I/O-bound, not token-bound.\n'));
      }

      const sched = new Scheduler(r, {
        bin: binName(),
        once: opts.once, force: opts.force,
        parallel: opts.parallel,
        parkAtUtilization: opts.parkAt,
        allowOverage: opts.allowOverage,
        timeoutMs: opts.timeout * 60_000,
        permissionMode: opts.permissionMode,
        ingestRecommended: opts.recommend !== false,
        onlyTask: opts.task ?? null,
      });

      for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
          console.error(dim(`\n${sig}: finishing the current task, then stopping…`));
          sched.stop();
        });
      }

      try {
        const outcome = await sched.run();
        if (outcome.reason === 'blocked' || outcome.reason === 'deps_unsatisfiable') process.exitCode = 2;
      } catch (err) {
        if (err.code === 'ELOCKED') return die(err.message);
        throw err;
      }
    });

  // ---------------------------------------------------------------- status
  program.command('status')
    .description('queue, rate-limit window, reset countdown, and spend')
    .option('--json', 'machine-readable output')
    .action((opts) => withQueue((q) => {
      const r = root();
      const data = q.read();
      const st = new Status(r).read();
      const now = Date.now();
      if (opts.json) return console.log(JSON.stringify({ queue: data, status: st }, null, 2));

      // --- window
      console.log(bold('\nwindow'));
      const windows = Object.entries(st.window ?? {});
      if (!windows.length) {
        console.log(dim('  no rate-limit data yet — run a task and it will appear here'));
      } else {
        console.log(table(windows.map(([name, w]) => {
          // Once the reset time has passed the window has refilled, so the utilization
          // we recorded is describing a window that no longer exists. Reporting it as
          // current -- or counting down to a reset that already happened -- is worse
          // than saying we don't know.
          const stale = !w.resets_at_ms || w.resets_at_ms <= now;
          if (stale) {
            const age = st.updated_at ? fmtDur(now - st.updated_at) : null;
            return ['  ' + name, dim('─'.repeat(20)), dim('—'),
              dim(age ? `refilled since the last run (${age} ago)` : 'no current reading')];
          }
          return [
            '  ' + name,
            bar(w.utilization),
            w.utilization != null ? `${(w.utilization * 100).toFixed(0)}% used` : dim('—'),
            dim('resets ') + `in ${countdown(w.resets_at_ms, now)}`,
          ];
        })));
      }
      if (st.is_using_overage) console.log('  ' + yellow('spending overage') + dim(` until ${countdown(st.overage_resets_at_ms, now)}`));

      // --- state
      const stateColour = { PARKED: yellow, RUNNING: cyan, IDLE: dim }[st.state] ?? ((s) => s);
      // "IDLE" on its own reads like something is wrong when there is queued work.
      // Say plainly that nothing is running, and what to type.
      const runnable = selectNext(data, { now });
      const idleNote = st.state === 'RUNNING' || st.park ? ''
        : runnable ? dim('  nothing running — start it with `cq run`')
        : dim('  nothing running');
      console.log(bold('\nstate    ') + stateColour(st.state ?? 'IDLE') +
        (st.current_task ? dim(`  running ${st.current_task}`) : idleNote));
      if (st.park) {
        console.log(`  ${yellow('parked')}: ${st.park.reason}`);
        const until = st.park.resets_at_ms ? st.park.resets_at_ms + 60_000 : null;
        console.log(dim(`  resumes ${!until ? 'in up to 15m (no reset time was reported)' : until > now ? `in ${countdown(until, now)}` : 'now'}` +
          (st.park.detected_by === 'exit_signature' ? '  (detected from the exit signature — a heuristic)' : '')));
      }
      if (st.reconciled?.length) {
        const last = st.reconciled.at(-1);
        console.log(dim(`  recovered ${last.tasks.join(', ')} from a previous process`));
      }

      // --- queue
      const counts = {};
      for (const t of data.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
      console.log(bold('\nqueue    ') +
        (Object.entries(counts).map(([k, v]) => `${STATUS_MARK[k] ?? ''} ${v} ${k}`).join(dim('  ·  ')) || dim('empty')));

      const rows = data.tasks.map((t) => {
        const spend = st.spend?.by_task?.[t.id];
        return [
          '  ' + (STATUS_MARK[t.status] ?? '?'),
          bold(t.id),
          truncate(t.title || t.prompt, 44),
          t.model && t.model !== data.defaults.model ? magenta(t.model) : dim(t.model ?? data.defaults.model),
          t.attempts ? (t.attempts >= MAX_ATTEMPTS ? red(`${t.attempts}/${MAX_ATTEMPTS}`) : dim(`${t.attempts}/${MAX_ATTEMPTS}`)) : dim('—'),
          spend ? usd(spend.usd) : dim('—'),
          t.depends_on?.length ? dim(`after ${t.depends_on.join(',')}`) : '',
        ];
      });
      if (rows.length) console.log('\n' + table(rows));

      const next = selectNext(data, { now });
      if (next && !st.park) console.log(dim(`\nnext: ${next.id} ${truncate(next.title, 50)}`));

      // --- spend
      const byWindow = Object.entries(st.spend?.by_window ?? {}).filter(([k]) => k !== 'unknown');
      console.log(bold('\nspend    ') + usd(st.spend?.total_usd ?? 0) + dim(' total'));
      if (byWindow.length) {
        console.log(table(byWindow.slice(-4).map(([k, w]) => ([
          '  ' + dim('window ending'), new Date(k).toLocaleString(),
          usd(w.usd), dim(`${w.runs} run${w.runs === 1 ? '' : 's'} · ${w.tasks.length} task${w.tasks.length === 1 ? '' : 's'}`),
        ]))));
      }
      const done = data.tasks.filter((t) => t.status === 'done');
      const spent = done.map((t) => st.spend?.by_task?.[t.id]?.usd).filter((n) => typeof n === 'number');
      if (spent.length > 1) {
        const avg = spent.reduce((a, b) => a + b, 0) / spent.length;
        const left = data.tasks.filter((t) => !TERMINAL_STATUSES.has(t.status)).length;
        console.log(dim(`  ${usd(avg)} average per finished task · ~${usd(avg * left)} to finish the remaining ${left}`));
      }

      const open = new Inbox(r).open();
      if (open.length) {
        console.log('\n' + magenta(`${open.length} decision${open.length === 1 ? '' : 's'} waiting`) +
          dim('  — run `cq inbox`'));
      }
      console.log('');
    }));

  // ---------------------------------------------------------------- inbox
  const inbox = program.command('inbox')
    .description('decisions workers could not make alone')
    .option('--all', 'include answered questions')
    .action((opts) => {
      const ib = new Inbox(root());
      const entries = opts.all ? ib.list() : ib.list().filter((e) => !e.answered);
      if (!entries.length) return console.log(dim('inbox is empty'));
      for (const e of entries) {
        const mark = e.answered ? green('✓') : magenta('?');
        console.log(`\n${mark} ${bold(`#${e.index}`)} ${dim(e.task_id)}  ${e.question}`);
        if (e.answer) console.log(dim(`    → ${e.answer.split('\n').join('\n      ')}`));
      }
      const open = entries.filter((e) => !e.answered).length;
      if (open) console.log(dim(`\nanswer with: cq inbox answer <n> "your answer"`));
      console.log('');
    });

  inbox.command('answer')
    .description('answer a decision, unblocking its task')
    .argument('<n>', 'entry number from `cq inbox`')
    .argument('[answer...]', 'your answer (or pipe it on stdin)')
    .action((n, words) => {
      const r = root();
      const ib = new Inbox(r);
      const answer = words.length ? words.join(' ') : readBrief('-');
      if (!answer.trim()) return die('an answer cannot be empty');
      let entry;
      try { entry = ib.answer(Number(n), answer.trim()); }
      catch (err) { return die(err.message); }

      console.log(`${green('✓')} #${entry.index} ${dim(entry.task_id)} ${entry.question}`);
      console.log(dim(`    → ${answer.trim()}`));

      const q = new Queue(r);
      if (q.exists() && ib.open(entry.task_id).length === 0) {
        const t = q.get(entry.task_id);
        if (t?.status === 'blocked') {
          q.setTask(entry.task_id, { status: 'queued', needs_human: [] });
          console.log(`${green('unblocked')} ${entry.task_id} — it will pick this answer up on its next run`);
        }
      } else if (q.exists()) {
        console.log(dim(`${entry.task_id} still has ${ib.open(entry.task_id).length} unanswered question(s)`));
      }
    });

  inbox.command('add')
    .description('add a question yourself')
    .argument('<task-id>')
    .argument('<question...>')
    .action((taskId, words) => {
      const added = new Inbox(root()).add(taskId, words.join(' '));
      console.log(added ? `${green('+')} ${taskId}` : dim('that question is already in the inbox'));
    });

  // ---------------------------------------------------------------- logs
  program.command('logs')
    .description("show a task's run history")
    .argument('<id>', 'task id')
    .option('--raw', 'print the raw jsonl stream')
    .option('-n, --lines <n>', 'events to show',
      numberOption('--lines', { min: 1, max: 100000, integer: true }), 40)
    .action((id, opts) => {
      const paths = cqPaths(root());
      const file = paths.taskLog(id);
      if (!existsSync(file)) return die(`no log for ${id} at ${file}`);
      const raw = readFileSync(file, 'utf8');
      if (opts.raw) return process.stdout.write(raw);

      const lines = raw.trim().split('\n');
      for (const line of lines.slice(-opts.lines)) {
        let e;
        try { e = JSON.parse(line); } catch { console.log(dim(`  (unparseable) ${truncate(line, 100)}`)); continue; }
        switch (e.type) {
          case 'cq_run_start':
            console.log(`\n${bold(cyan('▶ run'))} ${dim(e.at)}  ${e.model}  attempt ${e.attempt}` +
              (e.resume ? dim(`  resuming ${e.resume}`) : '') + dim(`  prompt ${e.prompt_chars} chars`));
            break;
          case 'system':
            if (e.subtype === 'init') console.log(dim(`  session ${e.session_id}  cli ${e.claude_code_version}`));
            break;
          case 'assistant':
            for (const b of e.message?.content ?? []) {
              if (b.type === 'text' && b.text.trim()) console.log(`  ${truncate(b.text, 140)}`);
              if (b.type === 'tool_use') console.log(dim(`  · ${b.name} ${truncate(JSON.stringify(b.input ?? {}), 80)}`));
            }
            break;
          case 'rate_limit_event': {
            const i = e.rate_limit_info ?? {};
            const col = i.status === 'rejected' ? red : i.status === 'allowed_warning' ? yellow : dim;
            console.log(col(`  ⚡ ${i.status} ${i.rateLimitType ?? ''}` +
              (i.unifiedWindows?.five_hour ? ` 5h@${(i.unifiedWindows.five_hour.utilization * 100).toFixed(0)}%` : '')));
            break;
          }
          case 'result': {
            const col = e.is_error ? red : green;
            console.log(col(`  ${e.is_error ? '✗' : '✓'} ${e.subtype}`) +
              dim(`  ${e.num_turns} turns  ${usd(e.total_cost_usd)}  ${fmtDur(e.duration_ms)}`));
            break;
          }
        }
      }
      const err = paths.taskErr(id);
      if (existsSync(err)) {
        const tail = readFileSync(err, 'utf8').trim();
        if (tail) console.log(`\n${red('stderr')}\n${dim(tail.split('\n').slice(-15).join('\n'))}`);
      }
      console.log(dim(`\nfull stream: ${file}`));
    });

  // ---------------------------------------------------------------- doctor
  program.command('doctor')
    .description('check the CLI, its flags, and this queue')
    .action(() => {
      const r = root();
      const caps = probeCapabilities(binName());
      const ok = (b) => (b ? green('✓') : red('✗'));
      console.log(`${ok(Boolean(caps.version))} claude CLI      ${caps.version ?? red('not found on PATH')}`);
      console.log(`${ok(caps.max_turns)} --max-turns     ${caps.max_turns ? dim('accepted (undocumented in --help)') : yellow('not accepted — cq will rely on --max-budget-usd')}`);
      console.log(`${ok(caps.max_budget_usd)} --max-budget-usd ${caps.max_budget_usd ? dim('accepted') : yellow('not accepted')}`);
      const q = new Queue(r);
      if (!q.exists()) return console.log(`${yellow('!')} no queue here — run ${bold('cq init')}`);
      try {
        const data = q.read();
        console.log(`${green('✓')} queue           ${data.tasks.length} task(s), valid`);
      } catch (err) { console.log(`${red('✗')} queue           ${err.message}`); process.exitCode = 1; }
      const paths = cqPaths(r);
      if (existsSync(paths.lock)) {
        console.log(`${yellow('!')} lock            held: ${readFileSync(paths.lock, 'utf8').trim()}`);
      }
      new Status(r).write({ ...new Status(r).read(), caps });
    });

  // ---------------------------------------------------------------- daemon
  const d = program.command('daemon').description('run the queue in the background (launchd on macOS)');

  d.command('install').description('write the launchd agent for this repo')
    .action(() => onDarwin(() => {
      const r = daemon.install(root(), { cliPath: CLI_PATH });
      console.log(`${green('wrote')} ${r.path}`);
      console.log(dim(`logs: ${r.logs}/${r.label}.{out,err}.log`));
      console.log(`next: ${bold('cq daemon start')}`);
    }));

  d.command('start').description('load and start the agent')
    .action(() => onDarwin(() => {
      try {
        const r = daemon.start(root());
        console.log(`${green('started')} ${r.label}`);
      } catch (err) { die(err.message); }
    }));

  d.command('stop').description('stop the agent')
    .action(() => onDarwin(() => {
      try {
        const r = daemon.stop(root());
        console.log(r.wasRunning ? `${green('stopped')} ${r.label}` : dim(`${r.label} was not running`));
      } catch (err) { die(err.message); }
    }));

  d.command('uninstall').description('stop the agent and remove its plist')
    .action(() => onDarwin(() => {
      const r = daemon.uninstall(root());
      console.log(r.removed ? `${green('removed')} ${r.removed}` : dim('nothing installed'));
    }));

  d.command('status').description('is the agent installed and running?')
    .action(() => onDarwin(() => {
      const s = daemon.status(root());
      console.log(`${s.installed ? green('✓') : dim('·')} installed  ${dim(s.plist)}`);
      console.log(`${s.loaded ? green('✓') : dim('·')} loaded     ${s.pid ? `pid ${s.pid}` : dim('not running')}` +
        (s.lastExit && s.lastExit !== '0' ? yellow(`  last exit ${s.lastExit}`) : ''));
      const tail = daemon.tailLog(s.logOut, 15);
      if (tail.trim()) console.log(`\n${dim('recent output')}\n${tail}`);
      const err = daemon.tailLog(s.logErr, 10);
      if (err.trim()) console.log(`\n${red('recent errors')}\n${dim(err)}`);
    }));

  return program;
}

// ---------------------------------------------------------------- helpers

function binName() { return process.env.CQ_CLAUDE_BIN ?? 'claude'; }

/**
 * Parse a numeric option, or exit.
 *
 * `Number('foo')` is NaN, and NaN is falsy — so an unvalidated `--timeout foo` did not
 * fail loudly, it silently removed the wall-clock timeout. Same shape of bug for
 * --park-at (the soft park never fires) and --parallel.
 */
function numberOption(name, { min = -Infinity, max = Infinity, integer = false } = {}) {
  return (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new InvalidArgumentError(`${name} must be a number (got "${raw}")`);
    if (integer && !Number.isInteger(n)) throw new InvalidArgumentError(`${name} must be a whole number (got "${raw}")`);
    if (n < min || n > max) throw new InvalidArgumentError(`${name} must be between ${min} and ${max} (got ${n})`);
    return n;
  };
}

function withQueue(fn) {
  try { return fn(new Queue(root())); }
  catch (err) {
    if (err.code === 'ENOQUEUE' || err.code === 'EBADQUEUE') return die(err.message);
    throw err;
  }
}

function onDarwin(fn) {
  if (process.platform === 'darwin') return fn();
  console.error(yellow(`cq daemon uses launchd, which is macOS-only. On ${process.platform}, use this systemd unit:\n`));
  console.log(daemon.systemdUnit(root(), { cliPath: CLI_PATH }));
}

function printPlan(queue) {
  console.log(bold(`\n${queue.tasks.length} tasks`) + dim(`  (defaults: ${queue.defaults.model}, ${queue.defaults.max_turns} turns)\n`));
  console.log(table(queue.tasks.map((t) => ([
    '  ' + bold(t.id),
    truncate(t.title || t.prompt, 52),
    t.model ? magenta(t.model) : dim('—'),
    t.depends_on.length ? dim(`after ${t.depends_on.join(',')}`) : '',
    t.context_files.length ? dim(`${t.context_files.length} file(s)`) : dim('no context'),
  ]))));
}
