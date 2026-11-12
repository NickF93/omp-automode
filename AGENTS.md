# Repository instructions

## Authority and scope

Niccolò Ferrari (`NickF93`) owns the repository and approves scope, exceptions
and merges. Explicit owner instructions take precedence.

This repository contains one OMP plugin: an automatic reviewer that allows or
blocks agent tool calls before they run. Do not widen it into a sandbox,
permission system or general agent framework. Do not add limits, restrictions
or process steps the owner has not requested.

## Engineering

- Correctness first, then maintainability. Keep the plugin small, with clear
  single-owner components; no dead code, shims, deprecated paths or hidden
  fallbacks.
- Use OMP's public extension API only; do not patch OMP.
- Third-party material keeps its license and attribution notices.
- Tests cover real behavior: decisions, boundaries, failures. Update the README
  when configuration or behavior changes.

## Workflow

- Where the `governed-git-flow` CLI is installed, use it for supported Git and
  GitHub operations and inspect its command help rather than guessing
  arguments. Otherwise use native Git and the GitHub CLI following
  [CONTRIBUTING.md](CONTRIBUTING.md); the rules below apply either way.
- Inspect origin, branch, identity and local changes first. Preserve unrelated
  work.
- Work starts from an assigned Issue on `feature/<issue>-<name>` or
  `bugfix/<issue>-<name>` from `develop`. Never commit or push directly to
  `main` or `develop`; verified fast-forward synchronization is allowed.
- Stage exact paths, review the staged diff, and commit only what was
  reviewed. Messages use English `type(scope): description`.
- Commits and GitHub content carry human attribution only; no AI, agent, model
  or tool creation credit.
- Push non-force; open an assigned, Issue-linked PR to `develop`.
- Merging needs an explicit owner instruction naming the PR. Use merge commits
  and keep source branches. Releases and tags need explicit scope.
