# Releasing cq through Homebrew

Decisions and reasons; the formula is a later task. Checked against Homebrew 6.0.15
and live URLs, 2026-09-09.

## 1. A tap, not homebrew-core

**Decision: own tap.** Homebrew's `Package-Acceptance-Policy.md` requires public interest
beyond the author: 30 forks, 30 watchers or 75 stars — and **90/90/225 for a
self-submission by the repository owner**, which this would be. A repo under 30 days old is
normally ineligible, and non-GitHub hosting only gets "equivalent public evidence"
*considered*. cq meets none of it.

## 2. Where the tap lives

**Decision: `https://github.com/hareware-labs/homebrew-tap`**, beside the source. One
host to maintain, and `brew tap user/repo` clones `github.com/user/homebrew-repo`, so
the short one-argument form works.

```sh
brew tap hareware-labs/tap
brew install hareware-labs/tap/cq
```

The repo must be named `homebrew-tap`; `brew` strips the prefix.

## 3. Install strategy: npm into `libexec`, symlink the bin

**Decision:** `depends_on "node"`, then `system "npm", "install", *std_npm_args` and
`bin.install_symlink Dir["#{libexec}/bin/*"]`.

`std_npm_args` defaults to `prefix: libexec` and does a `--global` install of an
`npm pack` tarball, so `commander` is vendored out of reach of a global
`node_modules` and devDependencies (typescript) are excluded. No build step to run:
`bin/cq.js` already has its `#!/usr/bin/env node` shebang and mode bit, and the `node`
formula clears the `>=22` floor.

## 4. The release artifact

GitHub's `.../archive/refs/tags/TAG.tar.gz` tag archive.

**Unverified for cq:** no tags exist yet. Homebrew fetches anonymously, so **the repo
must be public before the first release.** Re-verify the URL then, and take `sha256` from the file actually downloaded —
host-generated archives are not guaranteed byte-stable across git versions.

## 5. Versioning and order of operations

Tags are `vMAJOR.MINOR.PATCH` (`v0.1.0`), matching the archive path and the README's
"v0.1". `package.json` is the source of truth; the tag follows it.

1. `npm test` green, `docs/STATUS.json` current.
2. Bump `package.json` version, commit.
3. `git tag -a v0.1.0 -m 'cq v0.1.0'`, `git push --follow-tags`.
4. Download the archive, `shasum -a 256` it.
5. Update `url` and `sha256` in the tap; `brew install` and `brew test` from a clean prefix.

The tag always exists before the formula names it; otherwise anyone who taps in between
gets a broken install.
