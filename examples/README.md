# Worked example: a city builder

[`city-builder.prompt.md`](city-builder.prompt.md) is a real, ambitious brief — build a
Cities: Skylines II–class city builder, with multi-agent orchestration, critic gauntlets
and a `/loop` until every module passes. It is exactly the shape of prompt that eats a
five-hour window and produces a half-finished repo.

[`city-builder.tasks.json`](city-builder.tasks.json) is what `cq plan` returned from it,
verbatim:

```bash
cq plan examples/city-builder.prompt.md
```

**20 tasks. One Opus call. $0.91.**

```
  t-001  Write ARCHITECTURE.md                                 opus               1 file
  t-002  Vite app skeleton, core module registry and event bus       after t-001  10 files
  t-003  Headless screenshot + metrics harness                       after t-002  6 files
  t-004  Terrain module                                              after t-003  6 files
  t-005  Environment: sky, sun, weather and shadows                  after t-004  6 files
  t-006  Roads: graph, mesh generation and markings                  after t-005  6 files
  t-007  Simulation: economy, growth demand and time                 after t-006  7 files
  t-008  UI shell and HUD                                            after t-007  5 files
  t-009  Audio and post-processing effects                           after t-008  7 files
  t-010  Integration pass over wave one                              after t-009  8 files
  t-011  Zoning module                                               after t-010  7 files
  t-012  Buildings: procedural generation and PBR materials          after t-011  8 files
  t-013  Props: street furniture, vegetation and lighting            after t-012  8 files
  t-014  Traffic: agents, pathfinding and vehicle rendering          after t-013  9 files
  t-015  Build tools: road drawing, zoning and bulldoze              after t-014  9 files
  t-016  Integration pass over wave two                              after t-015  8 files
  t-017  Performance pass to budget                                  after t-016  5 files
  t-018  Demo city                                                   after t-017  10 files
  t-019  Art-direction review of the whole game (one round)   opus   after t-018  5 files
  t-020  Blind A/B comparison harness and README                     after t-019  6 files
```

Every task names its own `context_files` — 137 across the plan, no directory wildcards.
Two tasks request Opus: the architecture document and the single review. The other
eighteen run on Sonnet.

---

## What the planner rewrote

Four things in the brief came back changed. Here's each one, and why.

### 1. Parallel builder waves → a dependency chain

**The brief asked for:** *"Fan out. Use multi-agent orchestration ('ultracode'). One
builder agent per module… Run in waves ordered by dependency: (1) terrain, sky/weather,
roads, simulation, UI, audio, effects; (2) zoning, buildings, props, traffic, build
tools; (3) demo city."*

**The plan produced:** `t-004 → t-005 → t-006 → t-007 → t-008 → t-009`, strictly
sequential. Maximum dependency fan-in across the whole plan is **1**.

**Why:** seven agents don't finish seven times sooner. They share one usage window, so
they drain it seven times faster and then all park at once, mid-edit, in seven different
folders. The binding constraint is window capacity, not wall-clock. Running them in
order costs the same in total and leaves a clean commit at every boundary.

The brief's *ordering* was correct and was kept exactly. Only the concurrency was
dropped.

### 2. Four critic rounds → one review

**The brief asked for:** *"a separate critic agent… scores 0–10… Pass = ≥8.5 with zero
errors. Below that, the builder gets the ranked issue list and goes again, up to 4
rounds."* — for **every module**.

**The plan produced:** one task, `t-019`, marked `model: opus`.

**Why:** eleven modules times four rounds is up to 44 critic runs and 33 reworks, each
one re-screenshotting and re-reading the same code. That's several windows of spend for
the last few percent of polish. Rounds three and four mostly relitigate round two's
taste calls.

Note what `t-019` still does: it screenshots six camera presets at four times of day,
looks at every PNG, checks console errors and the fps budget, and scores against real
CS2 reference imagery on the brief's own scale. The rigour is all still there; only
the repetition went.

### 3. `/loop until every critic passes` → the supervisor's job

**The brief asked for:** *"/loop until every critic passes. Persist scores and open
issues to docs/STATUS.json so each iteration resumes from the weakest module."*

**The plan produced:** nothing. There is no loop task.

**Why:** that's what `cq` already does. When `t-019` reports issues, the supervisor
requeues the affected work with the reviewer's list as the new prompt: fresh session,
small context, specific problems. A worker running its own retry loop drags the whole
failed attempt along with it.

The brief's instinct was right — resume from the weakest module, not from scratch. `cq`
implements it in `tasks.json` rather than in a prompt.

### 4. Blind-judge stage → folded into the review

**The brief asked for:** *"blind judges get pairs of screenshots labelled only A and B
(ours vs. Cities: Skylines II, order shuffled) and say which looks better and why."*

**The plan produced:** `t-020`, which builds the comparison harness and documents it.

**Why:** the judging needs a human looking at shuffled pairs. An agent grading its own
output has the whole build in context, so calling it blind is wishful. The plan builds
the tool and hands it over instead of staging a ceremony nobody should trust the output
of.

### 5. Two additions the brief did not ask for

- **`t-002`, an app skeleton and module registry**, before any subsystem. The brief
  assumed parallel agents would each create their own entry point; sequential tasks need
  something to attach to.
- **`t-010` and `t-016`, integration passes** after each former "wave". The brief gave
  this job to an integrator agent between waves. With no waves, it becomes two ordinary
  queued tasks — same role, same position in the order.

---

## What this costs

| | |
|---|---|
| Planning (one Opus call, no tools) | **$0.91** |
| 18 Sonnet tasks + 1 Opus review | not run — this example ships the plan, not the game |

`cq status` reports the running average per finished task and projects the remainder, so
after three or four tasks you have a real number for what a queue of this shape costs —
before committing a window to it.

---

## Reproducing

```bash
cq plan examples/city-builder.prompt.md --dry-run
```

The planner is a language model, so you will not get this file byte-for-byte. What
should reproduce is the *shape*: architecture first, verification before features, a
sequential chain, one review round, and no loop.
