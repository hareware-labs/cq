import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const FAKE_BIN = fileURLToPath(new URL('./fake-bin/claude', import.meta.url));
export const ANCHORS = JSON.parse(readFileSync(join(FIXTURES, 'anchors.json'), 'utf8'));

/**
 * A scratch target repo plus a scripted fake CLI.
 *
 * `steps` is consumed one per invocation, so a test spells out the exact sequence of
 * CLI outcomes it wants and then asserts on the resulting queue.
 */
export function harness({ steps = [], defaultStep = null, tasks = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cq-root-'));
  const fake = mkdtempSync(join(tmpdir(), 'cq-fake-'));
  mkdirSync(join(root, '.cq', 'logs'), { recursive: true });

  writeFileSync(join(fake, 'scenario.json'),
    JSON.stringify({ steps, default: defaultStep ?? { fixture: 'success.jsonl', exit: 0 } }));

  if (tasks.length) {
    writeFileSync(join(root, '.cq', 'tasks.json'), JSON.stringify({
      version: 1,
      defaults: { model: 'sonnet', max_turns: 40 },
      tasks: tasks.map((t, i) => ({
        id: t.id ?? `t-${String(i + 1).padStart(3, '0')}`,
        title: t.title ?? `task ${i + 1}`,
        prompt: t.prompt ?? 'do the thing',
        context_files: [], depends_on: [], priority: 2,
        model: null, max_turns: null, status: 'queued', attempts: 0,
        session_id: null, result_summary: null, needs_human: [],
        ...t,
      })),
    }, null, 2));
  }

  const env = { ...process.env, CQ_FAKE_DIR: fake, CQ_FAKE_FIXTURES: FIXTURES };
  return {
    root, fake, env, bin: FAKE_BIN,
    /** Every fake-CLI invocation, with full argv — for asserting which flags cq passed. */
    invocations() {
      const p = join(fake, 'invocations.jsonl');
      if (!existsSync(p)) return [];
      return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    tasks() { return JSON.parse(readFileSync(join(root, '.cq', 'tasks.json'), 'utf8')).tasks; },
    task(id) { return this.tasks().find((t) => t.id === id); },
    status() {
      const p = join(root, '.cq', 'status.json');
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    },
    inbox() {
      const p = join(root, '.cq', 'inbox.md');
      return existsSync(p) ? readFileSync(p, 'utf8') : '';
    },
    log(path, contents) { writeFileSync(join(root, path), contents); },
  };
}

/**
 * A fake clock and sleep. `sleep` does not actually wait: it advances the clock and
 * records the request, so a test can assert "it slept until the reset" in microseconds
 * instead of hours.
 */
export function fakeClock(startMs = ANCHORS.now_ms) {
  let t = startMs;
  const naps = [];
  return {
    naps,
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
    sleep: async (ms) => { naps.push(ms); t += ms; },
    total: () => naps.reduce((a, b) => a + b, 0),
  };
}

/** Collects scheduler log lines so tests can assert on what the user was told. */
export function collectLogs() {
  const lines = [];
  const log = (...a) => lines.push(a.join(' '));
  log.lines = lines;
  log.text = () => lines.join('\n');
  log.has = (re) => lines.some((l) => (re instanceof RegExp ? re.test(l) : l.includes(re)));
  return log;
}

/** A notifier that records instead of firing osascript. */
export function collectNotify() {
  const sent = [];
  const fn = (key, title, message) => { sent.push({ key, title, message }); return true; };
  fn.sent = sent;
  return fn;
}

export const CAPS = { max_turns: true, max_budget_usd: true, version: '2.1.261 (fake)' };
