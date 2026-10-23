import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Queue, validateQueue, findCycles, nextId, selectNext, queueStall,
  blockDependents, makeTask, MAX_ATTEMPTS,
} from '../src/queue/index.js';
import { acquireLock, STALE_MS } from '../src/util/lock.js';
import { writeAtomic } from '../src/util/atomic.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'cq-q-'));
const q = (tasks, defaults = {}) => ({ version: 1, defaults, tasks: tasks.map(makeTask) });

test('validate catches the mistakes a human actually makes in tasks.json', () => {
  assert.deepEqual(validateQueue({ version: 2, tasks: [] }), ['version must be 1 (found 2)']);
  assert.deepEqual(validateQueue([]), ['tasks.json must be a JSON object']);
  const errs = validateQueue({ version: 1, tasks: [
    { id: 'a', prompt: 'x', status: 'runnning' },
    { id: 'a', prompt: '  ' },
    { id: 'b', prompt: 'x', depends_on: ['ghost'] },
    { id: 'c', prompt: 'x', context_files: 'src/a.js' },
  ] });
  assert.ok(errs.some((e) => /status "runnning"/.test(e)), 'typo in status is named');
  assert.ok(errs.some((e) => /duplicate/.test(e)));
  assert.ok(errs.some((e) => /non-empty prompt/.test(e)));
  assert.ok(errs.some((e) => /depends_on "ghost"/.test(e)));
  assert.ok(errs.some((e) => /context_files must be an array/.test(e)));
  assert.equal(validateQueue({ version: 1, tasks: [] }).length, 0);
});

test('dependency cycles are detected rather than hung on', () => {
  assert.deepEqual(findCycles([{ id: 'a', depends_on: ['b'] }, { id: 'b', depends_on: ['a'] }]),
    [['a', 'b', 'a']]);
  assert.equal(findCycles([{ id: 'a', depends_on: [] }, { id: 'b', depends_on: ['a'] }]).length, 0);
  assert.ok(validateQueue({ version: 1, tasks: [
    { id: 'a', prompt: 'x', depends_on: ['b'] }, { id: 'b', prompt: 'x', depends_on: ['a'] },
  ] }).some((e) => /cycle/.test(e)));
  // Self-dependency is a cycle too.
  assert.equal(findCycles([{ id: 'a', depends_on: ['a'] }]).length, 1);
});

test('nextId uses the highest existing number, not the count', () => {
  assert.equal(nextId([]), 't-001');
  assert.equal(nextId([{ id: 't-001' }, { id: 't-009' }]), 't-010');
  assert.equal(nextId([{ id: 'custom' }, { id: 't-003' }]), 't-004',
    'non-standard ids are ignored rather than crashing');
});

test('selection: parked first, then priority, then declaration order', () => {
  const data = q([
    { id: 'a', prompt: 'x', priority: 3 },
    { id: 'b', prompt: 'x', priority: 1 },
    { id: 'c', prompt: 'x', priority: 1 },
    { id: 'd', prompt: 'x', priority: 5, status: 'parked' },
  ]);
  assert.equal(selectNext(data).id, 'd', 'a live session beats a better priority');
  data.tasks[3].status = 'done';
  assert.equal(selectNext(data).id, 'b', 'lowest priority number wins');
  data.tasks[1].status = 'done';
  assert.equal(selectNext(data).id, 'c', 'ties break by declaration order, stably');
});

test('selection respects dependencies, attempts and backoff timers', () => {
  const data = q([
    { id: 'a', prompt: 'x', status: 'failed' },
    { id: 'b', prompt: 'x', depends_on: ['a'] },
    { id: 'c', prompt: 'x', attempts: MAX_ATTEMPTS },
    { id: 'd', prompt: 'x', retry_after_ms: 5000 },
  ]);
  assert.equal(selectNext(data, { now: 1000 }), null,
    'nothing is runnable: dep failed, attempts spent, backoff pending');
  assert.equal(selectNext(data, { now: 6000 }).id, 'd', 'once the backoff elapses it runs');
});

