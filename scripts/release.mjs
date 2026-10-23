#!/usr/bin/env node
// Prepares a cq release per docs/RELEASING.md: bumps the version, tags the
// commit, downloads the GitHub release archive, hashes it, and fills in
// Formula/cq.rb. It never pushes or publishes anything — the steps that
// touch a remote (git push, syncing the formula to the tap repo, `brew
// install`/`brew test`) are printed at the end for a human to run.
//
// Safe to re-run: read-only checks (dirty tree, existing tag) always run
// first and abort before anything is written, so a failed or interrupted
// run never leaves the repo half-mutated by a *second* invocation.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const PACKAGE_LOCK = path.join(ROOT, 'package-lock.json');
const FORMULA = path.join(ROOT, 'Formula', 'cq.rb');

function usageError(message) {
  console.error(`error: ${message}`);
  console.error('usage: node scripts/release.mjs <version> [--dry-run]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const version = args.find((a) => !a.startsWith('--'));
  if (!version) usageError('missing <version> argument, e.g. 0.2.0');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    usageError(`'${version}' is not a plain X.Y.Z version (pass 0.2.0, not v0.2.0)`);
  }
  return { version, tag: `v${version}`, dryRun };
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function checkWorkingTreeClean() {
  const status = git(['status', '--porcelain']);
  if (status.trim() !== '') {
    console.error('error: working tree is dirty; commit or stash changes first:');
    console.error(status.trimEnd());
    process.exit(1);
  }
}

// Local check only — this script never pushes, so the remote can't have a
// tag the local repo doesn't. If a tap-side or other process could push
// tags independently, this would need `git ls-remote --tags origin`.
function checkTagAbsent(tag) {
  const existing = git(['tag', '--list', tag]).trim();
  if (existing === tag) {
    console.error(`error: tag ${tag} already exists locally.`);
    console.error('  If this release attempt needs to be redone, remove it first:');
    console.error(`    git tag -d ${tag}`);
    process.exit(1);
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function updateVersions(version, dryRun) {
  const pkg = readJson(PACKAGE_JSON);
  const lock = readJson(PACKAGE_LOCK);

  if (pkg.version === version && lock.version === version) {
    console.log(`package.json and package-lock.json are already at ${version}`);
    return { changed: false };
  }

  if (dryRun) {
    console.log(`would bump package.json version ${pkg.version} -> ${version}`);
    console.log(`would bump package-lock.json version ${lock.version} -> ${version}`);
    return { changed: true };
  }

  pkg.version = version;
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeJson(PACKAGE_JSON, pkg);
  writeJson(PACKAGE_LOCK, lock);
  console.log(`bumped package.json and package-lock.json to ${version}`);
  return { changed: true };
}

function commitVersionBump(tag, dryRun) {
  if (dryRun) {
    console.log(`would run: git commit -m "Release ${tag}" package.json package-lock.json`);
    return;
  }
  git(['add', 'package.json', 'package-lock.json']);
  git(['commit', '-m', `Release ${tag}`]);
  console.log(`committed: Release ${tag}`);
}

function createTag(tag, dryRun) {
  if (dryRun) {
    console.log(`would run: git tag -a ${tag} -m "cq ${tag}"`);
    return;
  }
  git(['tag', '-a', tag, '-m', `cq ${tag}`]);
  console.log(`created tag ${tag}`);
}

function archiveUrlFor(tag) {
  const pkg = readJson(PACKAGE_JSON);
  const homepage = pkg.homepage.replace(/\/$/, '');
  return `${homepage}/archive/refs/tags/${tag}.tar.gz`;
}

async function downloadAndHash(url) {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return createHash('sha256').update(buffer).digest('hex');
}

function withFormulaUrlAndSha(contents, url, sha256) {
  const lines = contents.split('\n');
  const urlIdx = lines.findIndex((l) => /^\s*url "/.test(l));
  if (urlIdx === -1) throw new Error(`${FORMULA}: no 'url' line found`);
  let shaIdx = -1;
  for (let i = urlIdx + 1; i < lines.length; i++) {
    if (/^\s*sha256 "/.test(lines[i])) {
      shaIdx = i;
      break;
    }
    if (!/^\s*#/.test(lines[i])) break; // only skip comment lines between url and sha256
  }
  if (shaIdx === -1) throw new Error(`${FORMULA}: no 'sha256' line following 'url'`);
  const indent = lines[urlIdx].match(/^(\s*)/)[1];
  const replaced = [
    ...lines.slice(0, urlIdx),
    `${indent}url "${url}"`,
    `${indent}sha256 "${sha256}"`,
    ...lines.slice(shaIdx + 1),
  ];
  return replaced.join('\n');
}

function printManualSteps({ tag, archiveUrl, formulaUpdated, dryRun }) {
  console.log('');
  console.log('Remaining manual steps (this script does not do these):');
  console.log('  1. Push the release commit and tag:');
  console.log('       git push && git push origin ' + tag);
  console.log('     (or: git push --follow-tags)');
  if (!formulaUpdated) {
    if (dryRun) {
      console.log('  2. --dry-run skips the download; on a real run this fetches the');
      console.log('     archive below and fills in Formula/cq.rb automatically. If it');
      console.log('     ever fails (e.g. the tag was not pushed yet), fetch and hash it');
      console.log('     by hand:');
    } else {
      console.log('  2. The archive could not be downloaded/hashed automatically above');
      console.log('     (expected until the tag is pushed and the repo is public — see');
      console.log('     docs/RELEASING.md §4). Once it is, fetch and hash it by hand:');
    }
    console.log(`       curl -fL ${archiveUrl} -o /tmp/${path.basename(archiveUrl)}`);
    console.log(`       shasum -a 256 /tmp/${path.basename(archiveUrl)}`);
    console.log('     then edit the url/sha256 lines in Formula/cq.rb, or re-run this');
    console.log('     script after deleting the local tag (git tag -d ' + tag + ').');
  }
  console.log('  3. Sync Formula/cq.rb to the tap repo (github.com/hareware-labs/homebrew-tap):');
  console.log('       cp Formula/cq.rb <tap-checkout>/Formula/cq.rb');
  console.log(`       cd <tap-checkout> && git add Formula/cq.rb && git commit -m "cq ${tag}" && git push`);
  console.log('  4. Verify from a clean prefix:');
  console.log('       brew tap hareware-labs/tap');
  console.log('       brew install hareware-labs/tap/cq && brew test hareware-labs/tap/cq');
}

async function main() {
  const { version, tag, dryRun } = parseArgs(process.argv);
  if (dryRun) console.log(`--dry-run: no files, commits, or tags will be changed\n`);

  checkWorkingTreeClean();
  checkTagAbsent(tag);

  const { changed } = updateVersions(version, dryRun);
  if (changed) commitVersionBump(tag, dryRun);

  createTag(tag, dryRun);

  const archiveUrl = archiveUrlFor(tag);
  let formulaUpdated = false;

  if (dryRun) {
    console.log(`would download ${archiveUrl}`);
    console.log('would compute its sha256 and write the url/sha256 lines in Formula/cq.rb');
  } else {
    try {
      const sha256 = await downloadAndHash(archiveUrl);
      const updated = withFormulaUrlAndSha(readFileSync(FORMULA, 'utf8'), archiveUrl, sha256);
      writeFileSync(FORMULA, updated);
      console.log(`updated Formula/cq.rb: url + sha256 (${sha256})`);
      formulaUpdated = true;
    } catch (err) {
      console.error(`warning: could not download/hash the release archive: ${err.message}`);
    }
  }

  printManualSteps({ tag, archiveUrl, formulaUpdated, dryRun });
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
