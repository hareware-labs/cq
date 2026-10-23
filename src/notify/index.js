import { execFile } from 'node:child_process';

/**
 * Best-effort user notification. Every call is fire-and-forget and every failure is
 * swallowed: a supervisor that dies because a notification failed is worse than one
 * that runs quietly.
 */
export function notify(title, message, { platform = process.platform, exec = execFile } = {}) {
  if (platform !== 'darwin') return false;   // no-op elsewhere, by design
  const esc = (s) => String(s).replace(/[\\"]/g, '\\$&').replace(/\n/g, ' ').slice(0, 500);
  const script = `display notification "${esc(message)}" with title "${esc(title)}"`;
  try {
    exec('osascript', ['-e', script], { timeout: 10_000 }, () => { /* ignored */ });
    return true;
  } catch { return false; }
}

/** Rate-limited notifier: the same key does not fire twice within `windowMs`. */
export function makeNotifier({ windowMs = 10 * 60 * 1000, now = Date.now, ...opts } = {}) {
  const last = new Map();
  return (key, title, message) => {
    const t = now();
    if (last.has(key) && t - last.get(key) < windowMs) return false;
    last.set(key, t);
    return notify(title, message, opts);
  };
}
