import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { writeJsonAtomic } from '../util/atomic.js';
import { cqPaths } from '../util/paths.js';

export const TASK_STATUSES = ['queued', 'running', 'parked', 'blocked', 'done', 'failed'];
export const TERMINAL_STATUSES = new Set(['done', 'failed']);
export const MAX_ATTEMPTS = 3;

export const DEFAULT_DEFAULTS = { model: 'sonnet', max_turns: 40 };

/** A fresh task with every field present, so the file is self-documenting when hand-edited. */
export function makeTask(partial = {}) {
  return {
    id: partial.id ?? 't-001',
    title: partial.title ?? '',
    prompt: partial.prompt ?? '',
    context_files: partial.context_files ?? [],
    depends_on: partial.depends_on ?? [],
    priority: partial.priority ?? 2,
    model: partial.model ?? null,
    max_turns: partial.max_turns ?? null,
    status: partial.status ?? 'queued',
    attempts: partial.attempts ?? 0,
    session_id: partial.session_id ?? null,
    result_summary: partial.result_summary ?? null,
    needs_human: partial.needs_human ?? [],
    ...partial,
  };
}

export function emptyQueue() {
  return { version: 1, defaults: { ...DEFAULT_DEFAULTS }, tasks: [] };
}

/**
 * Validate a hand-editable queue file.
 *
 * Errors are phrased to point a human at the thing they typed wrong, because this file
 * is documented as hand-editable and a schema library's message ("must match anyOf")
 * would not do that. Returns a list rather than throwing on the first problem, so one
 * pass reports every typo.
 */
export function validateQueue(data) {
  const errors = [];
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return ['tasks.json must be a JSON object'];
  }
  if (data.version !== 1) errors.push(`version must be 1 (found ${JSON.stringify(data.version)})`);
  if (!Array.isArray(data.tasks)) return [...errors, 'tasks must be an array'];

  const seen = new Set();
  const ids = new Set(data.tasks.map((t) => t && t.id));
  data.tasks.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (t === null || typeof t !== 'object') { errors.push(`${at} must be an object`); return; }
    if (typeof t.id !== 'string' || !t.id) errors.push(`${at}.id must be a non-empty string`);
    else if (seen.has(t.id)) errors.push(`${at}.id "${t.id}" is a duplicate`);
    else seen.add(t.id);

    if (typeof t.prompt !== 'string' || !t.prompt.trim()) {
      errors.push(`${at} (${t.id ?? '?'}) needs a non-empty prompt`);
    }
    if (t.status !== undefined && !TASK_STATUSES.includes(t.status)) {
      errors.push(`${at} (${t.id}) has status "${t.status}"; must be one of ${TASK_STATUSES.join(', ')}`);
    }
    for (const dep of t.depends_on ?? []) {
      if (!ids.has(dep)) errors.push(`${at} (${t.id}) depends_on "${dep}", which is not a task id`);
    }
    if (t.context_files !== undefined && !Array.isArray(t.context_files)) {
      errors.push(`${at} (${t.id}).context_files must be an array of paths`);
    }
  });

  for (const cycle of findCycles(data.tasks)) {
    errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }
  return errors;
}

/** Depth-first cycle detection over depends_on. Returns each cycle once, as a path. */
export function findCycles(tasks) {
  const byId = new Map(tasks.filter((t) => t && t.id).map((t) => [t.id, t]));
  const state = new Map();   // id -> 'visiting' | 'done'
  const cycles = [];
  const stack = [];

  const visit = (id) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.depends_on ?? []) if (byId.has(dep)) visit(dep);
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of byId.keys()) visit(id);
  return cycles;
}

/**
 * The queue file. Every mutation re-reads from disk, applies, and writes atomically,
 * so a hand-edit between two cq operations is picked up rather than clobbered by a
 * stale in-memory copy.
 */
export class Queue {
  constructor(root) {
    this.paths = cqPaths(root);
  }

  exists() { return existsSync(this.paths.tasks); }

  init() {
    mkdirSync(this.paths.logs, { recursive: true });
    if (!this.exists()) writeJsonAtomic(this.paths.tasks, emptyQueue());
    return this.read();
  }

  read() {
    if (!existsSync(this.paths.tasks)) {
      const e = new Error(`no queue at ${this.paths.tasks}. Run \`cq init\` first.`);
      e.code = 'ENOQUEUE';
      throw e;
    }
    let data;
    const raw = readFileSync(this.paths.tasks, 'utf8');
    try { data = JSON.parse(raw); }
    catch (err) {
      const e = new Error(`${this.paths.tasks} is not valid JSON: ${err.message}`);
      e.code = 'EBADQUEUE';
      throw e;
    }
    const errors = validateQueue(data);
    if (errors.length) {
      const e = new Error(`${this.paths.tasks} is invalid:\n  - ${errors.join('\n  - ')}`);
      e.code = 'EBADQUEUE';
      e.errors = errors;
      throw e;
    }
    data.defaults = { ...DEFAULT_DEFAULTS, ...(data.defaults ?? {}) };
    data.tasks = data.tasks.map((t) => makeTask(t));
    return data;
  }

