# Releasing cq through Homebrew

How cq ships, why it ships that way, and the exact steps for a release. Decisions checked
against Homebrew 6.0.15 (2026-09-09); the formula was verified end to end on Homebrew
7.0.9 (2026-10-22, see §4).

## 1. A tap, not homebrew-core

**Decision: own tap.** Homebrew's `Package-Acceptance-Policy.md` requires public interest
beyond the author: 30 forks, 30 watchers or 75 stars — and **90/90/225 for a
self-submission by the repository owner**, which this would be. A repo under 30 days old is
normally ineligible. cq meets none of it.

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
`bin.install_symlink libexec.glob("bin/*")`.

`std_npm_args` defaults to `prefix: libexec` and does a `--global` install of an
`npm pack` tarball, so `commander` is vendored out of reach of a global
`node_modules` and devDependencies (typescript) are excluded. No build step to run:
`bin/cq.js` already has its `#!/usr/bin/env node` shebang and mode bit, and the `node`
formula clears the `>=22` floor.

## 4. What has been verified

On 2026-10-22, against Homebrew 7.0.9 on macOS (arm64), `Formula/cq.rb` was installed from a
local tap using a `git archive --prefix=cq-0.1.0/` tarball — the same layout as GitHub's
tag archive:

- `brew install` succeeds; the keg holds `bin/cq` and vendors only `commander`
  (devDependencies are excluded).
- `brew test` passes (`cq --version` prints the package version).
- `brew audit --strict` reports nothing.

Not yet verified: installing from the real tap with a real GitHub archive. That happens at
the first release (step 7 below), and its result belongs in `docs/STATUS.json`.

## 5. The release artifact

GitHub's tag archive, `https://github.com/hareware-labs/cq/archive/refs/tags/vX.Y.Z.tar.gz`,
which unpacks to `cq-X.Y.Z/`. GitHub serves it anonymously only once the tag is pushed and
the repo is public, so the `sha256` can't be known until then. Always take it from the file
actually downloaded.

## 6. One-time setup: the tap repo

1. Create the public repo `hareware-labs/homebrew-tap` with only a README.
2. In it, add `Formula/` (an empty `.gitkeep` is fine). `brew tap hareware-labs/tap` clones
   it; a formula appears there at the first release.

## 7. Cutting a release

Tags are `vMAJOR.MINOR.PATCH`. `package.json` is the source of truth; the tag follows it.
Run everything from a clean `main` that matches `origin/main`.

1. **Check.** `npm ci && npm test && npm run typecheck` pass, and `docs/STATUS.json` is
   current.
2. **Tag.** `node scripts/release.mjs X.Y.Z` bumps `package.json` and `package-lock.json`
   (committing `Release vX.Y.Z` if the version changed) and creates an annotated tag.
   Add `--dry-run` to see what it would do.
3. **Push.** `git push origin vX.Y.Z`, then `git push origin main` if there was a bump.
4. **Hash.** `node scripts/release.mjs X.Y.Z --formula` downloads the tag's archive, hashes
   it and writes the `url` and `sha256` lines in `Formula/cq.rb`. It exits non-zero if the
   archive can't be fetched (tag not pushed, or repo private).
5. **Commit the formula** here: `git commit -m "Formula: cq vX.Y.Z" Formula/cq.rb` and push.
6. **Publish to the tap.** Copy `Formula/cq.rb` to `Formula/cq.rb` in the tap checkout,
   commit `cq vX.Y.Z` and push.
7. **Verify as a user.**
   ```sh
   brew update
   brew install hareware-labs/tap/cq    # or: brew upgrade cq
   brew test hareware-labs/tap/cq
   cq --version                         # prints X.Y.Z
   ```
8. **Record it.** Create a GitHub release from the tag with the notable changes, and note
   the verification in `docs/STATUS.json`.

The tag always exists before the tap names it; otherwise anyone who taps in between gets a
broken install. If step 7 fails, fix forward with a patch release. Never move a pushed
tag: the archive's hash changes and every existing install breaks its checksum.

## 8. Testing a formula change without releasing

To check an edit to `Formula/cq.rb` before a release, install it from a throwaway local
tap pointed at a local tarball:

```sh
git archive --format=tar.gz --prefix=cq-X.Y.Z/ -o /tmp/cq-X.Y.Z.tar.gz HEAD
brew tap-new --no-git cqtest/local
TAP=$(brew --repository)/Library/Taps/cqtest/homebrew-local
sed -e "s|^  url .*|  url \"file:///tmp/cq-X.Y.Z.tar.gz\"|" \
    -e "s|^  sha256 .*|  sha256 \"$(shasum -a 256 /tmp/cq-X.Y.Z.tar.gz | cut -d' ' -f1)\"|" \
    Formula/cq.rb > "$TAP/Formula/cq.rb"
brew install cqtest/local/cq && brew test cqtest/local/cq && brew audit --strict cqtest/local/cq
HOMEBREW_NO_AUTOREMOVE=1 brew uninstall cqtest/local/cq && brew untap cqtest/local
```

`brew test` needs the formula linked; if an `npm link`ed `cq` already owns
`$(brew --prefix)/bin/cq`, run `brew link --overwrite cq` first and `npm link` again after.
`HOMEBREW_NO_AUTOREMOVE=1` stops the uninstall from also removing unrelated formulae that
Homebrew considers orphaned.
