# cq (Claude Queue) — Architecture

A usage-aware supervisor for Claude Code. It runs a persistent task queue unattended,
parks gracefully when a subscription rate-limit window is exhausted, resumes when it
resets, and collects human decisions in an inbox instead of blocking on them.

**Design principle: one task, one fresh `claude -p` invocation, small prompt, hand-off
through files.** This exists to replace multi-hour single-session runs, which burn the
5-hour window through compounding context: every turn re-sends the whole transcript, so
cost per unit of work grows superlinearly with session length. A fresh process per task
resets that to a flat, predictable cost.

---

## 1. Verified CLI surface

Everything below came from running the CLI on this machine. Raw
evidence is in `docs/sample-stream.jsonl` (a `claude -p "say ok"` run) and
`docs/sample-stream-max-turns.jsonl` (a run truncated by `--max-turns 2`).

| Item | Value |
|---|---|
| CLI version | **2.1.261 (Claude Code)** |
| Node | v25.2.1 (package requires >= 22; CI tests 22) |
| Platform verified on | darwin 25.4.0 (arm64) |

### 1.1 Flags confirmed present

| Flag | Status | Notes |
|---|---|---|
| `-p, --print` | documented | non-interactive |
| `--output-format stream-json` | documented | also `text`, `json` |
| `--verbose` | **required** for `stream-json` + `--print` | verified: omitting it exits 1 with `Error: When using --print, --output-format=stream-json requires --verbose` |
| `-r, --resume <id>` | documented | verified round-trip; **session id is preserved**, not forked (use `--fork-session` to fork) |
| `--model <alias>` | documented | `opus`, `sonnet`, `fable`, or a full id |
| `--allowedTools, --allowed-tools` | documented | comma- or space-separated |
| `--permission-mode <mode>` | documented | `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` |
| `--max-budget-usd <amount>` | documented | print mode only — a real, enforced spend cap |
| `--session-id <uuid>` | documented | lets us assign the id up front |
| `--add-dir`, `--append-system-prompt`, `--settings` | documented | |

### 1.2 Discrepancies with the build brief — the CLI wins

These are the places where the brief's assumptions did not survive contact with
2.1.261. In each case the code follows the observed CLI.

**(a) `--max-turns` is undocumented but functional.**
It does not appear in `claude --help` or `claude -p --help` in 2.1.261. It is still
accepted and enforced: `claude -p ... --max-turns 2` exited **1** and emitted a
`result` event with `subtype: "error_max_turns"`, `terminal_reason: "max_turns"`,
`is_error: true`. (A genuinely unknown flag is rejected — `--bogus-flag-xyz` exits 1
with `error: unknown option`, so acceptance is meaningful.)

*Consequence:* an undocumented flag can be removed without a deprecation cycle, so `cq`
treats it as best-effort. `runner` probes it once (`cq doctor`, cached in
`.cq/status.json` as `caps.max_turns`) and drops it if unsupported. The **enforced**
budget backstop is `--max-budget-usd`, which is documented; `max_turns` in the task
schema is retained as the primary control with a derived `max_budget_usd` cap alongside
it, so a task cannot run away even if `--max-turns` silently disappears.

