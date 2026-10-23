import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Scheduler } from '../src/scheduler/index.js';
import { harness, fakeClock, collectLogs, collectNotify, CAPS, ANCHORS } from './helpers.js';

/** Build a scheduler wired to fake time, fake CLI and captured output. */
function sched(h, opts = {}) {
  const clock = fakeClock();
  const log = collectLogs();
  const notify = collectNotify();
  const s = new Scheduler(h.root, {
    bin: h.bin, caps: CAPS, log, notify,
    now: clock.now, sleep: clock.sleep,
    maxIterations: opts.maxIterations ?? 20,
    // The real runner spawns the fake CLI; only the clock is faked.
    runTask: async (task, o) => (await import('../src/runner/index.js'))
      .runTask(task, { ...o, env: h.env }),
    ...opts,
  });
  return { s, clock, log, notify };
}

test('a successful task goes to done, records spend, and ingests recommendations', async () => {
  const h = harness({ tasks: [{ title: 'first' }], steps: [{ fixture: 'success.jsonl', exit: 0 }] });
  // `once` stops after one task, so the ledger assertions below describe exactly one run.
  const { s, log } = sched(h, { once: true });
  await s.run();

  const t = h.task('t-001');
  assert.equal(t.status, 'done');
  assert.equal(t.session_id, 'sess-ok');
  assert.match(t.result_summary, /What changed/);

  const st = h.status();
  assert.equal(st.spend.by_task['t-001'].usd, 0.0123, 'cost from the result event');
  assert.equal(st.spend.by_task['t-001'].turns, 4);
  assert.equal(st.spend.total_usd, 0.0123);
  assert.equal(st.window.five_hour.utilization, 0.16, 'window utilization is tracked');

  // The fixture's summary recommends one follow-up task.
  const added = h.tasks().find((x) => x.recommended_by === 't-001');
  assert.ok(added, 'recommended task was ingested');
  assert.equal(added.priority, 3, 'recommendations queue behind the human ordering');
  assert.ok(log.has(/done \$0\.0123/));
});

test('rejected -> PARKED, sleeps to the reset, then resumes with --resume', async () => {
  const h = harness({
    tasks: [{ title: 'work' }],
    steps: [{ fixture: 'rejected.jsonl', exit: 1 }, { fixture: 'success.jsonl', exit: 0 }],
  });
  const { s, clock, log } = sched(h);
  await s.run();

  assert.equal(h.task('t-001').status, 'done', 'finished after the window reopened');

  const slept = clock.total();
  const expected = ANCHORS.five_hour_ms + 60_000 - ANCHORS.now_ms;
  assert.equal(slept, expected, 'slept exactly to resets_at + 60s grace');

  const [first, second] = h.invocations();
  assert.ok(!first.argv.includes('--resume'), 'first run is fresh');
  assert.ok(second.argv.includes('--resume'), 'second run resumes');
  assert.equal(second.argv[second.argv.indexOf('--resume') + 1], 'sess-park',
    'resumes the session the parked run reported');
  assert.ok(log.has(/rate limited/) && log.has(/window reset; resuming/));
});

test('a parked task is not charged an attempt', async () => {
  const h = harness({
    tasks: [{ title: 'work' }],
    steps: [{ fixture: 'rejected.jsonl', exit: 1 }, { fixture: 'rejected.jsonl', exit: 1 },
            { fixture: 'success.jsonl', exit: 0 }],
  });
  const { s } = sched(h);
  await s.run();
  assert.equal(h.task('t-001').status, 'done',
    'three runs, two of them interrupted, still completes — a park is not a failure');
});

test('allowed_warning finishes the current task then parks before the next', async () => {
  const h = harness({
    tasks: [{ title: 'one' }, { title: 'two' }],
    // warning.jsonl and weird.jsonl carry no `Recommended tasks` block, so the queue
    // is exactly the two tasks declared here.
    steps: [{ fixture: 'warning.jsonl', exit: 0 }, { fixture: 'weird.jsonl', exit: 0 }],
  });
  const { s, clock, log } = sched(h, { maxIterations: 4 });
  await s.run();

  assert.equal(h.task('t-001').status, 'done', 'the running task was allowed to finish');
  assert.equal(h.task('t-002').status, 'done', 'the next one ran only after the window reset');
  assert.ok(log.has(/will park after this task/));
  assert.ok(log.has(/parking before starting the next task/));
  assert.ok(clock.total() > 0, 'it actually slept between the two');

  const inv = h.invocations();
  assert.equal(inv.length, 2, 'exactly two runs — no third attempt into a closed window');
});

