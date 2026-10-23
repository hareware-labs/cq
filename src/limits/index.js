/**
 * Rate-limit state machine. Pure: no clock, no I/O, no spawn.
 *
 * That purity is the point. Every branch below is reachable from a fixture in a unit
 * test, so the behaviour that only shows up once a 5-hour window is exhausted can be
 * verified without exhausting one.
 */

export const STATES = {
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  FINISH_CURRENT_THEN_PARK: 'FINISH_CURRENT_THEN_PARK',
  PARKED: 'PARKED',
};

/** Grace added to every reset time. Server and client clocks are not the same clock. */
export const RESET_GRACE_MS = 60_000;
/** Stop at a task boundary before the window is actually gone. */
export const DEFAULT_PARK_AT_UTILIZATION = 0.92;
/** Longest single sleep. A seven-day park naps repeatedly rather than once for days. */
export const MAX_NAP_MS = 8 * 60 * 60 * 1000;
export const MIN_NAP_MS = 60_000;

/** Matches the shape of a usage-limit failure in stderr or a final message. */
export const LIMIT_SIGNATURE =
  /(rate.?limit|usage limit|limit reached|resets? at|too many requests|\b429\b|quota exceeded)/i;

/**
 * Epoch seconds vs milliseconds is genuinely ambiguous in a bare number, and the
 * observed CLI sends seconds (verified: 1788570000 -> 2026-09-05, plausible; as ms it
 * would be 1970). Anything below 1e11 is seconds -- that threshold sits at year 5138
 * in seconds and 1973 in ms, so no real timestamp is ambiguous.
 */
export function toMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Normalise an observed `rate_limit_info` payload.
 *
 * Accepts both the camelCase spelling the CLI actually emits (`resetsAt`,
 * `rateLimitType`) and the snake_case one the brief specified, in both directions, so
 * a rename on either side is a no-op here. Unknown fields are ignored but preserved
 * in `raw`.
 */
export function normalizeRateLimit(info) {
  if (!info || typeof info !== 'object') return null;

  const windows = {};
  const uw = info.unifiedWindows ?? info.unified_windows;
  if (uw && typeof uw === 'object') {
    for (const [name, w] of Object.entries(uw)) {
      if (!w || typeof w !== 'object') continue;
      windows[name] = {
        utilization: num(w.utilization),
        resets_at_ms: toMs(w.resetsAt ?? w.resets_at),
      };
    }
  }

  const type = info.rateLimitType ?? info.rate_limit_type ?? 'unknown';
  const rawStatus = info.status;
  const known = ['allowed', 'allowed_warning', 'rejected'];
  // An unrecognised status must not invent a stop. Treat it as `allowed` and let the
  // utilization threshold and the process exit code do the deciding.
  const status = known.includes(rawStatus) ? rawStatus : 'allowed';

  return {
    status,
    status_unknown: !known.includes(rawStatus) ? String(rawStatus ?? 'missing') : null,
    rate_limit_type: typeof type === 'string' ? type : 'unknown',
    resets_at_ms: toMs(info.resetsAt ?? info.resets_at),
    utilization: num(info.utilization) ?? windows[type]?.utilization ?? null,
    windows,
    is_using_overage: info.isUsingOverage === true || info.is_using_overage === true,
    overage_status: info.overageStatus ?? info.overage_status ?? null,
    overage_resets_at_ms: toMs(info.overageResetsAt ?? info.overage_resets_at),
    raw: info,
  };
}

/** Long windows (days) are handled differently from the 5-hour window. */
export function isLongWindow(rateLimitType) {
  return typeof rateLimitType === 'string' && rateLimitType.startsWith('seven_day');
}

/**
 * Unknown limit types are treated as long windows.
 *
 * Guessing "short" on an unknown long window means waking every few hours to be
 * rejected again; guessing "long" on an unknown short window means one over-long
 * sleep that `cq status` shows and `cq run --force` overrides. The second error is
 * cheaper, so unknown resolves that way.
 */
export function classKind(rateLimitType) {
  if (rateLimitType === 'five_hour') return 'short';
  if (isLongWindow(rateLimitType)) return 'long';
  if (rateLimitType === 'overage') return 'overage';
  return 'long';
}

/**
 * Decide what the supervisor should do, given the most recent rate-limit info.
 *
 * @returns {{action:'continue'|'finish_then_park'|'park', reason:string,
 *            resets_at_ms:number|null, rate_limit_type:string, kind:string,
 *            utilization:number|null, detected_by:string}}
 */