**(b) The `rate_limit_event` shape is different from the brief in three ways.**
Observed verbatim:

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1788570000,
    "rateLimitType": "five_hour",
    "overageStatus": "allowed",
    "overageResetsAt": 1790812800,
    "isUsingOverage": false,
    "unifiedWindows": {
      "five_hour": { "utilization": 0.16, "resetsAt": 1788570000 },
      "seven_day": { "utilization": 0.01, "resetsAt": 1788742800 }
    }
  },
  "uuid": "...",
  "session_id": "..."
}
```

1. **Fields are nested under `rate_limit_info`, not flat on the event.** The brief
   implied `event.status` / `event.resets_at`.
2. **Keys are camelCase**: `resetsAt`, `rateLimitType`, not `resets_at` /
   `rate_limit_type`. The parser normalises to snake_case internally and accepts
   **both** spellings, so a future rename in either direction does not break us.
3. **`utilization` is available at `status: "allowed"`**, inside `unifiedWindows` —
   the brief said it appears only at warning/rejected. This is strictly better: `cq`
   gets a continuous 0–1 fuel gauge on every single event rather than only a
   last-second warning. `limits` uses it for a *soft* park threshold
   (`park_at_utilization`, default `0.92`) so we stop before the hard warning, and
   `cq status` can show real headroom at all times.

Also present and unmentioned in the brief: `overageStatus`, `overageResetsAt`,
`isUsingOverage`. These are tracked; `isUsingOverage: true` is surfaced in
`cq status` and notified once, because burning overage is a spend decision the user
should know about, not one `cq` should make silently.

**(c) `resetsAt` is Unix epoch *seconds*, not milliseconds.** Verified by decoding:
`1788570000` → `2026-09-05T01:00:00Z` (a plausible 5-hour boundary, and a round hour);
as milliseconds it would be `1970-01-21`. All three observed timestamps decode
sensibly as seconds and absurdly as ms. The parser multiplies by 1000 exactly once, at
the boundary, and **guards the ambiguity**: any value `< 1e11` is treated as seconds,
anything larger as ms. Internally every time is ms since epoch.

**(d) The default model is expensive.** The `"say ok"` run — two input tokens, five
output tokens — cost **$0.040467** on `claude-opus-5[1m]`. That is the entire argument
for this tool's model policy in one data point: the cost was almost all cached-context
re-read (12,804 cache-read + 3,393 cache-creation tokens), i.e. overhead rather than work.
`cq` therefore always passes `--model` explicitly and never inherits the ambient
default.

**(e) `rate_limit_type` values.** The brief lists `five_hour | seven_day |
seven_day_opus | seven_day_sonnet | overage`. Only `five_hour` was observable on this
account (`unifiedWindows` carried `five_hour` and `seven_day`). The other three are
accepted by the parser and treated by prefix: anything starting `seven_day` is a
long-window park; `overage` is a spend-boundary park. **Any unrecognised value is
treated as a seven-day-class park** — the conservative direction, since guessing
"short" on an unknown long window would spin.

### 1.3 Event stream shape

Observed event `type`s, in order, for a trivial run: `system` (subtype `init`),
`assistant`, `rate_limit_event`, `result`. Every event carries `session_id`, so the
resume id is known from the first line — `cq` does not need to wait for `result` to
learn it, which matters because a run killed by a rate limit may never emit `result`.

The `result` event (subtype `success`) carries what the ledger needs:
`total_cost_usd`, `usage` (input/output/cache-creation/cache-read tokens),
`modelUsage` (per-model breakdown incl. `canonicalModel` and `costUSD`), `num_turns`,
`duration_ms`, `stop_reason`, `terminal_reason`, `is_error`, `subtype`, and `result`
(the final assistant text — this is what the worker protocol's structured summary
arrives in).

`result.subtype` observed: `success`, `error_max_turns`. Others are handled
generically: any `is_error: true` that is not a recognised subtype is a task failure,
not a supervisor failure.

**Parser contract: tolerate everything.** Unknown event types are logged and ignored.
Unknown fields are preserved into the per-task log but never required. A line that is
not valid JSON is counted and skipped, never fatal. A subprocess's stdout isn't a clean
channel and never was.

---

## 2. Modules

Sequential dependency order, which is also the build order.

```
cli ──> scheduler ──> runner ──> (claude -p subprocess)
          │    │         │
          │    │         └──> limits (parses rate_limit_event)
          │    ├──> queue  (.cq/tasks.json + lock)
          │    ├──> inbox  (.cq/inbox.md)
          │    └──> notify (osascript on darwin, no-op elsewhere)
         plan ──> (one opus call) ──> queue
```

| Module | File | Responsibility | Must not |
|---|---|---|---|
| `queue` | `src/queue/` | `tasks.json` read/write, atomic replace, advisory lock, dependency resolution, next-task selection | know about processes or limits |
| `runner` | `src/runner/` | spawn exactly one `claude -p` per task, stream-json line parser, per-task log, extract session id + result | make scheduling decisions |
| `limits` | `src/limits/` | the rate-limit state machine; normalise `rate_limit_info`; decide park/continue; compute sleep-until | do I/O |
| `scheduler` | `src/scheduler/` | the loop: pick → run → classify → persist → sleep/backoff | parse streams |
| `inbox` | `src/inbox/` | append/list/answer `needs_human` decisions; unblock tasks | run anything |
| `notify` | `src/notify/` | user-visible notification | be required (all calls best-effort, failures swallowed) |
| `cli` | `src/cli/` | `commander` wiring, output formatting | contain logic |
| `plan` | `src/plan/` | one Opus call, decompose a prompt into a task list | use tools |

**`limits` is a pure function.** `classify(info, opts) -> Decision`. No clock, no
files, no spawn. Every rate-limit branch is therefore reachable from a fixture, which is
how the tests assert "parks for two days, then resumes" without spending two days or any
usage.

### 2.1 The `rate_limit_event` contract (normalised)

`limits` normalises the observed payload into one internal shape:

```ts
type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';
type RateLimitType   = 'five_hour' | 'seven_day' | 'seven_day_opus'
                     | 'seven_day_sonnet' | 'overage' | string;  // unknown tolerated

