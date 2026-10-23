import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { StreamParser } from '../runner/stream.js';
import { makeTask, validateQueue, DEFAULT_DEFAULTS } from '../queue/index.js';

/**
 * The planning prompt.
 *
 * Every rule here exists because the corresponding shape burns a rate-limit window
 * without buying quality. The planner's job is to rewrite an ambitious free-form brief
 * into something a queue of small, fresh sessions can actually finish.
 */
export const PLAN_RULES = `You are decomposing a large software brief into a queue of tasks for \`cq\`, a
supervisor that runs **one task per fresh \`claude -p\` session**. Each session starts
with no memory of the others and hands off only through files, git, and the task list.

Return ONLY a JSON object, no prose, no markdown fence, matching exactly:

{"defaults":{"model":"sonnet","max_turns":40},
 "tasks":[{"id":"t-001","title":"","prompt":"","context_files":[],"depends_on":[],
           "priority":2,"model":null,"max_turns":null}]}

Rules — follow all of them:

1. **Size.** Every task must be completable in <= 40 turns by an agent starting cold.
   If a task needs more, split it. A task is roughly "one coherent commit".
2. **Context.** Every task names the specific \`context_files\` it needs. Never list a
   whole directory. If a file will not exist until an earlier task creates it, list it
   anyway and add that task to \`depends_on\`.
3. **Self-contained prompts.** Write each \`prompt\` as if the reader has seen nothing
   else — no "as discussed above", no "continue from task 2". Restate what is needed.
4. **No parallel waves.** A brief that says "run these agents in parallel" becomes a
   sequential \`depends_on\` chain. Parallelism multiplies the burn rate against one
   shared rate-limit window; it does not multiply throughput.
5. **One review round, not four.** A brief asking for repeated critic rounds until a
   score passes becomes exactly ONE review task with \`depends_on\` on the work it
   reviews. Set \`"model":"opus"\` on a review task if judgement genuinely needs it.
   Never emit a scoring loop, a rating round, or a screenshot-and-critique cycle.
6. **No "loop until it passes".** That is the supervisor's job: it requeues a task with
   the reviewer's issue list. Emit the single review task and stop.
7. **Architecture first.** If the brief involves a new system, the first task writes the
   design document, and everything else depends on it.
8. **Verification early.** If the brief needs a test harness, screenshot tool, or any
   way to check the work, that task comes before the work it verifies.
9. **Ordering.** \`priority\` 1 = do first, 3 = do last. Ids are \`t-001\` upward, in
   dependency order. \`depends_on\` may only reference earlier ids.
10. **Model.** Leave \`"model":null\` (the queue default, Sonnet) unless a task genuinely
    needs Opus-level judgement — typically only a design or review task.

Aim for 8-25 tasks. Fewer, larger tasks beat many trivial ones: each task pays a fresh
session's startup cost.`;

/** Build the single planning prompt. One call, no tools, one turn. */
export function buildPlanPrompt(brief) {
  return `${PLAN_RULES}\n\n---\n\n# The brief to decompose\n\n${brief.trim()}\n\n---\n\nReturn only the JSON object.`;
}

/**
 * Pull the task JSON out of a model response, tolerating a markdown fence or stray
 * prose despite the instruction not to emit any.
 */
export function extractPlan(text) {
  const candidates = [];
  for (const m of (text ?? '').matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  candidates.push(text ?? '');
  // Also try the outermost brace span, for a response wrapped in prose.
  const first = (text ?? '').indexOf('{');
  const last = (text ?? '').lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    let parsed;
    try { parsed = JSON.parse(c.trim()); } catch { continue; }
    if (parsed && Array.isArray(parsed.tasks)) return parsed;
  }
  return null;
}

/**
 * Normalise a planner response into a valid queue.
 *
 * The planner is a language model, so this repairs what it can rather than rejecting a
 * near-miss: renumbering ids, dropping dangling and self dependencies, clamping
 * max_turns. Everything repaired is reported, so the user sees what was changed.
 */