  write(data) {
    const errors = validateQueue(data);
    if (errors.length) throw new Error(`refusing to write an invalid queue:\n  - ${errors.join('\n  - ')}`);
    writeJsonAtomic(this.paths.tasks, data);
    return data;
  }

  /** Read, mutate, write. The only sanctioned way to change the queue. */
  update(fn) {
    const data = this.read();
    const result = fn(data);
    this.write(data);
    return result;
  }

  addTask(partial) {
    return this.update((data) => {
      const task = makeTask({ ...partial, id: partial.id ?? nextId(data.tasks) });
      data.tasks.push(task);
      return task;
    });
  }

  get(id) { return this.read().tasks.find((t) => t.id === id) ?? null; }

  setTask(id, patch) {
    return this.update((data) => {
      const t = data.tasks.find((x) => x.id === id);
      if (!t) throw new Error(`no such task: ${id}`);
      Object.assign(t, patch);
      return t;
    });
  }
}

/** Next free `t-NNN`, based on the highest existing number rather than the count. */
export function nextId(tasks) {
  let max = 0;
  for (const t of tasks) {
    const m = /^t-(\d+)$/.exec(t.id ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `t-${String(max + 1).padStart(3, '0')}`;
}

/** True when every dependency exists and is `done`. */
export function depsSatisfied(task, byId) {
  return (task.depends_on ?? []).every((d) => byId.get(d)?.status === 'done');
}

/**
 * Pick the next runnable task.
 *
 * `parked` outranks `queued`: a parked task is mid-flight with a live session, and
 * finishing it is cheaper (it resumes) than starting fresh work alongside it.
 * Within a status, lowest `priority` wins, then declaration order -- stable, so a
 * human reading tasks.json can predict what runs next.
 */
export function selectNext(data, { now = Date.now() } = {}) {
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const eligible = data.tasks.filter((t) =>
    (t.status === 'parked' || t.status === 'queued') &&
    t.attempts < MAX_ATTEMPTS &&
    depsSatisfied(t, byId) &&
    !(t.retry_after_ms && t.retry_after_ms > now));

  if (!eligible.length) return null;
  const rank = (t) => (t.status === 'parked' ? 0 : 1);
  return eligible
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || (a.t.priority ?? 2) - (b.t.priority ?? 2) || a.i - b.i)
    [0].t;
}

/**
 * Why the queue is not running, when selectNext returns null. The distinction matters:
 * "waiting on a backoff timer" must not end the daemon, but "everything is done or
 * blocked" must.
 */
export function queueStall(data, { now = Date.now() } = {}) {
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const live = data.tasks.filter((t) => !TERMINAL_STATUSES.has(t.status));
  if (!live.length) return { kind: 'empty', until: null };

  const waiting = live
    .filter((t) => t.retry_after_ms && t.retry_after_ms > now && t.attempts < MAX_ATTEMPTS)
    .map((t) => t.retry_after_ms);
  if (waiting.length) return { kind: 'backoff', until: Math.min(...waiting) };

  const blocked = live.filter((t) => t.status === 'blocked');
  const unsatisfiable = live.filter((t) => !depsSatisfied(t, byId));
  if (blocked.length) return { kind: 'blocked', tasks: blocked.map((t) => t.id), until: null };
  if (unsatisfiable.length) {
    return { kind: 'deps_unsatisfiable', tasks: unsatisfiable.map((t) => t.id), until: null };
  }
  return { kind: 'exhausted', tasks: live.map((t) => t.id), until: null };
}

/**
 * Mark tasks that depend on a failed task as blocked. Running a task whose
 * precondition failed spends usage to produce a second failure.
 */
export function blockDependents(data, failedId, reason) {
  const failed = new Set([failedId]);
  const blocked = [];
  let changed = true;
  while (changed) {                       // transitive: a blocks b blocks c
    changed = false;
    for (const t of data.tasks) {
      if (TERMINAL_STATUSES.has(t.status) || t.status === 'blocked') continue;
      if ((t.depends_on ?? []).some((d) => failed.has(d))) {
        t.status = 'blocked';
        t.needs_human = [...(t.needs_human ?? []), reason];
        failed.add(t.id);
        blocked.push(t.id);
        changed = true;
      }
    }
  }
  return blocked;
}