test('a seven-day park notifies, naps in capped chunks, and still waits it out', async () => {
  const h = harness({
    tasks: [{ title: 'work' }],
    steps: [{ fixture: 'seven-day.jsonl', exit: 1 }, { fixture: 'weird.jsonl', exit: 0 }],
  });
  const { s, clock, notify, log } = sched(h, { maxIterations: 30 });
  await s.run();

  assert.equal(h.task('t-001').status, 'done');
  assert.ok(notify.sent.length >= 1, 'the user is told about a multi-day park');
  assert.match(notify.sent[0].message, /seven_day/);

  assert.ok(clock.naps.length > 1, 'napped repeatedly rather than sleeping for days at once');
  assert.ok(clock.naps.every((n) => n <= 8 * 3600_000), 'every nap respects the cap');
  assert.equal(clock.total(), ANCHORS.seven_day_ms + 60_000 - ANCHORS.now_ms,
    'total sleep still lands on the reset');
  assert.ok(log.has(/parked \(seven_day\)/));
});

test('a crash is a task failure, never a daemon failure; retried then retired', async () => {
  const h = harness({
    tasks: [{ title: 'crasher' }],
    defaultStep: { fixture: 'crash.jsonl', exit: 139, stderr: 'Segmentation fault\n' },
  });
  const { s, log, notify } = sched(h, { maxIterations: 12 });
  const outcome = await s.run();

  const t = h.task('t-001');
  assert.equal(t.status, 'failed');
  assert.equal(t.attempts, 3, 'exactly max attempts, no more');
  assert.match(t.last_error, /exit 139/);
  assert.match(t.last_error, /Segmentation fault/, 'stderr tail is kept for the post-mortem');
  assert.equal(h.invocations().length, 3);
  assert.ok(log.has(/failed permanently/));
  assert.ok(notify.sent.some((n) => /task failed/i.test(n.title)));
  assert.equal(outcome.reason, 'empty', 'the loop exited cleanly, it did not throw');
});

test('backoff is served between failed attempts', async () => {
  const h = harness({ tasks: [{ title: 'flaky' }],
    defaultStep: { fixture: 'crash.jsonl', exit: 1, stderr: 'boom' } });
  const { s, clock } = sched(h, { maxIterations: 12 });
  await s.run();
  // 30s then 2m, jittered +/-10%.
  assert.ok(clock.total() >= 135_000 && clock.total() <= 165_000,
    `waited roughly 30s + 2m, got ${clock.total()}ms`);
});

test('max_turns requeues once with a hand-off instead of extending the budget', async () => {
  const h = harness({
    tasks: [{ title: 'too big' }],
    steps: [{ fixture: 'max-turns.jsonl', exit: 1 }, { fixture: 'success.jsonl', exit: 0 }],
  });
  const { s, log } = sched(h);
  await s.run();

  assert.equal(h.task('t-001').status, 'done');
  const [first, second] = h.invocations();
  const turnsOf = (inv) => inv.argv[inv.argv.indexOf('--max-turns') + 1];
  assert.equal(turnsOf(first), '40');
  assert.equal(turnsOf(second), '40', 'the retry gets the same cap, never a bigger one');
  assert.match(second.argv.at(-1), /Hand-off from your previous attempt/,
    'the retry prompt carries the hand-off note');
  assert.match(second.argv.at(-1), /sess-mt/, 'including the previous session id');
  assert.ok(log.has(/requeued with a hand-off/));
});

test('a task that keeps hitting the turn cap is retired, not looped forever', async () => {
  const h = harness({ tasks: [{ title: 'endless' }],
    defaultStep: { fixture: 'max-turns.jsonl', exit: 1 } });
  const { s } = sched(h, { maxIterations: 12 });
  await s.run();
  assert.equal(h.task('t-001').status, 'failed');
  assert.equal(h.invocations().length, 3);
});

