#!/usr/bin/env node
// Prepares a cq release per docs/RELEASING.md, in two runs because GitHub only
// serves a tag's archive once the tag is pushed:
//   node scripts/release.mjs X.Y.Z             bump the version, commit, tag
//   node scripts/release.mjs X.Y.Z --formula   after pushing the tag: download
//                                              its archive, hash it, fill in
//                                              Formula/cq.rb
// It never pushes or publishes anything — the steps that touch a remote (git
// push, syncing the formula to the tap repo, `brew install`/`brew test`) are
// printed for a human to run.
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
  console.error('usage: node scripts/release.mjs <version> [--formula] [--dry-run]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const formulaOnly = args.includes('--formula');
  const version = args.find((a) => !a.startsWith('--'));
  if (!version) usageError('missing <version> argument, e.g. 0.2.0');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    usageError(`'${version}' is not a plain X.Y.Z version (pass 0.2.0, not v0.2.0)`);
  }
  return { version, tag: `v${version}`, dryRun, formulaOnly };
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

// The formula's url moves with the version in the same commit, so the tagged
// tree passes the url/version drift test. Its sha256 can't be known until the
// tag is pushed; --formula fills it in.
const PLACEHOLDER_SHA256 = '0'.repeat(64);

function pointFormulaAt(tag, dryRun) {
  const url = archiveUrlFor(tag);
  if (dryRun) {
    console.log(`would point Formula/cq.rb at ${url} with a placeholder sha256`);
    return;
  }
  writeFileSync(FORMULA, withFormulaUrlAndSha(readFileSync(FORMULA, 'utf8'), url, PLACEHOLDER_SHA256));
  console.log(`pointed Formula/cq.rb at ${url}`);
}

function commitVersionBump(tag, dryRun) {
  if (dryRun) {
    console.log(`would run: git commit -m "Release ${tag}" package.json package-lock.json Formula/cq.rb`);
    return;
  }
  git(['add', 'package.json', 'package-lock.json', 'Formula/cq.rb']);
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

function checkTagPresent(tag) {
  if (git(['tag', '--list', tag]).trim() !== tag) {
    console.error(`error: tag ${tag} does not exist locally; run without --formula first.`);
    process.exit(1);
  }
}

function printTagSteps({ tag, version, dryRun }) {
  console.log('');
  console.log('Next (this script does not push):');
  console.log('  1. Push the tag, then the release commit if there was a version bump:');
  console.log(`       git push origin ${tag}`);
  console.log('       git push origin main');
  console.log('  2. Fill in the formula from the pushed tag\'s archive:');
  console.log(`       node scripts/release.mjs ${version} --formula${dryRun ? ' --dry-run' : ''}`);
}

function printFormulaSteps({ tag, archiveUrl, formulaUpdated }) {
  console.log('');
  if (!formulaUpdated) {
    // Usually the tag isn't pushed yet, or the repo isn't public: GitHub
    // serves archives anonymously only for public repos.
    console.log('The archive could not be hashed. Check the tag is pushed and the repo');
    console.log('is public, then re-run with --formula. To hash it by hand:');
    console.log(`       curl -fL ${archiveUrl} -o /tmp/cq-${tag}.tar.gz`);
    console.log(`       shasum -a 256 /tmp/cq-${tag}.tar.gz`);
    return;
  }
  console.log('Next (this script does not do these):');
  console.log('  1. Commit and push the formula here:');
  console.log(`       git commit -m "Formula: cq ${tag}" Formula/cq.rb && git push origin main`);
  console.log('  2. Publish it in the tap (github.com/hareware-labs/homebrew-tap):');
  console.log('       cp Formula/cq.rb <tap-checkout>/Formula/cq.rb');
  console.log(`       cd <tap-checkout> && git commit -am "cq ${tag}" && git push`);
  console.log('  3. Verify like a user would:');
  console.log('       brew update && brew install hareware-labs/tap/cq');
  console.log('       brew test hareware-labs/tap/cq && cq --version');
}

async function tagRelease({ version, tag, dryRun }) {
  checkWorkingTreeClean();
  checkTagAbsent(tag);

  const { changed } = updateVersions(version, dryRun);
  if (changed) {
    pointFormulaAt(tag, dryRun);
    commitVersionBump(tag, dryRun);
  }

  createTag(tag, dryRun);
  printTagSteps({ tag, version, dryRun });
}

async function fillFormula({ tag, dryRun }) {
  checkWorkingTreeClean();
  checkTagPresent(tag);

  const archiveUrl = archiveUrlFor(tag);
  if (dryRun) {
    console.log(`would download ${archiveUrl}`);
    console.log('would compute its sha256 and write the url/sha256 lines in Formula/cq.rb');
    return;
  }
  let formulaUpdated = false;
  try {
    const sha256 = await downloadAndHash(archiveUrl);
    const updated = withFormulaUrlAndSha(readFileSync(FORMULA, 'utf8'), archiveUrl, sha256);
    writeFileSync(FORMULA, updated);
    console.log(`updated Formula/cq.rb: url + sha256 (${sha256})`);
    formulaUpdated = true;
  } catch (err) {
    console.error(`warning: could not download/hash the release archive: ${err.message}`);
  }
  printFormulaSteps({ tag, archiveUrl, formulaUpdated });
  if (!formulaUpdated) process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.dryRun) console.log(`--dry-run: no files, commits, or tags will be changed\n`);
  await (args.formulaOnly ? fillFormula(args) : tagRelease(args));
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
