# Goal
Build a Cities: Skylines II–class city builder in Three.js (latest release) + Vite, plain ES modules, from this empty folder. The bar is AAA: photographic PBR materials, physically plausible sun/sky/shadows, atmospheric depth, a living city at night, believable roads and traffic. Never programmer art.
# How to work
1. Architecture first. Before any feature code, write ARCHITECTURE.md: one folder per subsystem (terrain, environment, roads, zoning, buildings, props, traffic, effects, simulation, tools, ui, audio, demo city), a shared world data model, the public API each module must expose, the events it emits, units (metres, +Y up), determinism (seeded RNG only), a performance budget (≥50 fps at 1080p, ≤1500 draw calls) and an asset policy (CC0 only: Poly Haven, ambientCG, or procedural). Isolate module failures so one broken module never takes the game down.
2. Build the verification loop before the game. A headless-Chrome screenshot tool that loads the app, waits until ready, sets a camera preset and time of day, and writes PNG + a JSON log (console errors, fps, draw calls). Every module also ships a "showcase" mode that stages a representative scene of just that module. No agent may claim anything it hasn't screenshotted and looked at.
3. Fan out. Use multi-agent orchestration ("ultracode"). One builder agent per module, each owning only its folder. Run in waves ordered by dependency: (1) terrain, sky/weather, roads, simulation, UI, audio, effects; (2) zoning, buildings, props, traffic, build tools; (3) demo city. Between waves, one integrator agent (the only one allowed to touch core) applies builders' core-change requests and fixes the seams.
4. Gauntlet every module. After each builder round, a separate critic agent (a brutal AAA art director who writes no code) takes its own screenshots at several times of day and zoom levels, checks the API contract, console errors and perf, and scores 0–10 against real Cities: Skylines II reference screenshots: 10 = indistinguishable, 8.5 = AAA with nits, 7 = good indie, 5 = programmer art. Pass = ≥8.5 with zero errors. Below that, the builder gets the ranked issue list and goes again, up to 4 rounds.
5. Final gate. A whole-game critic scores the demo city. Then blind judges get pairs of screenshots labelled only A and B (ours vs. Cities: Skylines II, order shuffled) and say which looks better and why.
6. /loop until every critic passes. Persist scores and open issues to docs/STATUS.json so each iteration resumes from the weakest module, not from scratch.
# Rules
- Never inflate scores. Report real numbers, failed rounds and what is still missing.
- Never edit another module's folder. Core changes go through the integrator.
- Keep the dev server running and the app loadable at all times; other agents are screenshotting it.
- Do not ask me questions. Make routine decisions yourself, state assumptions, keep going.
Start now.