test('a non-zero exit with a limit signature parks instead of burning retries', async () => {
  const h = harness({
    tasks: [{ title: 'work' }],
    steps: [
      { fixture: 'limit-exit.jsonl', exit: 1, stderr: 'Claude usage limit reached. Try again later.\n' },
      { fixture: 'success.jsonl', exit: 0 },
    ],
  });
  const { s, clock } = sched(h, { maxIterations: 8 });
  await s.run();

  assert.equal(h.task('t-001').status, 'done');
  assert.equal(h.task('t-001').attempts, 1, 'the parked run was not charged an attempt');
  assert.equal(clock.total(), 15 * 60_000,
    'with no reset time it waits a fixed conservative interval rather than spinning');
  assert.equal(h.status().park, null, 'the park is cleared once it resumes');
});

test('dependencies gate execution and run in order', async () => {
  const h = harness({
    tasks: [
      { id: 't-001', title: 'base' },
      { id: 't-002', title: 'dependent', depends_on: ['t-001'], priority: 1 },
    ],
    defaultStep: { fixture: 'weird.jsonl', exit: 0 },
  });
  const { s } = sched(h);
  await s.run();
  const order = h.invocations().map((i) => /Task (t-\d+)/.exec(i.argv.at(-1))[1]);
  assert.deepEqual(order, ['t-001', 't-002'],
    'the dependency ran first despite t-002 having a better priority');
});

test('a failed task blocks its dependents transitively instead of running them', async () => {
  const h = harness({
    tasks: [
      { id: 't-001', title: 'base' },
      { id: 't-002', title: 'mid', depends_on: ['t-001'] },
      { id: 't-003', title: 'leaf', depends_on: ['t-002'] },
    ],
    defaultStep: { fixture: 'crash.jsonl', exit: 1, stderr: 'boom' },
  });
  const { s } = sched(h, { maxIterations: 12 });
  await s.run();

  assert.equal(h.task('t-001').status, 'failed');
  assert.equal(h.task('t-002').status, 'blocked');
  assert.equal(h.task('t-003').status, 'blocked', 'blocking is transitive');
  assert.equal(h.invocations().length, 3, 'only t-001 ran, three times — no doomed runs');
  assert.match(h.inbox(), /t-002/, 'the human is told why');
});

test('a worker escalation lands in the inbox without blocking the task', async () => {
  const h = harness({ tasks: [{ title: 'work' }], steps: [{ fixture: 'needs-human.jsonl', exit: 0 }] });
  const { s } = sched(h);
  await s.run();

  assert.equal(h.task('t-001').status, 'done', 'it finished what it could');
  assert.match(h.inbox(), /Which auth provider/);
  assert.deepEqual(h.task('t-001').needs_human, ['Which auth provider should the adapter target?']);
});

test('answering an inbox question unblocks the task and reaches the prompt', async () => {
  const h = harness({
    tasks: [{ id: 't-001', title: 'work', status: 'blocked', needs_human: ['Which provider?'] }],
    steps: [{ fixture: 'success.jsonl', exit: 0 }],
  });
  writeFileSync(join(h.root, '.cq', 'inbox.md'),
    '# cq inbox\n\n## Needs human\n- [x] t-001: Which provider?\n  > Use Auth0.\n');

  const { s } = sched(h);
  await s.run();

  assert.equal(h.task('t-001').status, 'done');
  const prompt = h.invocations()[0].argv.at(-1);
  assert.match(prompt, /Decision from the human/);
  assert.match(prompt, /Use Auth0\./, 'the answer is prepended to the prompt');
});

test('a queue blocked on a human stops cleanly and says so', async () => {
  const h = harness({ tasks: [{ id: 't-001', status: 'blocked', needs_human: ['?'] }] });
  const { s, log } = sched(h);
  const outcome = await s.run();
  assert.equal(outcome.reason, 'blocked');
  assert.equal(h.invocations().length, 0, 'nothing was spent');
  assert.ok(log.has(/cq inbox/), 'and it tells the user what to run');
});

test('a task left running by a crashed daemon is reconciled, not abandoned', async () => {
  const h = harness({
    tasks: [{ id: 't-001', status: 'running', attempts: 1, session_id: 'sess-prev' }],
    steps: [{ fixture: 'success.jsonl', exit: 0 }],
  });
  const { s, log } = sched(h);
  await s.run();

  assert.equal(h.task('t-001').status, 'done');
  assert.equal(h.task('t-001').attempts, 2, 'the crash cost one attempt, not three');
  assert.ok(h.invocations()[0].argv.includes('--resume'),
    'it resumed the half-finished session rather than paying to redo it');
  assert.ok(log.has(/reconciled 1 task/));
  assert.equal(h.status().reconciled.at(-1).tasks[0], 't-001');
});