interface RateLimitInfo {
  status: RateLimitStatus;      // unknown -> 'allowed' + warn (do not invent a stop)
  resets_at_ms: number | null;  // normalised from resetsAt, seconds -> ms
  rate_limit_type: RateLimitType;
  utilization: number | null;   // 0..1, from unifiedWindows[type] or top level
  windows: Record<string, { utilization: number | null; resets_at_ms: number | null }>;
  is_using_overage: boolean;
  overage_resets_at_ms: number | null;
  raw: unknown;                 // always kept, for the log
}
```

### 2.2 State machine

States are persisted in `.cq/status.json` so a daemon restart resumes mid-window.

```
                    ┌─────────────────────────────────────────┐
                    v                                         │
  IDLE ──(task available)──> RUNNING ──(task ends: done/failed)┘
                               │
      ┌────────────────────────┼──────────────────────────┐
      │ allowed_warning        │ rejected                 │ soft threshold
      │ OR utilization >= 0.92 │ OR exit!=0 w/ limit sig  │ (five_hour only)
      v                        v                          v
  FINISH_CURRENT_THEN_PARK   PARKED                   (same as warning)
      │                        │
      │ current task ends      │ current task is incomplete:
      │ normally, is recorded  │ status -> parked, session_id kept
      v                        v
    PARKED <──────────────────-┘
      │
      │ sleep until resets_at + 60s  (clamped: min 60s, max 8h per nap,
      │ re-checked on wake; a seven_day park may nap many times)
      v
   RUNNING   ── parked task resumes via `--resume <session_id>` with a
               short continuation prompt, NOT a re-send of the full task
