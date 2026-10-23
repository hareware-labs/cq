import { normalizeRateLimit } from '../limits/index.js';

/**
 * Incremental parser for `claude -p --output-format stream-json --verbose`.
 *
 * Contract: tolerate everything. Unknown event types are counted and ignored, unknown
 * fields are untouched, and a line that is not JSON is counted and skipped rather than
 * thrown. A subprocess's stdout is not a guaranteed-clean channel, and a supervisor
 * that dies on one malformed line is worse than no supervisor.
 */
export class StreamParser {
  constructor() {
    this.buf = '';
    this.events = [];
    this.sessionId = null;
    this.model = null;
    this.cliVersion = null;
    this.result = null;            // the `result` event, verbatim
    this.lastRateLimit = null;     // normalised
    this.rateLimitHistory = [];
    this.assistantText = [];
    this.unknownTypes = new Map();
    this.badLines = 0;
    this.lineCount = 0;
    this.onEvent = null;
  }

  /** Feed a chunk. Safe to call with partial lines. */
  push(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.#line(line);
    }
  }

  /** Flush a trailing line with no newline. A killed process often ends mid-line. */
  end() {
    if (this.buf.trim()) this.#line(this.buf);
    this.buf = '';
    return this.summary();
  }

  #line(raw) {
    const line = raw.trim();
    if (!line) return;
    this.lineCount++;
    let event;
    try { event = JSON.parse(line); }
    catch { this.badLines++; return; }
    // An event must be a JSON object: `null`, arrays and bare scalars are all
    // syntactically valid JSON but are not events.
    if (event === null || typeof event !== 'object' || Array.isArray(event)) { this.badLines++; return; }
    this.#event(event);
  }

  #event(event) {
    this.events.push(event);
    // session_id rides on every event, so the resume id is known from line 1 -- which
    // matters because a run killed by a rate limit may never emit `result`.
    if (typeof event.session_id === 'string') this.sessionId ??= event.session_id;

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          this.model ??= event.model ?? null;
          this.cliVersion ??= event.claude_code_version ?? null;
        }
        break;

      case 'assistant': {
        for (const block of event.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            this.assistantText.push(block.text);
          }
        }
        break;
      }

      case 'rate_limit_event': {
        // Observed shape nests under `rate_limit_info`; accept a flat payload too.
        const info = normalizeRateLimit(event.rate_limit_info ?? event);
        if (info) {
          this.lastRateLimit = info;
          this.rateLimitHistory.push(info);
        }
        break;
      }

      case 'result':
        this.result = event;
        break;

      case 'user':
      case 'stream_event':
        break;

      default:
        this.unknownTypes.set(event.type, (this.unknownTypes.get(event.type) ?? 0) + 1);
    }
    this.onEvent?.(event);
  }

  /**
   * The strongest rate-limit signal in the whole stream. A `rejected` anywhere wins
   * over a later `allowed`: the run was refused, and a subsequent event does not undo
   * that.
   */
  strongestRateLimit() {
    return this.rateLimitHistory.find((r) => r.status === 'rejected')
        ?? this.rateLimitHistory.find((r) => r.status === 'allowed_warning')
        ?? this.lastRateLimit;
  }

  /** Final assistant text: `result.result` when present, else the last text block. */
  finalText() {
    if (typeof this.result?.result === 'string') return this.result.result;
    return this.assistantText.at(-1) ?? '';
  }

  summary() {
    const r = this.result;
    return {
      session_id: this.sessionId,
      model: this.model,
      cli_version: this.cliVersion,
      result_subtype: r?.subtype ?? null,
      is_error: r?.is_error ?? null,
      stop_reason: r?.stop_reason ?? null,
      terminal_reason: r?.terminal_reason ?? null,
      num_turns: r?.num_turns ?? null,
      duration_ms: r?.duration_ms ?? null,
      cost_usd: typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null,
      usage: r?.usage ?? null,
      model_usage: r?.modelUsage ?? null,
      final_text: this.finalText(),
      rate_limit: this.strongestRateLimit(),
      saw_result: Boolean(r),
      lines: this.lineCount,
      bad_lines: this.badLines,
      unknown_types: Object.fromEntries(this.unknownTypes),
    };
  }
}

/** Parse a whole stream at once (fixtures, `cq logs`). */
export function parseStream(text) {
  const p = new StreamParser();
  p.push(text);
  return p.end();
}
