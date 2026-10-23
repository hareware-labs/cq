import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Queue, selectNext, queueStall, blockDependents, MAX_ATTEMPTS, makeTask, nextId } from '../queue/index.js';
import { runTask, cachedCapabilities } from '../runner/index.js';
import { classify, napFor, backoffMs, STATES, RESET_GRACE_MS } from '../limits/index.js';
import { Inbox, extractNeedsHuman } from '../inbox/index.js';
import { Status, windowKeyFor } from './status.js';
import { makeNotifier } from '../notify/index.js';
import { acquireLock } from '../util/lock.js';
import { cqPaths } from '../util/paths.js';

/** A recommendation may not itself recommend: one level of fan-out, then stop. */
export const MAX_RECOMMEND_DEPTH = 1;
/** Width cap on a single worker's suggestions. */
export const MAX_RECOMMENDED_PER_TASK = 5;

/**
 * The supervisor loop.
 *
 * Invariants:
 *  - A task-level failure never escapes this loop. `runTask` does not throw for task
 *    problems, and anything that does throw is caught and recorded against the task.
 *  - Every state transition is persisted before the loop sleeps, so a daemon restart
 *    resumes mid-window rather than re-deciding from scratch.
 *  - The queue is re-read before every task, so a hand-edit between tasks takes effect.
 */
export class Scheduler {
  constructor(root, opts = {}) {
    this.root = root;
    this.paths = cqPaths(root);
    this.queue = new Queue(root);
    this.inbox = new Inbox(root);
    this.status = new Status(root);
    this.opts = {
      bin: 'claude',
      parallel: 1,
      maxIterations: Infinity,
      parkAtUtilization: 0.92,
      allowOverage: false,
      once: false,
      force: false,          // ignore a persisted park and start now
      onlyTask: null,        // restrict the queue to a single task id
      sleep: defaultSleep,
      now: () => Date.now(),
      log: (...a) => console.log(...a),
      notify: makeNotifier(),
      runTask,
      probe: cachedCapabilities,
      timeoutMs: 60 * 60 * 1000,
      permissionMode: 'bypassPermissions',
      ingestRecommended: true,
      ...opts,
    };
    this.stopped = false;
    this.iterations = 0;
    /** One controller per in-flight run, so `stop()` reaches all of them. */
    this.aborts = new Set();
  }

  stop() {
    this.stopped = true;
    for (const a of this.aborts) a.abort();
  }

