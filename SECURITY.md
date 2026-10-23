# Security policy

## Reporting a vulnerability

Report privately through
[GitHub's private vulnerability reporting](https://github.com/hareware-labs/cq/security/advisories/new).
Please don't open a public issue, discussion or pull request for a security problem.

Include the cq version (`cq --version`), how to reproduce it, and what an attacker gains.
Expect an acknowledgement within a week. Fixes ship as a patch release and an advisory.

## Supported versions

Only the latest release is supported.

## Scope

cq runs Claude Code unattended, by default with `--permission-mode bypassPermissions`,
inside a repository you point it at. That mode is a documented choice, not a
vulnerability; see the README. In scope are things like:

- a task, task file or stream event that makes cq itself execute unintended commands
- cq writing outside the target repository or its own state directories
- secrets or environment leaking into logs, notifications or launchd plists beyond what
  the docs describe