test('a persisted park survives a restart and is honoured', async () => {
  const h = harness({ tasks: [{ title: 'work' }], steps: [{ fixture: 'success.jsonl', exit: 0 }] });
  writeFileSync(join(h.root, '.cq', 'status.json'), JSON.stringify({
    version: 1, state: 'PARKED',
    park: { reason: 'five_hour limit', rate_limit_type: 'five_hour', kind: 'short',
            resets_at_ms: ANCHORS.five_hour_ms, detected_by: 'rate_limit_event' },
    spend: { total_usd: 0, by_window: {}, by_task: {} },
  }));

  const { s, clock } = sched(h);
  await s.run();
  assert.equal(clock.total(), ANCHORS.five_hour_ms + 60_000 - ANCHORS.now_ms,
    'a restarted daemon resumes the sleep instead of firing into a closed window');
  assert.equal(h.task('t-001').status, 'done');
});

test('--force overrides a persisted park', async () => {
  const h = harness({ tasks: [{ title: 'work' }], steps: [{ fixture: 'success.jsonl', exit: 0 }] });
  writeFileSync(join(h.root, '.cq', 'status.json'), JSON.stringify({
    version: 1, state: 'PARKED',
    park: { reason: 'x', rate_limit_type: 'five_hour', kind: 'short',
            resets_at_ms: ANCHORS.five_hour_ms, detected_by: 'rate_limit_event' },
    spend: { total_usd: 0, by_window: {}, by_task: {} },
  }));
  const { s, clock, log } = sched(h, { force: true });
  await s.run();
  assert.equal(clock.total(), 0, 'no sleep');
  assert.ok(log.has(/ignoring the persisted park/));
});

test('the queue is re-read between tasks, so a hand-edit takes effect', async () => {
  const h = harness({ tasks: [{ id: 't-001' }, { id: 't-002' }],
    defaultStep: { fixture: 'weird.jsonl', exit: 0 } });
  const { s } = sched(h, {
    runTask: async (task, o) => {
      if (task.id === 't-001') {
        // Simulate a human editing tasks.json while t-001 runs.
        const p = join(h.root, '.cq', 'tasks.json');
        const d = JSON.parse(readFileSync(p, 'utf8'));
        d.tasks.find((t) => t.id === 't-002').status = 'done';
        writeFileSync(p, JSON.stringify(d));
      }
      return (await import('../src/runner/index.js')).runTask(task, { ...o, env: h.env });
    },
  });
  await s.run();
  assert.equal(h.invocations().length, 1, 't-002 was skipped because the file said so');
});

test('cq always passes an explicit model and never inherits the ambient default', async () => {
  const h = harness({ tasks: [{ title: 'a' }, { title: 'b', model: 'opus' }],
    defaultStep: { fixture: 'weird.jsonl', exit: 0 } });
  const { s } = sched(h);
  await s.run();
  const models = h.invocations().map((i) => i.argv[i.argv.indexOf('--model') + 1]);
  assert.deepEqual(models, ['sonnet', 'opus'],
    'default is sonnet; opus only where the task asked for it');
  for (const inv of h.invocations()) {
    assert.ok(inv.argv.includes('--verbose'), '--verbose is required with stream-json');
    assert.ok(inv.argv.includes('--max-budget-usd'), 'a money backstop is always set');
  }
});

test('unknown event types and malformed lines do not derail a run', async () => {
  const h = harness({ tasks: [{ title: 'weird' }],
    steps: [{ fixture: 'weird.jsonl', exit: 0, stdout_extra: 'not json at all\n{"broken":\n' }] });
  const { s } = sched(h);
  await s.run();
  assert.equal(h.task('t-001').status, 'done', 'survived garbage on stdout');
});

test('the full raw stream is kept per task for post-mortems', async () => {
  const h = harness({ tasks: [{ title: 'work' }], steps: [{ fixture: 'success.jsonl', exit: 0 }] });
  const { s } = sched(h);
  await s.run();
  const log = readFileSync(join(h.root, '.cq', 'logs', 't-001.jsonl'), 'utf8');
  assert.match(log, /cq_run_start/, 'annotated with what cq invoked');
  assert.match(log, /experimental_bucket/, 'unknown fields survive into the log');
  assert.match(log, /"type":"result"/);
});