export function normalizePlan(plan, { maxTurnsCap = 40 } = {}) {
  const notes = [];
  const defaults = { ...DEFAULT_DEFAULTS, ...(plan.defaults ?? {}) };
  if (defaults.max_turns > maxTurnsCap) {
    notes.push(`clamped defaults.max_turns ${defaults.max_turns} -> ${maxTurnsCap}`);
    defaults.max_turns = maxTurnsCap;
  }

  const raw = plan.tasks.filter((t) => t && typeof t.prompt === 'string' && t.prompt.trim());
  if (raw.length !== plan.tasks.length) {
    notes.push(`dropped ${plan.tasks.length - raw.length} task(s) with no prompt`);
  }

  // Renumber to a dense t-NNN sequence, remapping depends_on through the old ids.
  const idMap = new Map();
  raw.forEach((t, i) => idMap.set(t.id ?? `__${i}`, `t-${String(i + 1).padStart(3, '0')}`));

  const tasks = raw.map((t, i) => {
    const id = idMap.get(t.id ?? `__${i}`);
    const deps = [];
    for (const d of t.depends_on ?? []) {
      const mapped = idMap.get(d);
      if (!mapped) { notes.push(`${id}: dropped dependency on unknown "${d}"`); continue; }
      if (mapped === id) { notes.push(`${id}: dropped a self-dependency`); continue; }
      // Only backward references, which also makes cycles impossible by construction.
      if (Number(mapped.slice(2)) >= i + 1) {
        notes.push(`${id}: dropped forward dependency on ${mapped}`);
        continue;
      }
      deps.push(mapped);
    }
    let maxTurns = t.max_turns ?? null;
    if (maxTurns && maxTurns > maxTurnsCap) {
      notes.push(`${id}: clamped max_turns ${maxTurns} -> ${maxTurnsCap}`);
      maxTurns = maxTurnsCap;
    }
    const model = t.model === 'opus' || t.model === 'sonnet' || t.model === 'fable' ? t.model : null;
    if (t.model && !model) notes.push(`${id}: ignored unknown model "${t.model}"`);

    return makeTask({
      id,
      title: String(t.title ?? '').slice(0, 200),
      prompt: String(t.prompt).trim(),
      context_files: (Array.isArray(t.context_files) ? t.context_files : []).map(String),
      depends_on: deps,
      priority: Number.isFinite(t.priority) ? Math.min(5, Math.max(1, Math.round(t.priority))) : 2,
      model,
      max_turns: maxTurns,
    });
  });

  const queue = { version: 1, defaults, tasks };
  const errors = validateQueue(queue);
  if (errors.length) {
    const e = new Error(`the planner produced an invalid queue:\n  - ${errors.join('\n  - ')}`);
    e.errors = errors;
    throw e;
  }
  const opus = tasks.filter((t) => t.model === 'opus').length;
  if (opus > 2) notes.push(`${opus} tasks request Opus; consider whether they all need it`);
  return { queue, notes };
}

/**
 * Run the planner: one Opus call, one turn, no tools.
 *
 * `--max-turns 1` plus `--tools ""` is what keeps this to a single, bounded call: the
 * planner must not go exploring the repo, which is where a "cheap" planning step turns
 * into a fifth of a rate-limit window.
 */
export async function runPlan(brief, {
  bin = 'claude', model = 'opus', cwd = process.cwd(), env = process.env,
  timeoutMs = 10 * 60 * 1000, caps = {}, onStderr = null,
} = {}) {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--model', model, '--tools', ''];
  if (caps.max_turns !== false) args.push('--max-turns', '1');
  args.push(buildPlanPrompt(brief));

  const parser = new StreamParser();
  const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stdout.on('data', (c) => parser.push(c));
  child.stderr.on('data', (c) => { stderr += c; onStderr?.(c); });

  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  const code = await new Promise((res) => {
    child.on('error', () => res(-1));
    child.on('close', (c) => res(c));
  });
  clearTimeout(timer);
  const summary = parser.end();

  if (code !== 0 && !summary.final_text) {
    throw new Error(`planner exited ${code}${stderr ? `: ${stderr.trim().slice(-800)}` : ''}`);
  }
  const plan = extractPlan(summary.final_text);
  if (!plan) {
    throw new Error(`the planner did not return a task list.\nIts reply began:\n${(summary.final_text || '(empty)').slice(0, 800)}`);
  }
  return { ...normalizePlan(plan), cost_usd: summary.cost_usd, raw: summary.final_text };
}

export function readBrief(fileOrNull) {
  if (fileOrNull && fileOrNull !== '-') return readFileSync(fileOrNull, 'utf8');
  return readFileSync(0, 'utf8');   // stdin
}
