<div align="center">

# cq

**Run Claude Code overnight without losing work to rate limits.**

[![Tests](https://img.shields.io/github/actions/workflow/status/hareware-labs/cq/test.yml?branch=main&style=flat-square&label=tests)](https://github.com/hareware-labs/cq/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-blue?style=flat-square)](package.json)

</div>

## The problem

You give Claude Code a big job and go to bed.

Two hours later it hits your usage limit and stops, mid-edit, with nothing
committed. You wake up to a half-changed file and no idea how far it got.

The window reset at 4am. It sat unused until you noticed.

## What cq does

cq keeps a queue of small tasks and runs them one at a time, each in a fresh
`claude -p` session that commits when it's done.

A Claude subscription refills on a rolling five-hour window, plus a weekly one.
cq watches those. When one runs out it stops between tasks instead of mid-file,
sleeps until the window resets, then carries on.

If a task needs a decision only you can make, it writes the question down and
keeps working on everything else.

Aim for tasks one session can finish: roughly an hour of work, one commit.

## Requirements and install

Node 22+, the Claude Code CLI, and a **Claude subscription** (Pro or Max) signed
in. cq is built around subscription usage windows. On API-key billing there's no
window to wait for, so the main feature does nothing.

With Homebrew:

```bash
brew install hareware-labs/tap/cq
```

That taps `hareware-labs/homebrew-tap` on first use and pulls in Node. To run from
source instead, clone it:

```bash
git clone https://github.com/hareware-labs/cq.git
cd cq && npm install && npm link
```

Not on npm yet. The clone updates with `git pull && npm install` and removes
with `npm unlink -g cq`; brew installs use `brew upgrade`/`brew uninstall cq`.
Runs on macOS and Linux. `cq daemon` uses launchd, so it's macOS only — on
Linux run `cq run` under tmux or systemd.

## Quick start

```bash
cd ~/code/your-project

cq init
cq add "Add a --json flag to the export command" -c src/cli.js
cq add "Write tests for the --json flag" -c test/cli.test.js -d t-001
cq run
```

```text
> t-001 Add a --json flag to the export command (sonnet, attempt 1/3)
  done $0.0860 4 turns
> t-002 Write tests for the --json flag (sonnet, attempt 1/3)
  done $0.0814 5 turns
queue is empty — nothing left to do.
```

For a bigger job, write a brief and let cq break it down:

```bash
cq plan brief.md     # one Opus call, returns a dependency-ordered task list
cq run
```

## Read this before you run it

cq runs every task with `--permission-mode bypassPermissions`. No prompts, for
anything. An unattended queue can't stop and ask. Four things follow:

- **Point it at a repo you don't mind being changed while you're asleep.**
  Workers commit as they go, so `git log` is your audit trail and `git reset` is
  your undo.
- **`cq init` edits two of your files.** It appends the worker protocol to
  `CLAUDE.md` and `.cq/` to `.gitignore`. Skip the first with
  `cq init --no-claude-md`.
- **Workers can suggest new tasks.** The suggestion comes from a model that has
  read your context files, so text in a file can influence what gets queued. cq
  takes at most five, doesn't let those five suggest more, and queues them behind
  your own. Turn it off with `--no-recommend`.
- **Want prompts back?** `cq run --permission-mode acceptEdits` prompts for
  everything except file edits.

Ctrl-C once finishes the running task, then stops. Twice kills it; the next
`cq run` picks the task back up from its session.

## Checking on a run

```bash
cq status
```

```text
window
  five_hour  ████████████████████  100% used  resets in 47m
  seven_day  ███████░░░░░░░░░░░░░  34% used   resets in 2d 3h

state    PARKED
  parked: five_hour limit rejected the request
  resumes in 48m

queue    ✓ 5 done  ·  ⏸ 1 parked  ·  ? 1 blocked  ·  ◦ 3 queued

  ✓  t-001  Write ARCHITECTURE.md              opus    1/3  $0.42
  ✓  t-002  Screenshot + metrics harness       sonnet  1/3  $0.18
  …
  ⏸  t-006  Traffic: agents and pathfinding    sonnet  1/3  $0.21
  ?  t-007  Build tools: draw, zone, bulldoze  sonnet  —    —      after t-006

spend    $1.71 total
  $0.30 average per finished task · ~$1.50 to finish the remaining 5

1 decision waiting  — run `cq inbox`
```

## Commands

| Command | What it does |
|---|---|
| `cq init` | Create `.cq/`, add the worker rules to `CLAUDE.md` |
| `cq add "…"` | Queue a task. `-c` context files, `-d` depends on, `-m` model |
| `cq plan brief.md` | Turn a written brief into a task list |
| `cq run` | Work the queue until it's empty or parked |
| `cq status` | Queue, window, reset countdown, spend |
| `cq inbox` | Questions waiting on you. `cq inbox answer 1 "..."` |
| `cq logs t-001` | What a task actually did |
| `cq doctor` | Check the CLI, its flags, and your queue |
| `cq daemon` | `install`, `start`, `stop`, `status`, `uninstall` |

Run `cq --help`, or `cq <command> --help`, for the rest.

## How it works

```text
   pick next task
        │
        ▼
   claude -p  ──────────►  one fresh process, one task, small prompt
        │                  (stream-json parsed event by event)
        ▼
   what happened?
        │
        ├── done ─────────────► commit landed, summary stored, next task
        ├── needs a human ────► question to .cq/inbox.md, keep going
        ├── hit the turn cap ─► requeued with a hand-off note, never more turns
        ├── crashed ──────────► retry with backoff, max 3, then blocked dependents
        └── rate limited ─────► PARK ─► sleep to reset ─► resume via --resume
```

Start `cq run` with the window already gone and it parks straight away, then
waits. It never fires a task into a closed window.

Two things that catch people out:

**A warning doesn't kill the running task.** Killing it mid-flight wastes the
spend and can leave the tree half-edited, so cq finishes the task, commits, and
stops before starting another.

**A seven-day limit means sleeping for days.** cq parks, tells you once, and
waits. `cq status` shows the countdown, and the daemon comes back after a reboot.

State lives in `.cq/`, plain text, safe to edit between tasks:

| File | What's in it |
|---|---|
| `tasks.json` | The queue |
| `inbox.md` | Questions waiting on you |
| `status.json` | Window, park state, what you've spent |
| `logs/t-001.jsonl` | Full event stream per task |

## Cost and overhead

Each task is a new session, so each one pays a cold start. `claude -p "say ok"`
— two tokens in, five out — reports **$0.040467**. Forty tasks is about $1.60 of
overhead. One long session pays it once, so cq isn't cheaper per token. What you
get instead: per-task cost stays flat as the queue grows, a crash takes out one
task rather than the session, and every task ends in a commit.

Those dollar figures come from Claude Code's own accounting. On a subscription
they aren't a bill. They're the best proxy you have for how much window a task
ate. Sonnet is the default, Opus only when a task asks, and `cq status` shows
what your tasks actually cost.

## Tests

```bash
npm test    # 105 tests, none of them spend usage
```

Rate-limit paths run against a fake `claude` and a fake clock, so "parks for two
days, then resumes" is asserted in milliseconds.

## Docs

| Doc | What's in it |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Design, and where reality diverged from the plan |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Parked for a week · stuck task · editing `tasks.json` safely |
| [docs/RELEASING.md](docs/RELEASING.md) | How cq is distributed through Homebrew, and why |
| [examples/](examples/) | A real brief and the 20-task plan cq produced from it |
| [docs/STATUS.json](docs/STATUS.json) | What's tested, what's smoke-tested, what isn't |

## Status

v1.0. I use it on my own repos. Bug reports and agreed changes are welcome; read
[CONTRIBUTING.md](CONTRIBUTING.md) first, and use
[Discussions](https://github.com/hareware-labs/cq/discussions) for questions and ideas.
Security problems go through [SECURITY.md](SECURITY.md).

## Why "cq"

<pre>
-.-.  --.-    -.-.  --.-    -.-.  --.-
 C     Q       C     Q       C     Q
</pre>

In ham radio, CQ is the open call. You send it into an empty band and wait to see
who answers; when the band closes, you wait for it to reopen.

It also, conveniently, stands for Claude Queue. When a queue drains, cq signs off
with `73` — operator shorthand for "best regards".

## License

MIT
