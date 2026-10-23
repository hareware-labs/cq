import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeRateLimit, classify, classifyExit, napFor, toMs, backoffMs,
  isLongWindow, classKind, RESET_GRACE_MS, MAX_NAP_MS,
} from '../src/limits/index.js';
import { FIXTURES, ANCHORS } from './helpers.js';

/** Pull the rate_limit_info payload out of a fixture stream. */
const rlFrom = (fixture) => readFileSync(join(FIXTURES, fixture), 'utf8')
  .trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .find((e) => e?.type === 'rate_limit_event')
  .rate_limit_info;

test('toMs distinguishes epoch seconds from milliseconds', () => {
  assert.equal(toMs(1788570000), 1788570000000, 'seconds are scaled up');
  assert.equal(toMs(1788570000000), 1788570000000, 'milliseconds are left alone');
  assert.equal(toMs(0), null);
  assert.equal(toMs(null), null);
  assert.equal(toMs('nope'), null);
  assert.equal(toMs(NaN), null);
});

test('normalizes the real camelCase payload the CLI emits', () => {
  const info = normalizeRateLimit(rlFrom('success.jsonl'));
  assert.equal(info.status, 'allowed');
  assert.equal(info.rate_limit_type, 'five_hour');
  assert.equal(info.resets_at_ms, ANCHORS.five_hour_ms, 'resetsAt seconds -> ms');
  assert.equal(info.utilization, 0.16, 'utilization comes from unifiedWindows');
  assert.equal(info.windows.seven_day.resets_at_ms, ANCHORS.seven_day_ms);
  assert.equal(info.is_using_overage, false);
});

test('accepts the snake_case spelling the brief specified', () => {
  const info = normalizeRateLimit(rlFrom('snake-case.jsonl'));
  assert.equal(info.status, 'rejected');
  assert.equal(info.rate_limit_type, 'five_hour');
  assert.equal(info.resets_at_ms, ANCHORS.five_hour_ms);
  assert.equal(info.utilization, 1);
});

test('accepts resetsAt already in milliseconds', () => {
  assert.equal(normalizeRateLimit(rlFrom('millis.jsonl')).resets_at_ms, ANCHORS.five_hour_ms);
});

test('an unknown status does not invent a stop', () => {
  const info = normalizeRateLimit(rlFrom('weird.jsonl'));
  assert.equal(info.status, 'allowed', 'unknown status degrades to allowed');
  assert.equal(info.status_unknown, 'some_new_status', 'but is recorded');
  assert.equal(classify(info).action, 'continue');
});

test('an unknown rate_limit_type is treated as a long window', () => {
  assert.equal(classKind('quantum_hour'), 'long');
  assert.equal(classKind('five_hour'), 'short');
  assert.equal(classKind('seven_day_opus'), 'long');
  assert.equal(classKind('overage'), 'overage');
  assert.ok(isLongWindow('seven_day_sonnet'));
  assert.ok(!isLongWindow('five_hour'));
});

test('rejected -> park', () => {
  const d = classify(normalizeRateLimit(rlFrom('rejected.jsonl')));
  assert.equal(d.action, 'park');
  assert.equal(d.kind, 'short');
  assert.equal(d.resets_at_ms, ANCHORS.five_hour_ms);
  assert.equal(d.detected_by, 'rate_limit_event');
});

test('allowed_warning -> finish_then_park, not an immediate stop', () => {
  const d = classify(normalizeRateLimit(rlFrom('warning.jsonl')));
  assert.equal(d.action, 'finish_then_park');
  assert.match(d.reason, /nearly exhausted/);
});

test('the soft utilization threshold parks before the CLI warns', () => {
  const info = normalizeRateLimit({ status: 'allowed', rateLimitType: 'five_hour',
    resetsAt: ANCHORS.five_hour_s, unifiedWindows: { five_hour: { utilization: 0.95, resetsAt: ANCHORS.five_hour_s } } });
  const d = classify(info, { parkAtUtilization: 0.92 });
  assert.equal(d.action, 'finish_then_park');
  assert.equal(d.detected_by, 'utilization');
  assert.equal(classify(info, { parkAtUtilization: 0.99 }).action, 'continue',
    'a higher threshold keeps going');
});