test('an internal runner bug is contained as a task failure', async () => {
  const h = harness({ tasks: [{ title: 'work' }] });
  const { s, log } = sched(h, {
    maxIterations: 6,
    runTask: async () => { throw new Error('runner exploded'); },
  });
  const outcome = await s.run();
  assert.equal(h.task('t-001').status, 'failed');
  assert.match(h.task('t-001').last_error, /runner exploded/);
  assert.equal(outcome.reason, 'empty', 'the daemon survived and exited cleanly');
});

test('recommended tasks cannot themselves recommend tasks, so the queue cannot run away', async () => {
  // success.jsonl always ends with a `Recommended tasks` block. Without a depth bound
  // this queue never drains: every run adds another task that adds another.
  const h = harness({ tasks: [{ title: 'seed' }],
    defaultStep: { fixture: 'success.jsonl', exit: 0 } });
  const { s, log } = sched(h, { maxIterations: 50 });
  const outcome = await s.run();

  assert.equal(outcome.reason, 'empty', 'the queue actually drained');
  assert.ok(log.has(/73/), 'and signs off');
  assert.equal(h.tasks().length, 2, 'the seed plus exactly one generation of follow-up');
  assert.equal(h.task('t-002').recommend_depth, 1);
  assert.ok(log.has(/it was itself a recommendation/),
    'and the dropped second generation is reported, not silently swallowed');
});

test('a single worker cannot queue more than the width cap', async () => {
  const many = { tasks: Array.from({ length: 12 }, (_, i) => ({ title: `x${i}`, prompt: `do x${i}` })) };
  const h = harness({ tasks: [{ title: 'seed' }], steps: [{ fixture: 'wide.jsonl', exit: 0 }] });
  writeFileSync(join(h.root, 'wide-unused'), '');
  // Build the fixture inline so the cap is exercised without a checked-in 12-task file.
  const base = readFileSync(join(new URL('./fixtures/', import.meta.url).pathname, 'success.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  base.at(-1).result = '## Recommended tasks\n```json\n' + JSON.stringify(many) + '\n```';
  writeFileSync(join(h.fake, 'wide.jsonl'), base.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const { s, log } = sched(h, { maxIterations: 30, caps: CAPS });
  s.opts.runTask = async (task, o) => (await import('../src/runner/index.js'))
    .runTask(task, { ...o, env: { ...h.env, CQ_FAKE_FIXTURES: h.fake } });
  await s.run();

  const added = h.tasks().filter((t) => t.recommended_by === 't-001');
  assert.equal(added.length, 5, 'capped at MAX_RECOMMENDED_PER_TASK');
  assert.ok(log.has(/kept 5 of 12/), 'and says what it dropped');
});

test('--parallel runs tasks concurrently, up to the limit', async () => {
  const h = harness({ tasks: [{ id: 't-001' }, { id: 't-002' }, { id: 't-003' }, { id: 't-004' }],
    defaultStep: { fixture: 'weird.jsonl', exit: 0 } });

  let live = 0, peak = 0;
  const { s } = sched(h, {
    parallel: 2,
    runTask: async (task, o) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 30));
      try { return await (await import('../src/runner/index.js')).runTask(task, { ...o, env: h.env }); }
      finally { live--; }
    },
  });
  await s.run();

  assert.equal(peak, 2, 'exactly two ran at once — the pool was filled and respected');
  assert.equal(h.tasks().filter((t) => t.status === 'done').length, 4, 'and all four finished');
});

test('parallel is capped by dependencies, not just by N', async () => {
  const h = harness({
    tasks: [{ id: 't-001' }, { id: 't-002', depends_on: ['t-001'] }, { id: 't-003', depends_on: ['t-002'] }],
    defaultStep: { fixture: 'weird.jsonl', exit: 0 },
  });
  let live = 0, peak = 0;
  const { s } = sched(h, {
    parallel: 4,
    runTask: async (task, o) => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      try { return await (await import('../src/runner/index.js')).runTask(task, { ...o, env: h.env }); }
      finally { live--; }
    },
  });
  await s.run();
  assert.equal(peak, 1, 'a dependency chain stays sequential however high N is');
  assert.equal(h.tasks().filter((t) => t.status === 'done').length, 3);
});

