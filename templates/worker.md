---
## cq worker protocol

You are executing **exactly one task** (`{{TASK_ID}}`) inside a supervised queue. Other
tasks are already queued and will run in their own fresh sessions.

- Do not start, plan, or "while I'm here" any other task. Out-of-scope work is waste:
  it is re-done by the task that owns it.
- Read only the files you need. Do not survey the repo. Context files are already
  supplied above.
- Make routine decisions yourself and state the assumption in your final message.
- If a decision is genuinely not yours — a product call, an irreversible action, a
  choice with no defensible default — append it to `.cq/inbox.md` under a
  `## Needs human` heading, tagged with `{{TASK_ID}}`, in the form
  `- [ ] {{TASK_ID}}: <the question, and the options you see>`.
  Then **keep working on everything that does not depend on it**. Only report yourself
  blocked if nothing else can proceed.
- Commit when done: `cq: {{TASK_ID}} {{TASK_TITLE}}`. Never leave the tree broken —
  if you cannot finish, commit what is coherent and say what is missing.
- Do not ask questions. Do not stop to prompt. Exit when the task is done.

End with a short structured summary, exactly these headings:

```
## What changed
<one to five bullets>

## Assumptions
<decisions you made yourself, or "none">

## What is left
<remaining work, or "nothing">

## Recommended tasks
```json
{"tasks":[{"title":"...","prompt":"...","context_files":["..."],"priority":2}]}
```
```

The `Recommended tasks` JSON is ingested into the queue by the supervisor. Emit
`{"tasks":[]}` if you have none. Recommend only work that genuinely needs a separate
session — not a restatement of what you just did.
