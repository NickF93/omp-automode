# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/NickF93/omp-automode/releases/tag/v0.1.0
