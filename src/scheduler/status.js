import { readFileSync, existsSync } from 'node:fs';
import { writeJsonAtomic } from '../util/atomic.js';
import { cqPaths } from '../util/paths.js';
import { STATES } from '../limits/index.js';

export function emptyStatus() {
  return {
    version: 1,
    state: STATES.IDLE,
    since: Date.now(),
    current_task: null,
    park: null,
    window: {},
    caps: {},
    spend: { total_usd: 0, by_window: {}, by_task: {} },
    reconciled: [],
    updated_at: Date.now(),
  };
}

/** Supervisor state + the spend ledger. Rewritten on every transition. */
export class Status {
  constructor(root) { this.paths = cqPaths(root); }

  read() {
    if (!existsSync(this.paths.status)) return emptyStatus();
    try { return { ...emptyStatus(), ...JSON.parse(readFileSync(this.paths.status, 'utf8')) }; }
    catch { return emptyStatus(); }   // a corrupt status file must not stop the queue
  }

  write(s) { writeJsonAtomic(this.paths.status, { ...s, updated_at: Date.now() }); return s; }

  update(fn) { const s = this.read(); fn(s); return this.write(s); }

  setState(state, extra = {}) {
    return this.update((s) => {
      if (s.state !== state) s.since = Date.now();
      s.state = state;
      Object.assign(s, extra);
    });
  }

  /**
   * Fold one finished run into the ledger.
   *
   * Bucketed by the five-hour window's reset time, so `cq status` can answer "what have
   * I spent in *this* window" -- which is the number that decides whether to queue more
   * work now or wait, and it is not derivable from a running total.
   */
  recordSpend(taskId, outcome, windowKey = null) {
    return this.update((s) => {
      const cost = outcome.cost_usd ?? 0;
      s.spend.total_usd = round(s.spend.total_usd + cost);

      const t = (s.spend.by_task[taskId] ??= { usd: 0, runs: 0, turns: 0, ms: 0, tokens_in: 0, tokens_out: 0 });
      t.usd = round(t.usd + cost);
      t.runs += 1;
      t.turns += outcome.num_turns ?? 0;
      t.ms += outcome.duration_ms ?? 0;
      t.tokens_in += outcome.usage?.input_tokens ?? 0;
      t.tokens_out += outcome.usage?.output_tokens ?? 0;
      t.last_disposition = outcome.disposition;

      const key = windowKey ?? 'unknown';
      const w = (s.spend.by_window[key] ??= { usd: 0, runs: 0, tasks: [] });
      w.usd = round(w.usd + cost);
      w.runs += 1;
      if (!w.tasks.includes(taskId)) w.tasks.push(taskId);
    });
  }

  recordWindow(rateLimit) {
    if (!rateLimit) return this.read();
    return this.update((s) => {
      for (const [name, w] of Object.entries(rateLimit.windows ?? {})) s.window[name] = w;
      if (rateLimit.rate_limit_type && rateLimit.resets_at_ms) {
        s.window[rateLimit.rate_limit_type] ??= {};
        s.window[rateLimit.rate_limit_type].resets_at_ms = rateLimit.resets_at_ms;
        if (rateLimit.utilization != null) {
          s.window[rateLimit.rate_limit_type].utilization = rateLimit.utilization;
        }
      }
      s.is_using_overage = rateLimit.is_using_overage ?? false;
      s.overage_resets_at_ms = rateLimit.overage_resets_at_ms ?? null;
      s.last_status = rateLimit.status;
    });
  }
}

const round = (n) => Math.round(n * 1e6) / 1e6;

/** Identify the current five-hour window by its reset time, for ledger bucketing. */
export function windowKeyFor(rateLimit) {
  const ms = rateLimit?.windows?.five_hour?.resets_at_ms
    ?? (rateLimit?.rate_limit_type === 'five_hour' ? rateLimit.resets_at_ms : null);
  return ms ? new Date(ms).toISOString() : 'unknown';
}
