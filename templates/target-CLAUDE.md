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
