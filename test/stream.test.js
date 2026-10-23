import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamParser, parseStream } from '../src/runner/stream.js';
import { buildArgs, budgetForTurns, runTask } from '../src/runner/index.js';
import { buildPrompt, readContextFiles } from '../src/runner/prompt.js';
import { FIXTURES, ANCHORS, harness, CAPS } from './helpers.js';

const fixture = (f) => readFileSync(join(FIXTURES, f), 'utf8');

test('parses the real stream captured from the CLI', () => {
  // docs/sample-stream.jsonl is a genuine `claude -p "say ok"` run, not a fixture.
  const s = parseStream(readFileSync(new URL('../docs/sample-stream.jsonl', import.meta.url), 'utf8'));
  assert.equal(s.result_subtype, 'success');
  assert.equal(s.is_error, false);
  assert.equal(s.num_turns, 1);
  assert.equal(s.cli_version, '2.1.261');
  assert.ok(s.session_id, 'session id was found');
  assert.equal(s.rate_limit.status, 'allowed');
  assert.equal(s.rate_limit.rate_limit_type, 'five_hour');
  assert.equal(s.bad_lines, 0);
  assert.equal(typeof s.cost_usd, 'number');
});

test('parses the real max-turns stream captured from the CLI', () => {
  const s = parseStream(readFileSync(new URL('../docs/sample-stream-max-turns.jsonl', import.meta.url), 'utf8'));
  assert.equal(s.result_subtype, 'error_max_turns');
  assert.equal(s.terminal_reason, 'max_turns');
  assert.equal(s.is_error, true);
});

test('session_id is available from the first event, before any result', () => {
  const s = parseStream(fixture('rejected.jsonl'));
  assert.equal(s.session_id, 'sess-park');
  assert.equal(s.saw_result, false, 'a killed run may never emit result');
  assert.equal(s.rate_limit.status, 'rejected', 'but the limit is still known');
});

test('a truncated stream and non-JSON lines are counted, never thrown', () => {
  const s = parseStream(fixture('crash.jsonl'));
  assert.equal(s.bad_lines, 1);
  assert.equal(s.session_id, 'sess-crash');
  assert.equal(s.saw_result, false);
  assert.doesNotThrow(() => parseStream('garbage\n\n[]\nnull\n"string"\n'));
  assert.equal(parseStream('[]\nnull\n').bad_lines, 2, 'JSON that is not an object is rejected');
});

test('unknown event types are counted, not fatal', () => {
  const s = parseStream(fixture('weird.jsonl'));
  assert.equal(s.unknown_types.brand_new_event_type_2027, 1);
  assert.equal(s.result_subtype, 'success', 'the run still parsed');
});

test('chunk boundaries mid-line are handled', () => {
  const text = fixture('success.jsonl');
  const p = new StreamParser();
  // Feed one byte at a time: the worst case a pipe can produce.
  for (const ch of text) p.push(ch);
  const s = p.end();
  assert.equal(s.bad_lines, 0);
  assert.equal(s.result_subtype, 'success');
  assert.equal(s.num_turns, 4);
});

test('a trailing line with no newline is still parsed', () => {
  const p = new StreamParser();
  p.push('{"type":"result","subtype":"success","result":"hi","num_turns":1}');   // no \n
  const s = p.end();
  assert.equal(s.result_subtype, 'success');
  assert.equal(s.final_text, 'hi');
});

test('a rejection anywhere in the stream outranks a later allowed event', () => {
  const p = new StreamParser();
  p.push(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: ANCHORS.five_hour_s } }) + '\n');
  p.push(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: ANCHORS.five_hour_s } }) + '\n');
  assert.equal(p.end().rate_limit.status, 'rejected',
    'a later allowed event does not undo a refusal');
});

test('final text prefers result.result but falls back to the last assistant block', () => {
  assert.match(parseStream(fixture('success.jsonl')).final_text, /What changed/);
  const s = parseStream(fixture('crash.jsonl'));
  assert.equal(s.final_text, 'Half a th', 'partial output is still recoverable');
});

test('argv always carries --verbose with stream-json, and an explicit model', () => {
  const args = buildArgs({ id: 't-1' }, { model: 'sonnet', maxTurns: 40, maxBudgetUsd: 2,
    caps: { max_turns: true, max_budget_usd: true } });
  assert.ok(args.includes('--verbose'), 'the CLI refuses stream-json in print mode without it');
  assert.deepEqual(args.slice(0, 4), ['--print', '--output-format', 'stream-json', '--verbose']);
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.ok(!args.includes('--resume'));
});

test('capability gating drops flags this CLI does not accept', () => {
  const without = buildArgs({ id: 't-1' }, { model: 'sonnet', maxTurns: 40, maxBudgetUsd: 2,
    caps: { max_turns: false, max_budget_usd: true } });
  assert.ok(!without.includes('--max-turns'), 'an unsupported --max-turns is not passed');
  assert.ok(without.includes('--max-budget-usd'), 'the documented money cap still is');
});

