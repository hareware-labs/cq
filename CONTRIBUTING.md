# Contributing to cq

Thanks for taking an interest. cq is maintained by one person in spare time, so the
process below is mostly about keeping review cheap.

## Before you write code

- **Bugs:** open an issue with the bug template. A failing fixture beats a description.
- **Features and behaviour changes:** open an issue or a discussion first and wait for a
  yes. Pull requests for unagreed features will usually be closed, however good they are.
- **Questions and ideas:** use [Discussions](https://github.com/hareware-labs/cq/discussions),
  not issues.
- **Security problems:** never in public. See [SECURITY.md](SECURITY.md).

Typo and doc fixes can go straight to a pull request.

## Ground rules

These come from [ARCHITECTURE.md](ARCHITECTURE.md) and [CLAUDE.md](CLAUDE.md); read them
before changing anything structural.

- **Check the CLI, don't recall it.** Every flag and event shape was confirmed against the
  real `claude` binary. If you claim the CLI behaves differently, include the output.
- **Tests never spend usage.** New scheduler behaviour needs a fixture-driven test under
  `test/` (see `test/fake-bin/claude` and `test/fixtures/`).
- **`src/limits/` stays pure:** no clock, files or processes.
- **One dependency.** cq depends on `commander` and nothing else. A new dependency needs a
  justification in ARCHITECTURE.md §6 and an agreed issue first.
- **Platform code** lives only in `src/notify/` and `src/daemon/`.
- **`docs/STATUS.json` stays honest.** If you change what is tested or verified, update it.

## Pull requests

1. Fork, branch from `main`, keep the change to one concern.
2. `npm ci && npm test && npm run typecheck` must pass locally. CI runs the same, plus a
   syntax check of `Formula/cq.rb`.
3. Fill in the pull request template. Link the issue it closes.
4. Pull requests are squash-merged, so the title becomes the commit message: write it in
   the imperative ("Park on seven-day windows"), not as a ticket number.

Workflows from first-time contributors wait for a maintainer to approve them; that is a
repository setting, not a judgement.

## Sharing logs

`.cq/logs/*.jsonl` contain full prompts, file contents and absolute paths from your
machine. Trim them to the relevant events and redact before attaching them anywhere.

## Conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