test('queueStall distinguishes the reasons a queue is not running', () => {
  assert.equal(queueStall(q([{ id: 'a', prompt: 'x', status: 'done' }])).kind, 'empty');
  assert.equal(queueStall(q([{ id: 'a', prompt: 'x', status: 'blocked' }])).kind, 'blocked');
  const backoff = queueStall(q([{ id: 'a', prompt: 'x', retry_after_ms: 9000 }]), { now: 1000 });
  assert.equal(backoff.kind, 'backoff');
  assert.equal(backoff.until, 9000, 'and says when to wake');
  assert.equal(queueStall(q([
    { id: 'a', prompt: 'x', status: 'failed' }, { id: 'b', prompt: 'x', depends_on: ['a'] },
  ])).kind, 'deps_unsatisfiable');
});

test('blockDependents is transitive and does not touch terminal tasks', () => {
  const data = q([
    { id: 'a', prompt: 'x', status: 'failed' },
    { id: 'b', prompt: 'x', depends_on: ['a'] },
    { id: 'c', prompt: 'x', depends_on: ['b'] },
    { id: 'd', prompt: 'x', status: 'done', depends_on: ['a'] },
    { id: 'e', prompt: 'x' },
  ]);
  const blocked = blockDependents(data, 'a', 'a failed');
  assert.deepEqual(blocked.sort(), ['b', 'c']);
  assert.equal(data.tasks.find((t) => t.id === 'd').status, 'done', 'finished work is left alone');
  assert.equal(data.tasks.find((t) => t.id === 'e').status, 'queued', 'unrelated work is untouched');
});

test('the queue file survives a hand-edit and rejects an invalid write', () => {
  const dir = scratch();
  const queue = new Queue(dir);
  queue.init();
  queue.addTask({ title: 'one', prompt: 'do one' });
  queue.addTask({ title: 'two', prompt: 'do two' });

  // A human edits the file between operations.
  const raw = JSON.parse(readFileSync(queue.paths.tasks, 'utf8'));
  raw.tasks[0].priority = 9;
  writeFileSync(queue.paths.tasks, JSON.stringify(raw, null, 2));
  assert.equal(queue.get('t-001').priority, 9, 'the edit is read back, not clobbered');

  assert.throws(() => queue.write({ version: 1, tasks: [{ id: 'x', prompt: '' }] }),
    /refusing to write an invalid queue/);
});

test('a corrupt queue file fails loudly with a pointer to the file', () => {
  const dir = scratch();
  const queue = new Queue(dir);
  queue.init();
  writeFileSync(queue.paths.tasks, '{ not json');
  assert.throws(() => queue.read(), (e) => e.code === 'EBADQUEUE' && /is not valid JSON/.test(e.message));
  assert.throws(() => new Queue(scratch()).read(), (e) => e.code === 'ENOQUEUE' && /cq init/.test(e.message));
});

test('writes are atomic: no temp file is left behind and content is complete', () => {
  const dir = scratch();
  const p = join(dir, 'x.json');
  writeAtomic(p, '{"a":1}');
  assert.equal(readFileSync(p, 'utf8'), '{"a":1}');
  assert.deepEqual(readdirSync(dir), ['x.json'], 'the .tmp file was renamed, not orphaned');
});

test('the lock excludes a second holder and is broken only when genuinely stale', () => {
  const dir = scratch();
  const p = join(dir, 'lock');
  const a = acquireLock(p);
  assert.equal(a.broke, null);
  assert.throws(() => acquireLock(p), (e) => e.code === 'ELOCKED' && /delete/.test(e.message),
    'and tells the user how to recover');
  a.release();

  // A lock held by a dead pid is broken.
  writeFileSync(p, JSON.stringify({ pid: 999999, host: 'gone', acquired_at: Date.now() }));
  const b = acquireLock(p);
  assert.match(b.broke.reason, /not running/);
  b.release();

  // A lock held by a live pid but far too old is broken.
  writeFileSync(p, JSON.stringify({ pid: process.pid, host: 'x', acquired_at: Date.now() - STALE_MS - 1 }));
  const c = acquireLock(p);
  assert.match(c.broke.reason, /held for over/);
  c.release();
});

test('release does not delete a lock that now belongs to someone else', () => {
  const dir = scratch();
  const p = join(dir, 'lock');
  const a = acquireLock(p);
  writeFileSync(p, JSON.stringify({ pid: 4242, host: 'other', acquired_at: Date.now() }));
  a.release();
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).pid, 4242, "someone else's lock survived");
});
