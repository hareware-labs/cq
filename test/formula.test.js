import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const formulaPath = join(root, 'Formula', 'cq.rb');

// The placeholder sha256 written by templates/release.mjs before a real
// archive has been hashed. It happens to also match the 64-char hex regex,
// so it is not really a separate case, but the formula documents it by name
// and we assert against that exact string rather than "any hex".
const PLACEHOLDER_SHA256 = '0'.repeat(64);

function readFormula() {
  assert.ok(existsSync(formulaPath), 'Formula/cq.rb must exist');
  const text = readFileSync(formulaPath, 'utf8');
  const classMatch = text.match(/^class\s+(\w+)\s+<\s+Formula/m);
  const urlMatch = text.match(/^\s*url\s+"([^"]+)"/m);
  const sha256Match = text.match(/^\s*sha256\s+"([^"]+)"/m);
  assert.ok(classMatch, 'formula must declare a class ... < Formula');
  assert.ok(urlMatch, 'formula must declare a url');
  assert.ok(sha256Match, 'formula must declare a sha256');
  return { className: classMatch[1], url: urlMatch[1], sha256: sha256Match[1] };
}

test('the formula is parseable enough to extract url, sha256 and class name', () => {
  const { className, url, sha256 } = readFormula();
  assert.equal(typeof className, 'string');
  assert.match(url, /^https?:\/\//);
  assert.match(sha256, /^[0-9a-f]{64}$/i);
});

test('the formula class name matches its file name, per Homebrew convention', () => {
  const { className } = readFormula();
  const stem = basename(formulaPath, '.rb');
  const expected = stem.charAt(0).toUpperCase() + stem.slice(1);
  assert.equal(className, expected,
    `cq.rb must declare "class ${expected} < Formula" (found "${className}")`);
});

test('the formula url version matches package.json, so they cannot drift', () => {
  const { url } = readFormula();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  // GitHub tag archives end in /vX.Y.Z.tar.gz rather than carrying a /vX.Y.Z/ segment.
  const versionInUrl = url.match(/\/v(\d+\.\d+\.\d+)(?:\/|\.tar\.gz$)/);
  assert.ok(versionInUrl, `formula url must contain /vX.Y.Z/ or end in /vX.Y.Z.tar.gz (found "${url}")`);
  assert.equal(versionInUrl[1], pkg.version,
    'Formula/cq.rb url version and package.json version must match, or the release was half-updated');
});

test('the sha256 is a real 64-char hex digest or the documented placeholder, nothing else', () => {
  const { sha256 } = readFormula();
  const isHex64 = /^[0-9a-f]{64}$/i.test(sha256);
  assert.ok(isHex64 || sha256 === PLACEHOLDER_SHA256,
    `sha256 must be a real digest or the "${PLACEHOLDER_SHA256}" placeholder (found "${sha256}")`);
});
