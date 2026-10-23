# cq — notes for Claude Code

`cq` is a usage-aware supervisor for Claude Code: it runs a task queue unattended, parks
when a rate-limit window is exhausted, and resumes when it resets. Read
[ARCHITECTURE.md](ARCHITECTURE.md) before changing anything structural — especially §1.2,
which records where the real CLI contradicts what you might assume about its flags.

## Ground rules for this repo

**Check the CLI, don't recall it.** Every flag and event shape in this codebase was
confirmed by running `claude` and reading the output. `docs/sample-stream.jsonl` and
`docs/sample-stream-max-turns.jsonl` are genuine captures. If you need to know how the
CLI behaves, run it — and if you find a discrepancy with ARCHITECTURE.md, the CLI wins
and the document gets updated.

**Testing the state machine shouldn't cost usage.** `test/fake-bin/claude` replays
`test/fixtures/*.jsonl` and the clock is faked, so "parks for two days and resumes" is
asserted in milliseconds. Any new scheduler behaviour needs a fixture-driven test. One
real smoke test against the live CLI is enough, and it already exists.

**`src/limits/` is pure.** No clock, no files, no spawn: `classify()` takes a payload
and returns a decision. That's what makes the rate-limit paths testable at all. Keep it
that way.

**Keep failures local.** A crashing task must never take the daemon down. `runTask`
doesn't throw for task-level problems, and the scheduler treats anything that does throw
as a task failure. A code path that throws past those boundaries is a bug, even if tests
pass.

**Only `src/notify/` and `src/daemon/` may be platform-specific.** Everything else runs
anywhere, and its tests run anywhere.

## Layout

```
src/queue/      tasks.json I/O, validation, selection, dependency logic
src/runner/     spawns one `claude -p` per task; stream.js parses stream-json
src/limits/     the rate-limit state machine (pure)
src/scheduler/  the loop; status.js is the spend ledger
src/inbox/      needs-human decisions (markdown)
src/notify/     osascript on darwin, no-op elsewhere
src/plan/       one Opus call, brief -> task list
src/daemon/     launchd (macOS); prints a systemd unit elsewhere
src/cli/        commander wiring and rendering only, no logic
templates/      worker.md (per-prompt) and target-CLAUDE.md (per-repo)
```

## Conventions

- Plain ESM JavaScript. No build step — `bin/cq.js` runs the sources directly.
- Dependencies are `commander` and nothing else. `node:test` is the test runner. Adding
  a dependency requires justifying it in ARCHITECTURE.md §6.
- Comments explain *why*, not what. Most of them exist because a reader would otherwise
  reasonably assume the opposite.
- Errors that a human will read while editing a file by hand should name the thing they
  typed wrong, not the schema rule it violated.

## Before you commit

```bash
npm test     # 94 tests, all fixture-driven, none spend usage
```

Update `docs/STATUS.json` if you change what is tested, smoke-tested, or untested. It is
meant to be honest: it reports what actually works, not what is written.

<!-- cq: appended by `cq init`. Keeps the worker protocol in the project so the
     supervisor does not re-send it with every task. -->

## Running under cq (Claude Queue)

This repo is driven by `cq`, a supervisor that runs one task per fresh `claude -p`
invocation. If you are reading this inside such a run, the rules are:

- **One task per session.** Your prompt names exactly one task. Do not start others.
- **Small context.** Read only what you need; the task's `context_files` are already in
  your prompt. Surveying the repo is the main way a queued run wastes its window.
- **Decide and state it.** Make routine calls yourself and record the assumption in your
  final message. Escalate only decisions that are genuinely not yours.
- **Escalate without blocking.** Append genuine decisions to `.cq/inbox.md` under
  `## Needs human` as `- [ ] <task-id>: <question>`, then continue with everything that
  does not depend on the answer.
- **Commit as `cq: <task-id> <title>`.** Never leave the tree broken.
- **No questions, no prompts.** Nobody is watching the terminal. Exit when done.
- **No self-review loops.** Do not screenshot-and-critique, score yourself, or iterate
  for polish. If review is needed it is a separate queued task, and it gets one round.

Queue state lives in `.cq/`: `tasks.json` (the queue), `inbox.md` (decisions awaiting a
human), `status.json` (window + spend), `logs/<task-id>.jsonl` (full stream per task).
`.cq/` is hand-editable; run `cq status` to see the queue and the current rate-limit
window.