  /** Detect whether the target repo carries the protocol, so it need not be re-sent. */
  #protocolInRepo() {
    const md = join(this.root, 'CLAUDE.md');
    if (!existsSync(md)) return false;
    try { return /cq worker protocol|Running under cq/i.test(readFileSync(md, 'utf8')); }
    catch { return false; }
  }

  /**
   * Move tasks a crashed daemon left in `running` back to `queued`.
   *
   * The `session_id` is kept, so the retry resumes the half-finished session rather
   * than paying to redo the work. `attempts` is NOT incremented: the process died,
   * which is the supervisor's fault, not the task's, and charging it an attempt would
   * retire a healthy task after three unrelated crashes.
   */
  reconcile() {
    const stuck = [];
    this.queue.update((data) => {
      for (const t of data.tasks) {
        if (t.status === 'running') {
          t.status = t.session_id ? 'parked' : 'queued';
          t.reconciled_at = this.opts.now();
          stuck.push(t.id);
        }
      }
    });
    if (stuck.length) {
      this.status.update((s) => {
        s.reconciled = [...(s.reconciled ?? []).slice(-20),
          { at: this.opts.now(), tasks: stuck, note: 'left running by a previous process' }];
      });
      this.opts.log(`reconciled ${stuck.length} task(s) left running by a previous process: ${stuck.join(', ')}`);
    }
    return stuck;
  }

  /** Unblock tasks whose inbox questions have all been answered. */
  applyInboxAnswers() {
    const unblocked = [];
    this.queue.update((data) => {
      for (const t of data.tasks) {
        if (t.status !== 'blocked') continue;
        const open = this.inbox.open(t.id);
        const answered = this.inbox.answersFor(t.id);
        if (open.length === 0 && answered.length > 0) {
          t.status = 'queued';
          t.needs_human = [];
          unblocked.push(t.id);
        }
      }
    });
    for (const id of unblocked) this.opts.log(`unblocked ${id}: its inbox questions are answered`);
    return unblocked;
  }

  async run() {
    const lock = acquireLock(this.paths.lock, { now: this.opts.now() });
    if (lock.broke) this.opts.log(`broke a stale lock (${lock.broke.reason})`);
    try {
      return await this.#loop();
    } finally {
      lock.release();
      // Leaving `current_task` set after the loop exits makes `cq status` claim a task
      // is running when nothing is.
      this.status.update((s) => {
        if (s.state === STATES.RUNNING) { s.state = STATES.IDLE; s.current_task = null; }
      });
    }
  }

  async #loop() {
    this.queue.init();
    this.inbox.init();

    // Cached across runs: the probe is free of usage but not of startup time.
    const caps = this.opts.caps ?? this.opts.probe(this.opts.bin, this.status.read().caps);
    this.status.update((s) => { s.caps = caps; });
    if (caps.max_turns === false) {
      this.opts.log('note: this CLI does not accept --max-turns; falling back to --max-budget-usd only');
    }

    this.reconcile();

    // A persisted park survives a restart: resume the sleep rather than firing a run
    // straight into a closed window.
    let park = this.opts.force ? null : this.status.read().park;
    if (this.opts.force && this.status.read().park) this.opts.log('--force: ignoring the persisted park');

    let finishThenPark = false;
    /** id -> a promise resolving to that run's outcome. Size 1 unless --parallel. */
    const inFlight = new Map();

    /** Pick the next task, honouring --task scoping. Returns null when none is ready. */
    const pick = () => {
      const data = this.queue.read();
      // `--task <id>` narrows the queue rather than bypassing selection, so
      // dependencies, attempt caps and backoff still apply to it.
      const scoped = this.opts.onlyTask
        ? { ...data, tasks: data.tasks.map((t) => (t.id === this.opts.onlyTask ? t : { ...t, status: 'done' })) }
        : data;
      return { task: selectNext(scoped, { now: this.opts.now() }), scoped };
    };

    if (this.opts.onlyTask && !this.queue.read().tasks.some((t) => t.id === this.opts.onlyTask)) {
      this.opts.log(`no such task: ${this.opts.onlyTask}`);
      return { reason: 'no_such_task' };
    }

    while (!this.stopped && this.iterations < this.opts.maxIterations) {
      this.iterations++;

      if (park) {
        // In-flight work is never abandoned to a park: those tasks are already paid for.
        if (inFlight.size) { await this.#drain(inFlight); continue; }
        this.#persistPark(park);
        const done = await this.#sleepUntilReset(park);
        if (!done) continue;                       // woke early; nap again
        park = null;
        this.status.setState(STATES.RUNNING, { park: null });
        this.opts.log('window reset; resuming');
      }

      this.applyInboxAnswers();

      // Fill the pool. `#runOne` marks a task `running` synchronously before its first
      // await, so the next pick cannot select it again.
      let scoped = null;
      while (!finishThenPark && !this.stopped && inFlight.size < Math.max(1, this.opts.parallel)) {
        const picked = pick();
        scoped = picked.scoped;
        if (!picked.task) break;
        const id = picked.task.id;
        inFlight.set(id, this.#runOne(picked.task, caps).then((r) => ({ id, ...r })));
        if (this.opts.once) break;
      }

      if (!inFlight.size) {
        const stall = queueStall(scoped ?? pick().scoped, { now: this.opts.now() });
        if (stall.kind === 'backoff') {
          const ms = Math.max(1000, stall.until - this.opts.now());
          this.opts.log(`waiting ${fmtDur(ms)} for a retry backoff`);
          this.status.setState(STATES.IDLE, { current_task: null });
          await this.opts.sleep(ms);
          continue;
        }
        this.status.setState(STATES.IDLE, { current_task: null });
        this.opts.log(stallMessage(stall));
        return { reason: stall.kind, stall };
      }

      // Take whichever finishes first, so a slow task does not stall the pool.
      const result = await Promise.race(inFlight.values());
      inFlight.delete(result.id);

      if (result.park) { park = result.park; this.#persistPark(park); }
      if (result.finishThenPark) finishThenPark = result.finishThenPark;

      if (finishThenPark && !park) {
        // A warning arrived. Let everything already running land, then park.
        if (inFlight.size) continue;
        this.opts.log(`parking before starting the next task: ${finishThenPark.reason}`);
        park = finishThenPark;
        this.#persistPark(park);
        finishThenPark = false;
      }

      if (this.opts.once) {
        const rest = await this.#drain(inFlight);
        if (rest.park) this.#persistPark(rest.park);
        return { reason: 'once', task: result.id, disposition: result.disposition };
      }
    }

    const rest = await this.#drain(inFlight);
    if (rest.park) this.#persistPark(rest.park);
    return { reason: this.stopped ? 'stopped' : 'max_iterations' };
  }

  /** Run one task and apply its outcome to the queue. Never throws. */
  async #runOne(task, caps) {
    const data = this.queue.read();
    const model = task.model ?? data.defaults.model ?? 'sonnet';
    const maxTurns = task.max_turns ?? data.defaults.max_turns ?? 40;
    const resume = task.status === 'parked' ? task.session_id : null;
    const answers = this.inbox.answersFor(task.id).map((e) => ({ question: e.question, answer: e.answer }));

    this.queue.setTask(task.id, { status: 'running', attempts: task.attempts + 1, started_at: this.opts.now() });
    this.status.setState(STATES.RUNNING, { current_task: task.id });
    this.opts.log(`> ${task.id} ${task.title || ''} (${model}, attempt ${task.attempts + 1}/${MAX_ATTEMPTS}${resume ? ', resuming' : ''})`);

    const abort = new AbortController();
    this.aborts.add(abort);
    let outcome;
    try {
      outcome = await this.opts.runTask(task, {
        root: this.root, bin: this.opts.bin, model, maxTurns, resume,
        handoff: task.handoff ?? null, inboxAnswers: answers,
        includeProtocol: !this.#protocolInRepo(), caps,
        permissionMode: this.opts.permissionMode, timeoutMs: this.opts.timeoutMs,
        signal: abort.signal,
      });
    } catch (err) {
      // A bug in the runner is still only a task failure. The daemon keeps going.
      outcome = {
        task_id: task.id, disposition: 'failed', exit_code: null, session_id: task.session_id,
        cost_usd: null, num_turns: null, duration_ms: 0, final_text: '',
        stderr_tail: `cq internal error: ${err?.stack ?? err}`, rate_limit: null,
        limit_decision: null, error: String(err?.message ?? err),
      };
    }

    this.aborts.delete(abort);
    const windowKey = windowKeyFor(outcome.rate_limit);
    this.status.recordSpend(task.id, outcome, windowKey);
    this.status.recordWindow(outcome.rate_limit);

    return this.#apply(task, outcome, { model, maxTurns });
  }

  /** Translate a run outcome into queue mutations. One place, one switch. */
  #apply(task, outcome, { maxTurns }) {
    const cost = outcome.cost_usd != null ? ` $${outcome.cost_usd.toFixed(4)}` : '';
    const turns = outcome.num_turns != null ? ` ${outcome.num_turns} turns` : '';
    const base = { session_id: outcome.session_id ?? task.session_id, last_disposition: outcome.disposition };

    switch (outcome.disposition) {
      case 'success': {
        const questions = extractNeedsHuman(outcome.final_text);
        for (const q of questions) this.inbox.add(task.id, q);
        const openQ = this.inbox.open(task.id);
        const ingested = this.#ingestRecommended(outcome.final_text, task.id);

        // A worker that escalated a decision but still finished is `done`, not blocked:
        // it said the rest could proceed. The question stays in the inbox for the human.
        this.queue.setTask(task.id, {
          ...base, status: 'done', result_summary: trim(outcome.final_text, 4000),
          needs_human: openQ.map((e) => e.question), handoff: null, retry_after_ms: null,
          finished_at: this.opts.now(),
        });
        this.opts.log(`  done${cost}${turns}` +
          (openQ.length ? ` — ${openQ.length} question(s) in the inbox` : '') +
          (ingested ? ` — ingested ${ingested} recommended task(s)` : ''));
        break;
      }

      case 'rate_limited': {
        const decision = outcome.limit_decision
          ?? classify(outcome.rate_limit, { parkAtUtilization: this.opts.parkAtUtilization, allowOverage: this.opts.allowOverage });
        // The task is incomplete but has a live session: park it, keep the id, and do
        // not charge it an attempt -- it was interrupted, it did not fail.
        this.queue.setTask(task.id, {
          ...base, status: 'parked', attempts: Math.max(0, task.attempts),
          retry_after_ms: null, parked_reason: decision.reason,
        });
        this.opts.log(`  rate limited: ${decision.reason}`);
        if (decision.kind === 'long' || decision.kind === 'overage') {
          this.opts.notify(`park:${decision.rate_limit_type}`, 'cq parked',
            `${decision.rate_limit_type}: ${decision.reason}`);
        }
        return { park: decision, disposition: outcome.disposition };
      }

      case 'max_turns': {
        // Requeued once with a hand-off, never extended. A task that repeatedly hits
        // the cap is too big; the fix is decomposition, not more turns.
        const retire = task.attempts + 1 >= MAX_ATTEMPTS;
        this.queue.setTask(task.id, {
          ...base,
          status: retire ? 'failed' : 'queued',
          handoff: `Your previous attempt hit the ${maxTurns}-turn cap and was stopped. ` +
                   `Its session id is ${outcome.session_id ?? 'unknown'}. Do not redo finished work — ` +
                   `check the tree and the git log first, then finish only what remains. ` +
                   `If the task is genuinely too big for ${maxTurns} turns, do the part you can, ` +
                   `commit it, and recommend the rest as follow-up tasks in your summary.`,
          result_summary: trim(outcome.final_text, 2000) || null,
          last_error: `hit the ${maxTurns}-turn cap`,
          retry_after_ms: retire ? null : this.opts.now() + backoffMs(task.attempts + 1),
        });
        this.opts.log(`  hit the turn cap${cost} — ${retire ? 'retiring (max attempts)' : 'requeued with a hand-off'}`);
        if (retire) this.#blockDependents(task.id, `${task.id} failed: repeatedly hit the turn cap`);
        break;
      }

      case 'aborted':
        this.queue.setTask(task.id, { ...base, status: 'parked', attempts: Math.max(0, task.attempts) });
        this.opts.log('  aborted');
        break;

      default: {   // failed, timeout, spawn_failed
        const retire = task.attempts + 1 >= MAX_ATTEMPTS;
        const why = outcome.disposition === 'timeout' ? 'timed out'
          : outcome.disposition === 'spawn_failed' ? `could not start \`${this.opts.bin}\`: ${outcome.error}`
          : `exit ${outcome.exit_code}`;
        this.queue.setTask(task.id, {
          ...base, status: retire ? 'failed' : 'queued',
          last_error: trim(`${why}\n${outcome.stderr_tail ?? ''}`.trim(), 4000),
          last_exit_code: outcome.exit_code ?? null,
          retry_after_ms: retire ? null : this.opts.now() + backoffMs(task.attempts + 1),
        });
        this.opts.log(`  ${why} — ${retire ? 'failed permanently' : `retry ${task.attempts + 1}/${MAX_ATTEMPTS} after backoff`}`);
        if (retire) {
          this.#blockDependents(task.id, `${task.id} failed: ${why}`);
          this.opts.notify(`fail:${task.id}`, 'cq task failed', `${task.id} ${task.title || ''}: ${why}`);
        }
      }
    }

    // A warning seen during a task that nevertheless completed: finish, then park.
    const decision = classify(outcome.rate_limit, {
      parkAtUtilization: this.opts.parkAtUtilization, allowOverage: this.opts.allowOverage,
    });
    if (decision.action === 'finish_then_park') {
      this.opts.log(`  ${decision.reason} — will park after this task`);
      return { finishThenPark: decision, disposition: outcome.disposition };
    }
    return { disposition: outcome.disposition };
  }

  /**
   * Wait for every in-flight run to finish, returning the strongest park signal any of
   * them produced. Dropping these on the floor meant a park detected by the last
   * concurrent run never reached status.json.
   */
  async #drain(inFlight) {
    let park = null, finishThenPark = null;
    while (inFlight.size) {
      const r = await Promise.race(inFlight.values());
      inFlight.delete(r.id);
      if (r.park && !park) park = r.park;
      if (r.finishThenPark && !finishThenPark) finishThenPark = r.finishThenPark;
    }
    return { park, finishThenPark };
  }

  #blockDependents(failedId, reason) {
    const blocked = this.queue.update((data) => blockDependents(data, failedId, reason));
    if (blocked.length) {
      for (const id of blocked) this.inbox.add(id, `${reason}. Should ${id} be re-scoped, skipped, or retried?`);
      this.opts.log(`  blocked ${blocked.length} dependent task(s): ${blocked.join(', ')}`);
    }
  }

  /**
   * Ingest a worker's `Recommended tasks` JSON. Never fatal: bad JSON is just skipped.
   *
   * Bounded twice, because an unbounded version is a runaway usage bug: a recommended
   * task that recommends more tasks grows the queue faster than the queue drains it,
   * and the tool's whole purpose is to not spend a window on work nobody asked for.
   *   - depth: only tasks a human or `cq plan` authored may spawn recommendations.
   *     A recommendation's recommendations are logged and dropped.
   *   - width: at most MAX_RECOMMENDED_PER_TASK from any single run.
   */
  #ingestRecommended(finalText, parentId) {
    if (this.opts.ingestRecommended === false) return 0;
    const parent = this.queue.get(parentId);
    const depth = parent?.recommend_depth ?? 0;
    if (depth >= MAX_RECOMMEND_DEPTH) {
      if (/```json/.test(finalText ?? '')) {
        this.opts.log(`  (ignoring follow-up recommendations from ${parentId}: it was itself a recommendation)`);
      }
      return 0;
    }
    const blocks = [...(finalText ?? '').matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1]);
    for (const block of blocks) {
      let parsed;
      try { parsed = JSON.parse(block); } catch { continue; }
      const list = Array.isArray(parsed?.tasks) ? parsed.tasks : null;
      if (!list || !list.length) continue;
      let added = 0;
      this.queue.update((data) => {
        for (const raw of list.slice(0, MAX_RECOMMENDED_PER_TASK)) {
          if (!raw || typeof raw.prompt !== 'string' || !raw.prompt.trim()) continue;
          data.tasks.push(makeTask({
            id: nextId(data.tasks),
            title: String(raw.title ?? '').slice(0, 200),
            prompt: raw.prompt,
            context_files: Array.isArray(raw.context_files) ? raw.context_files.map(String) : [],
            // Recommendations are suggestions, not commitments: they queue at the back
            // and never inherit a priority that would jump the human's own ordering.
            priority: 3,
            depends_on: [],
            recommended_by: parentId,
            recommend_depth: depth + 1,
          }));
          added++;
        }
      });
      if (added) {
        if (list.length > MAX_RECOMMENDED_PER_TASK) {
          this.opts.log(`  (kept ${MAX_RECOMMENDED_PER_TASK} of ${list.length} recommended tasks)`);
        }
        return added;
      }
    }
    return 0;
  }

  #persistPark(decision) {
    this.status.setState(STATES.PARKED, {
      park: {
        reason: decision.reason, rate_limit_type: decision.rate_limit_type,
        kind: decision.kind, resets_at_ms: decision.resets_at_ms,
        detected_by: decision.detected_by, parked_at: this.opts.now(),
      },
      current_task: null,
    });
  }

  /**
   * Sleep toward a reset. Returns true when the window has actually reopened.
   *
   * Long parks nap in capped chunks rather than one multi-day sleep, so status.json
   * stays fresh, a laptop suspend or clock jump is absorbed, and `cq status` shows a
   * live countdown instead of a process that looks hung.
   */
  async #sleepUntilReset(park) {
    const nap = napFor(park, { now: this.opts.now() });
    if (nap.ms <= 0) return true;
    const until = park.resets_at_ms ? new Date(park.resets_at_ms + RESET_GRACE_MS).toISOString() : 'unknown';
    this.opts.log(`parked (${park.rate_limit_type}): sleeping ${fmtDur(nap.ms)}${nap.final ? '' : ' (of a longer wait)'} — window reopens ${until}`);
    await this.opts.sleep(nap.ms);
    if (this.stopped) return false;
    return !park.resets_at_ms || this.opts.now() >= park.resets_at_ms + RESET_GRACE_MS;
  }
}

function defaultSleep(ms) {
  return new Promise((res) => { const t = setTimeout(res, ms); t.unref?.(); });
}

function trim(s, n) { return typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s; }

export function fmtDur(ms) {
  if (ms == null) return '?';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h < 48) return `${h}h${m ? ` ${m}m` : ''}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function stallMessage(stall) {
  switch (stall.kind) {
    // `73` is the amateur-radio sign-off: best regards. The queue is worked; going QRT.
    case 'empty': return 'queue is empty — nothing left to do. 73';
    case 'blocked': return `stopping: ${stall.tasks.length} task(s) blocked on a human decision (${stall.tasks.join(', ')}). Run \`cq inbox\`.`;
    case 'deps_unsatisfiable': return `stopping: ${stall.tasks.length} task(s) depend on work that failed (${stall.tasks.join(', ')}). Run \`cq status\`.`;
    default: return `stopping: no runnable task (${stall.tasks?.join(', ') ?? ''})`;
  }
}