```

**Why `FINISH_CURRENT_THEN_PARK` rather than stopping immediately on a warning:**
killing a task mid-flight wastes what it has already spent and can leave a half-edited
tree. A warning says the window is nearly gone, not that you should drop what you're
holding. So the current task lands, commits and is recorded. Then we park, without
starting the next one.

**Seven-day parks sleep too.** If `rate_limit_type` starts with `seven_day`, `cq`
parks, notifies once (this is a rare, high-signal event the user should see), writes
the reason to `status.json`, and still sleeps to `resets_at`. That may be days. That is
correct behaviour rather than a hang; the alternative is spinning against a wall. `cq status`
shows the countdown, and the daemon survives reboots via launchd's `RunAtLoad`.

**Overage.** `overageStatus: 'rejected'` or `isUsingOverage: true` is a money boundary
rather than a time one. The default is to park and notify rather than spend. Opt in with
`--allow-overage`.

### 2.3 Detecting a limit from a non-zero exit

A run killed by a limit may never emit a clean `rate_limit_event` with
`status: rejected`. `runner` therefore also classifies the process outcome:

1. A `rate_limit_event` with `status: 'rejected'` seen anywhere in the stream — the
   strong signal, always wins.
2. Exit code != 0 **and** the combined stderr tail + last `result.result` matches the
   limit signature `/(rate.?limit|usage limit|limit reached|resets? at|too many requests|\b429\b|quota exceeded)/i`.
3. Otherwise: an ordinary task failure.

Case 2 is a heuristic and is marked as such in `status.json` (`limit_detected_by:
"exit_signature"`), because a task whose *own output* discusses rate limits could
trip it. The cost of a false positive is a needless park, which `cq status` shows and
`cq run --force` overrides. A false negative burns retries against a closed window.
Parking is the cheaper mistake.

### 2.4 Failure isolation

A crashing task must never kill the daemon. Every task run is wrapped: the subprocess
is spawned with its own stdio, `runner` never throws past its own boundary, and
`scheduler` treats *any* thrown error from `runner` as a task-level failure.

- `attempts` increments per run; **max 3**, then `status: failed` permanently.
- Backoff between attempts: `30s` then `2m` (exponential, base 30s, factor 4), jittered
  ±10%, and skipped entirely when the failure was a rate-limit park (that has its own
  sleep).
- `failed` tasks record `last_error` (stderr tail, capped at 4 KB) and
  `last_exit_code`. The full stream is always in `.cq/logs/<task-id>.jsonl`.
- A task hitting `max_turns` is **requeued with a hand-off note and never more turns**.
  `attempts` still increments, so after three it fails rather than looping. The note is
  prepended to the prompt: what it did, what remains, and its `session_id` for resume.
- Dependents of a `failed` task become `blocked` with an inbox entry, rather than
  running against a broken precondition.

### 2.5 Concurrency and crash recovery

`.cq/tasks.json` is guarded by an advisory lock (`.cq/lock`, holding pid + hostname +
start time). Writes are atomic: write `tasks.json.tmp`, `fsync`, `rename`. `rename` on
the same filesystem is atomic on POSIX, so a crash mid-write can never truncate the
queue.

A stale lock (pid no longer alive, or older than 15 min) is broken with a warning. On
startup the scheduler **reconciles**: a task left in `running` by a crashed daemon is
moved back to `parked` when it has a `session_id` (so the retry resumes rather than
restarts) and to `queued` when it does not. `attempts` is not incremented -- the
process died, not the task. Both are flagged in `status.json`. This is the "stuck running task" path in the
runbook.

---

## 3. State on disk

Everything lives in `.cq/` in the target repo. All of it is plain text and
hand-editable; `cq` re-reads before every write and never holds the queue in memory
across a sleep.

```
.cq/
  tasks.json          the queue (schema below) — the source of truth
  inbox.md            human decisions, markdown, append-only by workers
  status.json         supervisor state: window, spend ledger, current task, caps
  lock                advisory lock (pid, host, acquired_at)
  logs/<task-id>.jsonl  full raw event stream per task, for post-mortems
  logs/<task-id>.err    stderr per task
