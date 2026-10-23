import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox, parseInbox, extractNeedsHuman } from '../src/inbox/index.js';
import { notify, makeNotifier } from '../src/notify/index.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'cq-ib-'));

test('parses entries, answers, and multi-line answers', () => {
  const entries = parseInbox(`## Needs human
- [ ] t-001: Which database?
  > 
- [x] t-002: Delete the legacy table?
  > Yes, but keep a dump first.
  > The dump goes in backups/.
`);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].answered, false);
  assert.equal(entries[1].answered, true);
  assert.equal(entries[1].answer, 'Yes, but keep a dump first.\nThe dump goes in backups/.');
});

test('an answer without a ticked box still counts as answered', () => {
  const [e] = parseInbox('- [ ] t-001: Which database?\n  > Postgres.\n');
  assert.equal(e.answered, true,
    'a human who typed an answer should not also have to remember the checkbox');
});

test('adding is idempotent regardless of whitespace', () => {
  const ib = new Inbox(scratch());
  assert.equal(ib.add('t-001', 'Which  database?'), true);
  assert.equal(ib.add('t-001', 'Which database?'), false, 'whitespace-normalised duplicate');
  assert.equal(ib.add('t-002', 'Which database?'), true, 'same question, different task');
  assert.equal(ib.list().length, 2);
});

test('answering twice replaces rather than stacks', () => {
  const ib = new Inbox(scratch());
  ib.add('t-001', 'Which database?');
  ib.answer(1, 'MySQL.');
  ib.answer(1, 'Actually Postgres.');
  const [e] = ib.list();
  assert.equal(e.answer, 'Actually Postgres.');
  assert.equal(ib.read().match(/MySQL/), null, 'the superseded answer is gone');
});

test('answersFor and open are scoped per task', () => {
  const ib = new Inbox(scratch());
  ib.add('t-001', 'A?'); ib.add('t-001', 'B?'); ib.add('t-002', 'C?');
  ib.answer(1, 'yes');
  assert.deepEqual(ib.open('t-001').map((e) => e.question), ['B?']);
  assert.deepEqual(ib.answersFor('t-001').map((e) => e.answer), ['yes']);
  assert.equal(ib.open('t-002').length, 1);
  assert.equal(ib.open().length, 2, 'unscoped lists every open question');
});

test('answering an unknown entry fails loudly', () => {
  assert.throws(() => new Inbox(scratch()).answer(7, 'x'), /no inbox entry #7/);
});

test('escalations are recovered from a summary as well as the file', () => {
  assert.deepEqual(extractNeedsHuman('NEEDS_HUMAN: Which provider?'), ['Which provider?']);
  assert.deepEqual(extractNeedsHuman('NEEDS HUMAN : Which  provider?'), ['Which provider?']);
  const fromSection = extractNeedsHuman(`## What changed
Stuff.

## Blocked
- Should we drop the v1 endpoint before customers migrate?

## What is left
Nothing.`);
  assert.deepEqual(fromSection, ['Should we drop the v1 endpoint before customers migrate?']);
  assert.deepEqual(extractNeedsHuman('nothing to see'), []);
  assert.deepEqual(extractNeedsHuman(null), []);
});

test('the same escalation reported twice yields one entry', () => {
  const found = extractNeedsHuman(`NEEDS_HUMAN: Which provider?

## Blocked
- NEEDS_HUMAN: Which provider?`);
  assert.deepEqual(found, ['Which provider?']);
});

test('notify is a no-op off darwin and never throws', () => {
  const calls = [];
  assert.equal(notify('t', 'm', { platform: 'linux', exec: () => calls.push(1) }), false);
  assert.equal(calls.length, 0);
  assert.equal(notify('t', 'm', { platform: 'darwin', exec: (...a) => calls.push(a) }), true);
  assert.equal(calls.length, 1);
  assert.doesNotThrow(() => notify('t', 'm', {
    platform: 'darwin', exec: () => { throw new Error('osascript missing'); },
  }));
});

test('notification text is escaped so a quote cannot break the AppleScript', () => {
  let script = '';
  notify('cq', 'he said "stop"\nand \\ left', { platform: 'darwin', exec: (_b, args) => { script = args[1]; } });
  assert.ok(!/[^\\]"stop"/.test(script), 'quotes are escaped');
  assert.ok(!script.includes('\n'), 'newlines are flattened');
});

test('the notifier dedupes within its window, per key', () => {
  let t = 0;
  const calls = [];
  const n = makeNotifier({ windowMs: 1000, now: () => t, platform: 'darwin', exec: (...a) => calls.push(a) });
  assert.equal(n('a', 'T', 'm'), true);
  assert.equal(n('a', 'T', 'm'), false, 'same key, same window');
  assert.equal(n('b', 'T', 'm'), true, 'a different key still fires');
  t = 2000;
  assert.equal(n('a', 'T', 'm'), true, 'the window elapsed');
});
