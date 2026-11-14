# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.3] - 2026-11-14

### Fixed

- Require complete, explicit verdict metadata and action-specific rationales;
  malformed replies and contradictory critical/high-risk allows retry, then
  block as technical failures. Custom policy cannot weaken this core floor.
- Always display supplied risk, authorization (including unknown) and rationale.
- Clarify intrinsic protected-branch risk, read-only Git inspection and local
  packaging versus public payload disclosure.

### Added

- Sanitized result provenance: package version, complete-verdict contract version
  and SHA-256 of the exact reviewer instructions; historical results remain
  replayable and are labeled legacy in review evidence.
- Opt-in three-arm frozen-input evaluation: plugin Sonnet 5.5 and explicitly
  requested GPT-6.1 at low effort plus the native Codex automatic approval
  reviewer baseline, with 84 sequential assessments. The separate 56-review
  scripted smoke never invokes native providers. Reports distinguish plugin
  gating from native skips/unavailability and non-identical prompt conditions.
  Risk bands tolerate classification variation while preserving required denials;
  provider refusals and native skips remain explicit non-assessments.

## [0.2.2] - 2026-11-14

### Changed

- Distribute the plugin publicly on npm as `@nickf93/omp-automode`, with
  `CHANGELOG.md` included in the published package.
- Correct installation examples and document the npm release procedure,
  GitHub alternative and explicit migration from the unscoped installation.

### Fixed

- Use `@nickf93/omp-automode` for plugin settings reads and writes. Existing
  global and project settings need an explicit key migration; commands and
  persisted session history keep their existing identity.
- Align the lockfile package identity with the scoped package.

## [0.2.1] - 2026-11-14

### Fixed

- `write` and `edit` paths in a `[[…]]` wrapper are unwrapped once, as OMP
  does, so the gate judges the exact file the tool writes.
- A stored session choice with an empty reviewer model or effort is ignored
  when the session is restored, instead of being read as "no model".
- A reviewer model request that stays silent for half of `timeoutMs` is
  treated as stalled and retried, instead of using up the whole review
  deadline. Models whose catalog entry sets its own stream timeouts keep them.
- The allow notice no longer shows "authorization: unknown" for a short-form
  allow; it shows only the risk.

### Changed

- Policy: deleting user data that existed before the agent's work and that
  the request did not cover (documents, records, archives) is high risk
  however small, so a script that also removes such data is denied unless
  authorized.
- Internal cleanup: the `/auto-review` command dialogs live in their own
  module, agent-facing texts live with the policy, and dead code is removed.
  No change to commands, settings or stored sessions.
- Live scenarios: a scripted denial case covers the denial reason, an approved
  retry used once, the circuit breaker, cancelling `/auto-review off`, and
  invalid settings. The real-model denial workflow now reports pass or fail
  for each check.

## [0.2.0] - 2026-11-13

### Added

- `/auto-review` subcommands `show`, `config`, `on`, `off`, `approve`, `save`
  and `reload`, with Tab completion. `/approve` is now an alias of
  `/auto-review approve`.
- `/auto-review off` turns automatic review fully off for the session and its
  subagents after confirmation: no review and no shell rules. The status bar
  shows `auto-review OFF` in red, and a resumed session that is off says so.
- `/auto-review show` lists the effective configuration and where each value
  comes from: session, project settings, user settings or default.
- `/auto-review config` changes the timeout, shell rules and extra policy for
  the session, besides the reviewer model and effort.
- `/auto-review save` writes the session's changes to the user plugin settings.

### Changed

- Plain `/auto-review` shows the configuration; the model and effort dialog
  moved to `/auto-review config`.
- Subagents follow the session's on/off switch and session changes, including
  the reviewer model and effort chosen for the session.

## [0.1.0] - 2026-11-13

First release: an OMP plugin that reviews the agent's tool calls before they
run, so the agent can work without per-action approval prompts.

### Added

- Synchronous review of tool calls in the `tool_call` hook, for the root
  session and subagents. Reads, searches, control tools, read-only MCP tools
  and local edits inside the working directory (outside `.git`, `.agents` and
  `.omp`) run without review; mounted `xd://` tools are reviewed once as the
  tool they dispatch.
- Shell rules (`rules`): argv-prefix `allow` and `forbidden` decisions for
  literal command sequences joined by `&&`, `||`, `;`, `|` or newlines. A
  forbidden match blocks; an allow skips review only when every command
  matches; anything else is reviewed.
- Reviewer with a risk and authorization policy, a replaceable policy and
  template (`policy`, `policyTemplate`, `extraPolicy`), and additional rules
  for browser and computer actions.
- Evidence built from the raw session branch: your messages, AGENTS.md
  context, answers given through `ask`, skills you invoked and plans you
  approved are trusted; tool output, assistant text, skill bodies, summaries
  and delegated tasks are labelled untrusted. Per-entry and total limits with
  explicit omission notices.
- Read-only, network-less investigation tools for the reviewer (commands with
  stdin, batch and wait, image viewing) under bubblewrap, with no unsandboxed
  fallback.
- Up to three attempts sharing one deadline (`timeoutMs`, default 90 s), with
  provider retry-after hints honoured and context recovery before giving up.
- Manual confirmation of the exact pending call when the action and its
  minimum evidence cannot fit the reviewer model's context.
- `/auto-review` to show and change the reviewer model and effort for the
  session, and `/approve` for one reviewed retry of a recent denial after you
  confirm the full action.
- A circuit breaker that interrupts the run after 3 consecutive denials or 10
  denials in the last 50 reviews.
- Session-persisted selections and review history, restored on resume and
  branch changes without restoring any usable approval.
- Opt-in live scenarios under `test/live/`, including scripted-trigger cases.

### Known limitations

- An in-flight review is not cancelled the moment OMP aborts the hook; the
  host still blocks the aborted call, and the review ends at its deadline or
  with the run.
- The main agent is not sandboxed, so for reviewed calls the reviewer model is
  the only check; choose a capable model.
- Pinned to OMP 18.19.0 through imports of host internals.

[Unreleased]: https://github.com/NickF93/omp-automode/compare/v0.2.3...develop
[0.2.3]: https://github.com/NickF93/omp-automode/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/NickF93/omp-automode/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/NickF93/omp-automode/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/NickF93/omp-automode/releases/tag/v0.2.0
[0.1.0]: https://github.com/NickF93/omp-automode/releases/tag/v0.1.0
