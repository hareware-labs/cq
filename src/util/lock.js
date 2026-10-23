import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

/** A lock older than this is presumed abandoned even if the pid still exists. */
export const STALE_MS = 15 * 60 * 1000;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err && err.code === 'EPERM'; }  // EPERM => alive, owned by someone else
}

/**
 * Acquire an advisory lock via exclusive create.
 *
 * Advisory, not mandatory: a determined hand-edit can still clobber the queue. That
 * is deliberate -- tasks.json is documented as hand-editable, and a lock a human
 * cannot override is worse than one they can.
 *
 * @returns {{release: () => void, broke: null | {pid:number, host:string, reason:string}}}
 */
export function acquireLock(path, { now = Date.now() } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const mine = { pid: process.pid, host: hostname(), acquired_at: now };
  let broke = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(mine) + '\n', { flag: 'wx' });
      return {
        broke,
        release() {
          // Only remove the lock if it is still ours -- never delete a lock another
          // process legitimately acquired after we broke a stale one.
          try {
            const held = JSON.parse(readFileSync(path, 'utf8'));
            if (held.pid === mine.pid && held.acquired_at === mine.acquired_at) unlinkSync(path);
          } catch { /* already gone, or unreadable: nothing safe to do */ }
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      let held;
      try { held = JSON.parse(readFileSync(path, 'utf8')); }
      catch { held = null; }   // unparseable lock file is itself stale

      const reason =
        !held ? 'unreadable lock file'
        : !pidAlive(held.pid) ? `pid ${held.pid} is not running`
        : (now - (held.acquired_at ?? 0)) > STALE_MS ? `held for over ${Math.round(STALE_MS / 60000)}m`
        : null;

      if (!reason) {
        const e = new Error(
          `.cq is locked by pid ${held.pid} on ${held.host} since ` +
          `${new Date(held.acquired_at).toISOString()}. ` +
          `If that process is gone, delete ${path}.`);
        e.code = 'ELOCKED';
        e.held = held;
        throw e;
      }
      broke = { pid: held?.pid ?? -1, host: held?.host ?? '?', reason };
      try { unlinkSync(path); } catch { /* lost the race; the retry will report it */ }
    }
  }
  throw new Error(`could not acquire ${path} after breaking a stale lock`);
}
