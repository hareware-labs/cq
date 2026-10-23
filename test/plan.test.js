import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPlan, normalizePlan, buildPlanPrompt, PLAN_RULES } from '../src/plan/index.js';
import { validateQueue } from '../src/queue/index.js';

test('extracts a plan from a fence, from bare JSON, and from prose', () => {
  const obj = { tasks: [{ id: 'a', prompt: 'do a' }] };
  const json = JSON.stringify(obj);
  assert.deepEqual(extractPlan(json), obj);
  assert.deepEqual(extractPlan('```json\n' + json + '\n```'), obj);
  assert.deepEqual(extractPlan('```\n' + json + '\n```'), obj);
  assert.deepEqual(extractPlan(`Sure! Here is the plan:\n${json}\nLet me know.`), obj);
  assert.equal(extractPlan('no json here'), null);
  assert.equal(extractPlan('{"notTasks":1}'), null, 'an object without tasks is not a plan');
});

test('renumbers ids densely and remaps dependencies through the rename', () => {
  const { queue } = normalizePlan({ tasks: [
    { id: 'setup', prompt: 'a' },
    { id: 'build', prompt: 'b', depends_on: ['setup'] },
    { id: 'test', prompt: 'c', depends_on: ['build', 'setup'] },
  ] });
  assert.deepEqual(queue.tasks.map((t) => t.id), ['t-001', 't-002', 't-003']);
  assert.deepEqual(queue.tasks[2].depends_on, ['t-002', 't-001']);
  assert.equal(validateQueue(queue).length, 0);
});

test('repairs the mistakes a planner actually makes, and reports each one', () => {
  const { queue, notes } = normalizePlan({
    defaults: { model: 'sonnet', max_turns: 500 },
    tasks: [
      { id: 'a', prompt: 'a', depends_on: ['a', 'ghost'] },
      { id: 'b', prompt: 'b', depends_on: ['c'], max_turns: 900, model: 'gpt-4' },
      { id: 'c', prompt: 'c', priority: 99 },
      { id: 'd', prompt: '   ' },
    ],
  });
  assert.equal(queue.defaults.max_turns, 40);
  assert.deepEqual(queue.tasks[0].depends_on, [], 'self and dangling deps dropped');
  assert.deepEqual(queue.tasks[1].depends_on, [], 'a forward dependency is dropped');
  assert.equal(queue.tasks[1].max_turns, 40);
  assert.equal(queue.tasks[1].model, null, 'an unknown model falls back to the default');
  assert.equal(queue.tasks[2].priority, 5, 'priority is clamped to 1..5');
  assert.equal(queue.tasks.length, 3, 'the empty-prompt task is dropped');
  for (const re of [/self-dependency/, /unknown "ghost"/, /forward dependency/,
                    /clamped max_turns/, /ignored unknown model/, /no prompt/]) {
    assert.ok(notes.some((n) => re.test(n)), `reported: ${re}`);
  }
});

test('forward-only dependencies make a cycle impossible by construction', () => {
  const { queue } = normalizePlan({ tasks: [
    { id: 'a', prompt: 'a', depends_on: ['b'] },
    { id: 'b', prompt: 'b', depends_on: ['a'] },
  ] });
  assert.equal(validateQueue(queue).length, 0, 'no cycle survived');
  assert.deepEqual(queue.tasks[0].depends_on, []);
  assert.deepEqual(queue.tasks[1].depends_on, ['t-001']);
});

test('the planning prompt bans the shapes that burn a window', () => {
  for (const re of [/No parallel waves/, /One review round, not four/,
                    /No "loop until it passes"/, /Architecture first/,
                    /<= 40 turns/, /Verification early/]) {
    assert.match(PLAN_RULES, re);
  }
  const p = buildPlanPrompt('Build a thing.');
  assert.match(p, /Build a thing\./);
  assert.match(p, /Return only the JSON object/);
});

test('an over-eager Opus request is flagged rather than silently accepted', () => {
  const { notes } = normalizePlan({ tasks: Array.from({ length: 4 }, (_, i) =>
    ({ id: `t${i}`, prompt: 'x', model: 'opus' })) });
  assert.ok(notes.some((n) => /request Opus/.test(n)));
});