test('the money backstop scales with the model', () => {
  assert.ok(budgetForTurns(40, 'opus') > budgetForTurns(40, 'sonnet'));
  assert.ok(budgetForTurns(1, 'sonnet') >= 1, 'never zero');
});

test('context files are fenced safely and never escape the repo root', () => {
  const root = new URL('../', import.meta.url).pathname;
  const files = readContextFiles(root, ['package.json', '../../../etc/passwd', 'does-not-exist.js', 'src']);
  assert.ok(files[0].text.includes('"commander"'), 'the real file was read');
  assert.match(files[1].error, /outside the repo root/);
  assert.match(files[2].error, /not found/);
  assert.match(files[3].error, /is a directory/);
});

test('a context file containing backticks cannot break out of its fence', () => {
  const prompt = buildPrompt(
    { id: 't-1', title: 'x', prompt: 'go', context_files: [] },
    { includeProtocol: false, contextFiles: [{ path: 'a.md', text: '```\nnested\n```' }] });
  const fenceLine = prompt.split('\n').find((l) => /^`{4,}$/.test(l));
  assert.ok(fenceLine, 'the outer fence grew longer than the inner one');
});

test('truncation is reported to the worker rather than hidden', () => {
  const prompt = buildPrompt(
    { id: 't-1', prompt: 'go', context_files: [] },
    { includeProtocol: false, contextFiles: [{ path: 'big.js', text: 'x', truncated: true }] });
  assert.match(prompt, /truncated by cq/,
    'a worker told nothing would make confident claims about code it never saw');
});

test('the protocol block is dropped when the repo already carries it', () => {
  const task = { id: 't-1', title: 'x', prompt: 'go', context_files: [] };
  const withProto = buildPrompt(task, { includeProtocol: true });
  const without = buildPrompt(task, { includeProtocol: false });
  assert.ok(withProto.length > without.length + 800, 'the protocol is substantial');
  assert.match(without, /CLAUDE\.md/, 'and the short form points at where it lives');
});

test('inbox answers and hand-offs are prepended, in that order', () => {
  const p = buildPrompt({ id: 't-1', prompt: 'go', context_files: [] }, {
    includeProtocol: false, handoff: 'You ran out of turns.',
    inboxAnswers: [{ question: 'Which provider?', answer: 'Auth0.' }],
  });
  assert.ok(p.indexOf('Auth0.') < p.indexOf('You ran out of turns.'));
  assert.ok(p.indexOf('You ran out of turns.') < p.indexOf('go'));
});

test('a symlink inside the repo pointing outside it is refused', () => {
  // The containment guard used to be purely lexical, so a link living in the repo but
  // pointing at ~/.ssh passed it and was read straight into the prompt.
  const root = mkdtempSync(join(tmpdir(), 'cq-sym-'));
  const outside = mkdtempSync(join(tmpdir(), 'cq-outside-'));
  writeFileSync(join(outside, 'secret'), 'PRIVATE KEY MATERIAL');
  symlinkSync(join(outside, 'secret'), join(root, 'innocent.txt'));
  writeFileSync(join(root, 'real.txt'), 'fine');

  const [linked, real] = readContextFiles(root, ['innocent.txt', 'real.txt']);
  assert.match(linked.error, /outside the repo root/);
  assert.equal(linked.text, undefined, 'and nothing was read');
  assert.equal(real.text, 'fine', 'ordinary files still work');
});

test('a timeout is never reclassified as a rate limit', async () => {
  // A task we killed on our own timeout, whose output mentions rate limits, must be
  // retried — not parked against a window that is actually open.
  const h = harness({ tasks: [{ title: 'slow' }],
    // Wide margin: a loaded CI runner must not turn this into a flake.
    steps: [{ fixture: 'limit-exit.jsonl', exit: 1, delay_ms: 5000,
              stderr: 'Claude usage limit reached\n' }] });
  const out = await runTask({ id: 't-001', title: 'slow', prompt: 'go', context_files: [] },
    { root: h.root, bin: h.bin, env: h.env, model: 'sonnet', maxTurns: 40,
      caps: CAPS, timeoutMs: 250 });
  assert.equal(out.disposition, 'timeout', 'not rate_limited');
});

test('an already-aborted signal still kills the child', async () => {
  const h = harness({ tasks: [{ title: 'x' }], steps: [{ fixture: 'success.jsonl', exit: 0, delay_ms: 3000 }] });
  const ac = new AbortController();
  ac.abort();                                  // aborted before runTask is even called
  const out = await runTask({ id: 't-001', title: 'x', prompt: 'go', context_files: [] },
    { root: h.root, bin: h.bin, env: h.env, model: 'sonnet', maxTurns: 40,
      caps: CAPS, signal: ac.signal });
  assert.equal(out.disposition, 'aborted', 'no abort event fires for an already-aborted signal');
});