test('a park waits for in-flight parallel work instead of abandoning it', async () => {
  const h = harness({
    tasks: [{ id: 't-001' }, { id: 't-002' }],
    // t-001 is rejected; t-002 is already running and must still be allowed to land.
    steps: [{ fixture: 'rejected.jsonl', exit: 1 }, { fixture: 'weird.jsonl', exit: 0 },
            { fixture: 'weird.jsonl', exit: 0 }],
  });
  const { s, clock } = sched(h, { parallel: 2, maxIterations: 20 });
  await s.run();

  assert.equal(h.task('t-002').status, 'done', 'work already paid for was not thrown away');
  assert.equal(h.task('t-001').status, 'done', 'and the parked task resumed after the reset');
  assert.ok(clock.total() > 0, 'it did park');
});

test('cq run --parallel actually reaches the scheduler', async () => {
  // Regression: the CLI parsed --parallel, printed the burn-rate warning, and then
  // never passed it to the Scheduler, so it always ran sequentially.
  const src = readFileSync(new URL('../src/cli/index.js', import.meta.url), 'utf8');
  const runBlock = src.slice(src.indexOf("program.command('run')"), src.indexOf("program.command('status')"));
  assert.match(runBlock, /parallel:\s*opts\.parallel/,
    'the run command must pass parallel through to the Scheduler');
});

test('a park found by the last concurrent run is still persisted', async () => {
  // Regression: #drain discarded outcomes, so a park detected while draining was lost
  // and status.json never recorded it.
  const h = harness({
    tasks: [{ id: 't-001' }, { id: 't-002' }],
    steps: [{ fixture: 'weird.jsonl', exit: 0, delay_ms: 30 },
            { fixture: 'rejected.jsonl', exit: 1 }],
  });
  // One iteration only: both tasks start, one is rejected, and the loop exits with the
  // other still in flight — so the park must survive the final drain.
  const { s } = sched(h, { parallel: 2, maxIterations: 1 });
  await s.run();
  const st = h.status();
  assert.ok(st.park, 'the park survived the drain');
  assert.equal(st.park.rate_limit_type, 'five_hour');
  assert.equal(h.invocations().length, 2, 'both tasks really did run concurrently');
});

test('an exit-signature park shows no countdown instead of one from 1970', async () => {
  const h = harness({
    tasks: [{ title: 'work' }],
    steps: [{ fixture: 'limit-exit.jsonl', exit: 1, stderr: 'Claude usage limit reached\n' }],
  });
  const { s } = sched(h, { once: true });
  await s.run();
  assert.equal(h.status().park.resets_at_ms, null, 'no reset time is known');

  const out = execFileSync(process.execPath,
    [fileURLToPath(new URL('../bin/cq.js', import.meta.url)), 'status'],
    { cwd: h.root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.match(out, /no reset time was reported/);
  assert.doesNotMatch(out, /1970|-\d{5,}/, 'never renders an epoch countdown');
});

test('cq status reports a passed window as stale rather than counting down to it', () => {
  // A reset time in the past means the window already refilled, so the utilization we
  // recorded describes a window that no longer exists. Reporting "34% used, resets now"
  // was actively misleading after a few days idle.
  const h = harness({ tasks: [{ id: 't-001', title: 'x' }] });
  const old = Date.now() - 4 * 24 * 3600_000;
  writeFileSync(join(h.root, '.cq', 'status.json'), JSON.stringify({
    version: 1, state: 'IDLE', updated_at: old,
    window: { five_hour: { utilization: 0.34, resets_at_ms: old + 3600_000 } },
    spend: { total_usd: 0, by_window: {}, by_task: {} },
  }));

  const out = execFileSync(process.execPath,
    [fileURLToPath(new URL('../bin/cq.js', import.meta.url)), 'status'],
    { cwd: h.root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

  assert.match(out, /refilled since the last run/);
  assert.doesNotMatch(out, /34% used/, 'a stale reading is not presented as current');
  assert.doesNotMatch(out, /resets now/, 'and it does not count down to a reset that already happened');
  assert.match(out, /nothing running — start it with/, 'idle with queued work says what to do');
});
