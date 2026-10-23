import { fmtDur } from '../scheduler/index.js';

const isTTY = () => process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (isTTY() ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const dim = c(2), bold = c(1), red = c(31), green = c(32),
             yellow = c(33), blue = c(34), magenta = c(35), cyan = c(36);

export const STATUS_MARK = {
  queued: dim('◦'), running: cyan('▶'), parked: yellow('⏸'),
  blocked: magenta('?'), done: green('✓'), failed: red('✗'),
};

// Four decimals only where they carry information: a single cheap task can cost
// $0.0123, but an average of $0.30 should not render as "$0.3000".
export const usd = (n) => (typeof n === 'number' ? `$${n.toFixed(n < 0.1 ? 4 : 2)}` : '—');

/** A compact utilization bar. Reading a number is slower than seeing a bar. */
export function bar(fraction, width = 20) {
  if (typeof fraction !== 'number') return dim('─'.repeat(width));
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  const paint = f >= 0.92 ? red : f >= 0.75 ? yellow : green;
  return paint('█'.repeat(filled)) + dim('░'.repeat(width - filled));
}

export function countdown(untilMs, now = Date.now()) {
  if (!untilMs) return '—';
  const d = untilMs - now;
  return d <= 0 ? green('now') : fmtDur(d);
}

/** Left-aligned columns sized to content. */
export function table(rows, { gap = 2 } = {}) {
  if (!rows.length) return '';
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(String(cell)));
    });
  }
  return rows.map((row) => row.map((cell, i) => {
    const s = String(cell);
    return i === row.length - 1 ? s : s + ' '.repeat(widths[i] - visibleLength(s) + gap);
  }).join('')).join('\n');
}

/** Length ignoring ANSI escapes, so colour does not break alignment. */
export function visibleLength(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