```

`.cq/logs/` holds the **complete** stream, unfiltered — that is the only place the
unknown-field data survives, and post-mortems are exactly when unknown fields matter.

### 3.1 `tasks.json`

Flat and hand-editable by design. No nesting beyond one array.

```json
{
  "version": 1,
  "defaults": { "model": "sonnet", "max_turns": 40 },
  "tasks": [
    {
      "id": "t-001",
      "title": "",
      "prompt": "",
      "context_files": [],
      "depends_on": [],
      "priority": 2,
      "model": "sonnet",
      "max_turns": 40,
      "status": "queued",
      "attempts": 0,
      "session_id": null,
      "result_summary": null,
      "needs_human": []
    }
  ]
}
```

`status` ∈ `queued | running | parked | blocked | done | failed`.

- `queued` — eligible once `depends_on` are all `done`.
- `running` — a subprocess owns it. Reconciled to `queued` on crash recovery.
- `parked` — interrupted by a rate limit. Has a `session_id`; resumes via `--resume`.
- `blocked` — *the task itself said it cannot proceed*. Stays blocked until its inbox
  entry is answered. This is the only status a worker can request.
- `done` / `failed` — terminal. `failed` after 3 attempts.

Selection: lowest `priority` number first, then declaration order. Ties are stable so
the queue is predictable to a human reading the file.

### 3.2 `status.json`

Supervisor state + the spend ledger. This is what `cq status` renders and what a
restarted daemon reads to know whether it is mid-park.

```json
{
  "version": 1,
  "state": "RUNNING",
  "since": 1788553505000,
  "current_task": "t-003",
  "park": { "reason": "...", "rate_limit_type": "five_hour",
            "resets_at_ms": 1788570000000, "detected_by": "rate_limit_event" },
  "window": { "five_hour": { "utilization": 0.16, "resets_at_ms": 1788570000000 },
              "seven_day": { "utilization": 0.01, "resets_at_ms": 1788742800000 } },
  "caps": { "max_turns": true, "max_budget_usd": true, "probed_at": 1788553505000, "version": "2.1.261 (Claude Code)" },
  "spend": { "total_usd": 0.0, "by_window": {}, "by_task": {} },
  "reconciled": []
}
```

`spend.by_task[id]` accumulates `total_cost_usd`, tokens, `num_turns` and duration from
each `result` event, so `cq status` can answer "what does a task of this shape cost" —
which is the number the user needs to size future queues.

---

## 4. Usage economy, enforced in code

These are enforced in code. The README carries a shorter version of this list for
readers; this one is the specification, and the two must agree.

1. **Sonnet by default; Opus only when a task asks.** `defaults.model = "sonnet"`.
   `--model` is *always* passed explicitly — never inherited (see §1.2(e): the ambient
   default billed $0.04 for a five-token reply). `cq plan` is the one sanctioned Opus
   call, once per plan.
2. **`max_turns` caps a task; it doesn't size one.** A task that hits it is requeued once with a
   hand-off note and its `session_id`. It is never given more turns. A task that
   repeatedly hits the cap is too big, and the fix is decomposition, which is
   `cq plan`'s job.
3. **`--max-budget-usd` backstop.** Derived per task so an undocumented `--max-turns`
   disappearing cannot produce an unbounded run.
4. **Sequential by default.** `--parallel N` defaults to 1, and the CLI warns when you
   raise it: N workers share one window and drain it N times faster, so the queue parks
   sooner rather than finishing sooner.
5. **Park before the wall.** `park_at_utilization` (default `0.92`) uses the
   continuously-available `unifiedWindows` utilization (§1.2(b)) to stop at a clean
   task boundary rather than mid-task at 100%.
6. **On `allowed_warning`: finish the running task, then park.** Do not start the next.
7. **No critique loops in the worker template.** No screenshot-and-rate rounds, no
   "score it 0–10 and go again". If a queue needs review, that is a separate small
   task with a `depends_on`, and it gets **one** round. A four-round critic loop is
   4× the spend for the last 5% of quality, It's the easiest way to burn a
   five-hour window on nothing.
8. **Recommendations are bounded.** A worker may propose follow-up tasks; those tasks
   may not propose more (`MAX_RECOMMEND_DEPTH = 1`), and at most five are taken from any
   one run (`MAX_RECOMMENDED_PER_TASK = 5`). They queue at `priority: 3` with no
   dependencies, behind whatever the human already ordered. Unbounded ingestion grows
   the queue faster than it drains — verified by a test that would otherwise never
   terminate. `cq run --no-recommend` turns it off.
9. **Small prompts.** Two templates, not one: `templates/worker.md` is the protocol
   block appended to a prompt, and `cq init` copies `templates/target-CLAUDE.md` into
   the target repo's `CLAUDE.md`. When the repo already carries it, the block is
   dropped from the prompt entirely -- a real task measured 268 characters.

---

## 5. Worker protocol

`runner` assembles each prompt from a template — never hand-written per task:

```
[task prompt]
[context_files contents, each fenced and path-labelled]
[protocol block from templates/worker.md]
```

The protocol (full text in `templates/worker.md`) says: execute exactly one task; read
only what you need; make routine decisions and state the assumption; escalate a genuine
decision to `.cq/inbox.md` and keep working on what does not depend on it; commit as
`cq: <id> <title>`; end with a short structured summary including recommended follow-up
tasks as JSON; never ask questions; exit when done.

The final message is parsed opportunistically: a fenced ```json block containing
`{"tasks": [...]}` is ingested into the queue as recommendations. Parse failure is
never fatal — the summary is still stored verbatim in `result_summary`.

---

## 6. Dependencies

Deliberately minimal.

| Dependency | Why |
|---|---|
| `commander` | CLI parsing. Named in the brief; the CLI itself uses it. |
| `node:test` + `node:assert` | Built in. No test-runner dependency at all. |
| `typescript` (dev) | Types only. |

**Nothing else.** No lockfile library (advisory lock is ~40 lines of `fs`), no JSON
schema validator (one hand-written validator, because the error messages need to point
a human at a line in a file they are expected to edit by hand), no date library, no
notification library (`osascript` via `child_process`).

## 7. Portability

macOS is the target, but **nothing in `src/` outside `notify` and `cli/daemon` may
reference darwin.** `notify` no-ops off darwin. `daemon install` generates a launchd
plist under `~/Library/LaunchAgents` with logs to `~/Library/Logs/cq/`; on other
platforms it prints the equivalent `systemd --user` unit and exits without installing.
The scheduler, queue, runner and limits are platform-agnostic and their tests run
anywhere.
