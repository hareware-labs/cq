# cq runbook

What to do when something is wrong. Every procedure here assumes you are in the repo
whose `.cq/` you want to fix.

---

## Diagnosing anything

Start here, always:

```bash
cq status      # queue, window, park state, spend
cq doctor      # is the CLI there, do its flags still exist, is the queue valid
```

`cq status --json` gives you the same thing machine-readably.

---

## Parked on a seven-day limit

**Symptom.**

```
state    PARKED
  parked: seven_day limit rejected the request
  resumes in 2d 4h
```

**This is working correctly.** A seven-day bucket is exhausted; there is nothing to do
but wait. `cq` naps in capped chunks (max 8h at a time) rather than one long sleep, so
it survives a laptop suspend, absorbs a clock change, and keeps the countdown fresh.

**If you want it to keep running anyway:**

- *You have a second account or a different auth:* switch it, then `cq run --force`.
- *You are willing to pay overage:* `cq run --allow-overage`. `cq` parks on overage by
  default because that's your call to make, not the tool's. Check
  `cq status` for `spending overage` and an `overage resets` date first.
- *You want to work by hand in the meantime:* leave the daemon parked. It holds `.cq/lock`
  for the whole of `cq run`, park included, so a second `cq run` in the same repo will
  refuse to start — but an interactive `claude` session is unaffected. Just expect the
  daemon to wake up and start committing.

**If it is parked but the window looks open** — `cq status` shows `five_hour 12%` and
`resumes in 3h` — the park was probably detected from a process exit signature rather
than a real rate-limit event:

```
  parked: exit 1 with a rate-limit signature in output  (detected from the exit signature — a heuristic)
```

That heuristic can misfire when a task's *own output* discusses rate limits. Override it:

```bash
cq run --force
```

**Survive a reboot.** If you are going to be parked for days, install the daemon so the
wait continues without a terminal open:

```bash
cq daemon install && cq daemon start
cq daemon status                       # pid, last exit, recent log tail
```

---

## A task is stuck in `running`

**Symptom.** `cq status` shows `▶ 1 running` but no `claude` process exists — usually
after a crash, a `kill -9`, or a laptop that slept through it.

**`cq` fixes this itself.** The next `cq run` reconciles on startup: any task left
`running` moves back to `parked` (if it has a `session_id`) or `queued`, and the
recovery is recorded in `status.json`. **`attempts` stays put.** The process died, not
the task — otherwise three unrelated crashes would retire perfectly good work.

```bash
cq run
```
```
reconciled 1 task(s) left running by a previous process: t-007
> t-007 Traffic simulation (sonnet, attempt 2/3, resuming)
```

Because the `session_id` is kept, the retry **resumes** the half-finished session rather
than paying to redo the work.

**If `cq run` refuses to start:**

```
error: .cq is locked by pid 4821 on my-mac since 2026-09-04T18:22:10.000Z.
       If that process is gone, delete .cq/lock.
```

`cq` breaks a lock automatically when the pid is dead or the lock is over 15 minutes
old. If you get this message, the pid **is** alive. Check what it is:

```bash
ps -p 4821 -o pid,command
```

If it is a real `cq run`, leave it alone. If it is an unrelated process that inherited
a recycled pid, `rm .cq/lock`.

**If a task is wedged** (running, but going nowhere), `Ctrl-C` finishes the
current task then stops. To kill it now, `Ctrl-C` twice, then reconcile with `cq run`.
Every run also has a wall-clock timeout (default 60 minutes, `--timeout <minutes>`),
after which the process is killed and the task retried with backoff.

---

## Hand-editing `tasks.json` safely

`.cq/tasks.json` is designed to be edited by hand. The rules:

**1. Edit between tasks, not during one.** `cq` re-reads the queue before every task, so
an edit made while task N runs takes effect for task N+1. An edit made *while `cq` is
writing* can be lost — writes are atomic (temp file → fsync → rename), so you will never
get a corrupt file, but you can get your change overwritten. If it matters, stop the
queue first:

```bash
cq daemon stop      # or Ctrl-C a foreground run
# edit
cq daemon start
```

**2. Validate before you walk away.**

```bash
cq doctor
```
```
error: .cq/tasks.json is invalid:
  - tasks[3] (t-004) has status "runnning"; must be one of queued, running, parked, blocked, done, failed
  - tasks[5] (t-006) depends_on "t-99", which is not a task id
  - dependency cycle: t-007 -> t-008 -> t-007
```

`cq` refuses to run on an invalid queue rather than guessing.

**3. Safe edits.**

| Want to | Do |
|---|---|
| Re-run a finished task | `"status": "queued"`, `"attempts": 0` |
| Retry a permanently failed task | `"status": "queued"`, `"attempts": 0`, and fix the prompt |
| Skip a task | `"status": "done"` (dependents unblock) or delete it *and* every `depends_on` naming it |
| Reorder | Change `priority` (lower runs first); ties keep file order |
| Make one task use Opus | `"model": "opus"` |
| Give a task more room | `"max_turns": 60` — but consider splitting it instead |
| Stop a runaway retry | `"status": "failed"` |

**4. Do not hand-edit `session_id`** unless you are deliberately pointing a task at a
different session. A wrong id makes `--resume` fail and the task restart from scratch.

**5. Adding tasks by hand.** Every field must be present — copy an existing task as a
template, or use `cq add`, which fills them all in. `id` must be unique; `depends_on`
must name real ids.

---

## A task keeps failing

```bash
cq logs t-007          # rendered run history: turns, tools, cost, errors
cq logs t-007 --raw    # the complete unfiltered stream
```

`cq` makes three attempts, waiting 30s and then 2m between them, and marks the task
`failed` after the third,
blocking its dependents so they do not run against a broken precondition. Common causes:

| `last_error` looks like | Usually means |
|---|---|
| `hit the 40-turn cap` | The task is too big. Split it into two, or raise `max_turns` if it's close. |
| `exit 1` with a permissions message | The worker hit a permission prompt. `cq` runs with `bypassPermissions`; check the repo's settings. |
| `could not start \`claude\`` | The CLI is not on `PATH` — under launchd especially. `cq doctor`, then reinstall the agent so it captures your current `PATH`. |
| `timed out` | Raise `--timeout`, or split the task. |

**A task that hits the turn cap is requeued exactly once**, with a hand-off note telling
the next attempt what already landed and giving it the previous `session_id`. It is
never given more turns — a task that keeps hitting the cap is too big, and the fix is
splitting it up, not a bigger budget.

---

## The queue stops with tasks left

```
stopping: 3 task(s) blocked on a human decision (t-011, t-014, t-018). Run `cq inbox`.
```

Workers escalated decisions they could not make. Answer them:

```bash
cq inbox
cq inbox answer 1 "Use Auth0 — it is already in the stack."
```

Answering unblocks the task and prepends the answer to its next prompt. You can also
edit `.cq/inbox.md` directly — write under the `> ` line; the checkbox is optional.

```
stopping: 2 task(s) depend on work that failed (t-012, t-013).
```

Their dependency failed permanently. Either fix and requeue the failed task, or edit
`depends_on` to drop it.

---

## Recovering spend information

`.cq/status.json` holds the ledger: `spend.by_task` (cost, tokens, turns, duration per
task) and `spend.by_window` (bucketed by the five-hour window's reset time). If it is
lost or corrupt, `cq` starts a fresh one — the queue itself is unaffected, but history
is gone. The per-task cost is still recoverable from the logs:

```bash
grep '"type":"result"' .cq/logs/t-007.jsonl | tail -1
```

---

## Starting over

```bash
cq daemon stop
rm -rf .cq
cq init
```

This destroys the queue, the inbox, the ledger and every log. Committed work is
untouched — workers commit as they go, so `git log` is the durable record.