export function classify(info, {
  parkAtUtilization = DEFAULT_PARK_AT_UTILIZATION,
  allowOverage = false,
} = {}) {
  if (!info) {
    return { action: 'continue', reason: 'no rate-limit information seen',
             resets_at_ms: null, rate_limit_type: 'unknown', kind: 'none',
             utilization: null, detected_by: 'none' };
  }

  const kind = classKind(info.rate_limit_type);
  const base = {
    resets_at_ms: info.resets_at_ms ?? info.windows?.[info.rate_limit_type]?.resets_at_ms ?? null,
    rate_limit_type: info.rate_limit_type,
    kind,
    utilization: info.utilization,
    detected_by: 'rate_limit_event',
  };

  if (info.status === 'rejected') {
    return { ...base, action: 'park',
             reason: `${info.rate_limit_type} limit rejected the request` };
  }

  // Overage is a money boundary, not a time boundary: never spend into it silently.
  if (!allowOverage && (info.overage_status === 'rejected' || info.is_using_overage)) {
    return { ...base, action: 'park', kind: 'overage',
             resets_at_ms: info.overage_resets_at_ms ?? base.resets_at_ms,
             rate_limit_type: 'overage',
             reason: info.is_using_overage
               ? 'this account is now spending overage; parked rather than billing you by surprise (--allow-overage to continue)'
               : 'overage is rejected' };
  }

  if (info.status === 'allowed_warning') {
    return { ...base, action: 'finish_then_park',
             reason: `${info.rate_limit_type} window is nearly exhausted (warning from the CLI)` };
  }

  // Soft threshold, using the utilization that `unifiedWindows` provides on every
  // event -- park at a clean task boundary rather than mid-task at 100%.
  if (typeof info.utilization === 'number' && info.utilization >= parkAtUtilization) {
    return { ...base, action: 'finish_then_park', detected_by: 'utilization',
             reason: `${info.rate_limit_type} window at ${(info.utilization * 100).toFixed(0)}% ` +
                     `(soft threshold ${(parkAtUtilization * 100).toFixed(0)}%)` };
  }

  return { ...base, action: 'continue', reason: 'within limits' };
}

/**
 * Classify a process outcome that carried no `rejected` event. Heuristic, and labelled
 * as such: a task whose own output discusses rate limits can trip it. A needless park
 * is visible in `cq status` and overridable; a missed park burns retries against a
 * closed window.
 */
export function classifyExit({ exitCode, stderr = '', finalText = '' }) {
  if (exitCode === 0) return null;
  const haystack = `${stderr}\n${finalText}`;
  if (!LIMIT_SIGNATURE.test(haystack)) return null;
  const m = /resets? at[:\s]+([^\n.]+)/i.exec(haystack);
  return {
    action: 'park', kind: 'unknown', rate_limit_type: 'unknown',
    resets_at_ms: null, utilization: null, detected_by: 'exit_signature',
    reason: `exit ${exitCode} with a rate-limit signature in output` +
            (m ? ` (${m[1].trim()})` : ''),
  };
}

/**
 * How long to sleep before trying again.
 *
 * Capped at MAX_NAP_MS so a multi-day seven-day park wakes periodically: it refreshes
 * status.json, survives a clock jump or a laptop suspend, and gives the user a live
 * countdown instead of a process that looks hung.
 */
export function napFor(decision, { now = Date.now(), maxNapMs = MAX_NAP_MS } = {}) {
  const target = decision?.resets_at_ms ? decision.resets_at_ms + RESET_GRACE_MS : null;
  if (!target) {
    // No reset time: back off a conservative fixed interval rather than spinning.
    return { ms: Math.min(15 * 60_000, maxNapMs), until: now + 15 * 60_000, final: false };
  }
  const remaining = target - now;
  if (remaining <= 0) return { ms: 0, until: target, final: true };
  const ms = Math.min(Math.max(remaining, MIN_NAP_MS), maxNapMs);
  return { ms, until: target, final: ms >= remaining };
}

/** Exponential backoff for ordinary task failures: 30s, 2m, 8m, jittered +/-10%. */
export function backoffMs(attempts, { base = 30_000, factor = 4, jitter = 0.1, rand = Math.random } = {}) {
  const raw = base * Math.pow(factor, Math.max(0, attempts - 1));
  return Math.round(raw * (1 + (rand() * 2 - 1) * jitter));
}
