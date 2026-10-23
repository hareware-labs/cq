import { writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write a file atomically: temp file -> fsync -> rename.
 *
 * rename(2) within a filesystem is atomic on POSIX, so a crash can never leave a
 * half-written tasks.json behind. Without the fsync the rename can land before the
 * data does, which on a hard power loss yields an atomically-renamed empty file --
 * the exact failure this is meant to prevent.
 */
export function writeAtomic(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, contents);
  const fd = openSync(tmp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

/** Write a value as pretty JSON, atomically, with a trailing newline. */
export function writeJsonAtomic(path, value) {
  writeAtomic(path, JSON.stringify(value, null, 2) + '\n');
}