test('a seven-day rejection parks long and still sleeps to the reset', () => {
  const d = classify(normalizeRateLimit(rlFrom('seven-day.jsonl')));
  assert.equal(d.action, 'park');
  assert.equal(d.kind, 'long');
  assert.equal(d.resets_at_ms, ANCHORS.seven_day_ms);

  const nap = napFor(d, { now: ANCHORS.now_ms });
  assert.equal(nap.ms, MAX_NAP_MS, 'capped to one nap');
  assert.equal(nap.final, false, 'and knows it is not the last one');
});

test('overage parks rather than spending money silently, unless opted in', () => {
  const info = normalizeRateLimit(rlFrom('overage.jsonl'));
  assert.equal(classify(info).action, 'park');
  const spending = normalizeRateLimit({ status: 'allowed', rateLimitType: 'five_hour',
    resetsAt: ANCHORS.five_hour_s, isUsingOverage: true, overageResetsAt: ANCHORS.overage_s });
  const d = classify(spending);
  assert.equal(d.action, 'park');
  assert.equal(d.kind, 'overage');
  assert.match(d.reason, /--allow-overage/);
  assert.equal(classify(spending, { allowOverage: true }).action, 'continue');
});

test('classifyExit only fires on a limit signature with a non-zero exit', () => {
  assert.equal(classifyExit({ exitCode: 0, stderr: 'usage limit reached' }), null,
    'a clean exit is never a limit');
  assert.equal(classifyExit({ exitCode: 1, stderr: 'TypeError: x is undefined' }), null);
  const d = classifyExit({ exitCode: 1, stderr: 'Claude usage limit reached. Resets at 9pm.' });
  assert.equal(d.action, 'park');
  assert.equal(d.detected_by, 'exit_signature', 'labelled as the heuristic it is');
  for (const s of ['429 Too Many Requests', 'rate limit exceeded', 'quota exceeded']) {
    assert.ok(classifyExit({ exitCode: 1, stderr: s }), `should match: ${s}`);
  }
});

test('napFor adds grace and clamps', () => {
  const d = { resets_at_ms: ANCHORS.now_ms + 3600_000 };
  const nap = napFor(d, { now: ANCHORS.now_ms });
  assert.equal(nap.ms, 3600_000 + RESET_GRACE_MS);
  assert.ok(nap.final);

  assert.equal(napFor({ resets_at_ms: ANCHORS.now_ms - 999_999 }, { now: ANCHORS.now_ms }).ms, 0,
    'a reset already in the past means go now');
  assert.equal(napFor({ resets_at_ms: null }, { now: ANCHORS.now_ms }).ms, 15 * 60_000,
    'no reset time -> a fixed conservative wait, never a spin');
  assert.ok(napFor({ resets_at_ms: ANCHORS.now_ms + 1000 }, { now: ANCHORS.now_ms }).ms >= 60_000,
    'never busy-loops on a near reset');
});

test('backoff grows exponentially and stays bounded by jitter', () => {
  const noJitter = { rand: () => 0.5 };
  assert.equal(backoffMs(1, noJitter), 30_000);
  assert.equal(backoffMs(2, noJitter), 120_000);
  assert.equal(backoffMs(3, noJitter), 480_000);
  for (let i = 0; i < 200; i++) {
    const v = backoffMs(2);
    assert.ok(v >= 108_000 && v <= 132_000, `jitter stayed in +/-10%: ${v}`);
  }
});

test('classify tolerates a missing payload entirely', () => {
  assert.equal(classify(null).action, 'continue');
  assert.equal(normalizeRateLimit(null), null);
  assert.equal(normalizeRateLimit('nonsense'), null);
});
