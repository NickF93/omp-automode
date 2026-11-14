# omp-automode

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (OMP) plugin that lets the
agent work without per-action approval prompts. Before a tool call runs, an
independent AI reviewer checks it against a risk policy and the conversation,
then allows it or blocks it with a reason the agent must follow. The reviewer's
model and reasoning effort are configurable.

## Requirements

- OMP 18.19.0 and Bun 1.4.4 or newer.
- `tools.approvalMode: yolo` (for example `omp --approval-mode yolo`). The
  plugin replaces per-action prompts; it does not add its own approval dialogs
  for ordinary actions.
- [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) on `PATH`
  for the reviewer's read-only investigations.

## Installing

```bash
omp install @nickf93/omp-automode
```

To pin this release, use `omp install @nickf93/omp-automode@0.2.3`.

Alternatively, install the tagged source from GitHub:

```bash
omp install github:NickF93/omp-automode#v0.2.3
```

The `#v…` suffix pins a release; without it the default branch is installed.
OMP installs npm and GitHub packages for the user. `--scope project` is only
supported for marketplace plugins, not these installs. Choose one installation
source, not both.

Remove the package with `omp plugin uninstall @nickf93/omp-automode`, or turn it
off with `/plugins disable @nickf93/omp-automode`. For one run without installing:
`omp -e /path/to/omp-automode`. When the plugin is not loaded, nothing is
reviewed.

### Migrating from the unscoped package

1. **Before uninstalling**, record the old global settings: copy the values under
   `settings["omp-automode"]` in `~/.omp/plugins/omp-plugins.lock.json`.
   Uninstalling deletes those settings. Keep any backup outside the repository
   and do not share it: custom policy text may contain private information.
2. Remove the old GitHub installation with `omp plugin uninstall omp-automode`.
   Leaving it installed alongside the scoped package can load the extension twice.
3. Install `omp install @nickf93/omp-automode`.
4. Reapply the recorded settings with
   `omp plugin config set @nickf93/omp-automode <key> <value>` for each key,
   quoting JSON values.
5. In each project's `.omp/plugin-overrides.json`, rename the `settings`
   key `omp-automode` to `@nickf93/omp-automode`, preserving its values.
   Restart OMP after migrating.

There is no automatic settings migration or fallback to the old key.
The `/auto-review` commands and persisted session history identity are unchanged.

## How a tool call is handled

| Tool call | Handling |
|---|---|
| `read`, `grep`, `glob`, `find`, `ast_grep`, `web_search`, LSP queries | Runs without review |
| `ask`, `todo`, `wait`, `task` and other session/agent control tools | Runs without review; a subagent's own calls are still checked |
| Writes to `local://`, `agent://`, `proc://` | Runs without review |
| `write`, `edit`, `ast_edit` | Runs without review when every source and destination is inside the working directory and outside `.git`, `.agents` and `.omp` (after resolving symlinks); otherwise reviewed |
| LSP renames, file renames, applied code actions and raw requests | Reviewed (the language server chooses which files change) |
| `ssh://` and other remote writes | Reviewed |
| `bash` | A `forbidden` rule matching any command blocks it; when every command matches an `allow` rule it runs; otherwise reviewed |
| `eval`, `debug`, browser/computer use, unknown tools | Reviewed |
| MCP tools | Run without review only when they declare `readOnlyHint: true` |
| `write xd://<tool>` | Checked exactly like a direct call of `<tool>`, once |

Shell rules match whole argv words after quote removal. Only commands made of
literal words joined by `&&`, `||`, `;`, `|` or newlines can match a rule;
anything needing shell interpretation (variables, substitutions, globs,
redirections, assignments, subshells) is reviewed instead. This applies to
`forbidden` rules too: `git push 2>&1` does not match `["git", "push"]` and is
reviewed rather than blocked.

### Review outcomes

- **Allow**: the action runs and a notice shows the supplied risk, authorization
  and action-specific rationale, including explicit `unknown` authorization.
- **Deny**: the action does not run. The agent is told not to work around the
  denial, to choose a safer route or ask you, and to retry only after your
  informed approval. Denials also show all three assessment attributes.
- **Failure or timeout**: the action does not run, and the agent is told this
  is not a finding that the action is unsafe. A model request that stays
  silent for half of `timeoutMs` counts as stalled and is retried within the
  same deadline, so a model that thinks silently for longer than that times
  out; raise `timeoutMs` for such models. Models whose catalog entry sets its
  own stream timeouts keep them.
- **Context too large**: when the action and its minimum evidence cannot fit
  the reviewer model's context, you are asked to confirm that exact call
  manually; without an interactive answer it stays blocked.

Every accepted verdict must explicitly supply `risk_level`, `user_authorization`,
`outcome` and a nonblank rationale. Missing, malformed or policy-inconsistent
replies retry within the existing three-attempt deadline, then block as technical
failures, not policy denials. Explicit `unknown` is a valid assessment, not missing
data. Field completeness and the core decision table are enforced locally;
semantic classification, authorization scope and explanation quality remain
model-dependent. An authorized protected/default-branch mutation is still high
risk; read-only inspection is not a mutation.

New results record the package version, `complete-v1` contract marker and
SHA-256 of the exact reviewer instructions, not raw replies or private reasoning.
Existing session records still replay; earlier reviews without that marker are
labeled legacy because field completeness was not recorded. Provenance and prior
decisions are context, never trusted authorization.

Three consecutive denials, or ten denials among the last fifty reviews in one
run, interrupt the run so you can redirect it.

Denials arrive as ordinary tool errors. The agent can use OMP's `ask` tool to
explain the risk and get your decision.

## Commands

`/auto-review [show|config|on|off|approve|save|reload]`; Tab completes the subcommand.

- `show` (also plain `/auto-review`): whether review is on, the reviewer model
  and effort, timeout, shell rules, extra policy, policy and template, each with
  where it comes from (session, project settings, user settings or default),
  the unsaved session changes and the number of recent denials. Custom policy
  texts are shown whole.
- `config`: change the reviewer model, effort, timeout, shell rules (edited as
  JSON) or extra policy for this session, or clear the session's changes. A
  value equal to the settings counts as no change.
- `off`: after you confirm, turn automatic review off for this session and its
  subagents. Off means off: every tool call runs without review and without
  shell rules, `forbidden` rules included. The status bar shows
  `auto-review OFF` in red, and a resumed session that is off says so.
- `on`: turn it back on.
- `approve`: pick one of the last ten denials on this branch, review the full
  action and its risk, and confirm to approve one reviewed retry of exactly that
  action. The reviewer still runs, now knowing you approved it; a changed action
  is reviewed normally. Approvals are not restored after a resume or branch
  change; the denial list is. `/approve` is an alias.
- `save`: after you confirm, write the session's changes to your user plugin
  settings (the ones `omp plugin config set` writes), so new sessions in every
  project use them. A value the project settings override stays a session
  change, and the confirmation says so.
- `reload`: re-read the settings files now, for example after editing them with
  `omp plugin config set` or by hand, refresh the status bar and the review
  deadline, and show the result. Reviews already read the settings on every
  call; `reload` makes an external edit visible immediately and reports
  invalid values.

On/off and session changes are kept in the session, restored on resume and
branch changes, and followed by subagents.

## Configuration

Settings use OMP's plugin configuration: `/auto-review config` then
`/auto-review save`, or
`omp plugin config set @nickf93/omp-automode <key> <value>` in a shell
(quote JSON values: `'[{"prefix":["git","status"],"decision":"allow"}]'`).
Project overrides go in `.omp/plugin-overrides.json`, for example:

```json
{
  "settings": {
    "@nickf93/omp-automode": {
      "model": "anthropic/claude-sonnet-4-5",
      "effort": "low",
      "timeoutMs": 90000
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `model` | session model | Reviewer model, e.g. `anthropic/claude-sonnet-4-5` |
| `effort` | `low` if supported, else the model default; with the session model, the session's effort | Reviewer reasoning effort |
| `timeoutMs` | `90000` | Deadline for one review, shared by up to three attempts |
| `rules` | `[]` | Shell rules: JSON array of `{"prefix": ["git", "status"], "decision": "allow" \| "forbidden"}` |
| `policy` | built-in | Replaces the security policy section |
| `extraPolicy` | empty | Added after the security policy |
| `policyTemplate` | built-in | Replaces the whole template; it may use `{{ tenant_policy_config }}` and `{{ extra_policy }}` |

Custom policy/template/extra policy may add restrictions but cannot weaken the
mandatory complete-output contract or core floor: critical risk never allows,
and high risk allows only with medium or high authorization (plus the policy's
scope and specific-rule requirements). Low/medium risk can allow with explicit
unknown authorization when no denial rule applies; no new approval ceremony is
imposed.

An unavailable model or an effort the model does not support is reported as a
review failure; the plugin never substitutes another model.

The plugin raises OMP's `extensionHandlers.toolCallTimeoutMs` for the current
session to at least `timeoutMs + 5000` while it is loaded, without saving it.

### Choosing the reviewer model

The main agent is not sandboxed, so for calls that go to review the reviewer is
the only check before the command runs (`forbidden` rules block earlier; skipped
calls are not reviewed). Its decisions are only as good as its model: pick a
capable model for `model` (or through `/auto-review`) rather than the smallest
tier of a family. In one comparison on the same fixture, a small model at low
effort allowed a cleanup script without checking the unrelated archive it also
deleted, while a larger model at the same effort inspected the target and denied
it. That is a single observation, not a measured rate.

Some outcomes stay a matter of the model's judgment rather than of this plugin.
One example is whether a restriction in the repository's AGENTS.md outweighs
your direct request. Asked explicitly to delete a remote branch that such a
rule says needs approval naming its pull request, the tested reviewer allowed
the deletion; a stricter model may deny it. Spell such conditions out in your
request or in `extraPolicy` when the outcome matters.

## What the reviewer sees

The reviewer gets the exact planned action, your messages and other trusted
instructions in order (AGENTS.md context, answers you gave through `ask`, skills
you invoked, plans you approved, approvals from `/approve`), recent transcript
evidence labelled as untrusted, and its earlier decisions. Assistant reasoning
is not sent. Large evidence is shortened with explicit markers, and the
reviewer is told what was omitted.

It may run read-only commands to check local state, inside bubblewrap with the
whole filesystem read-only, a private `/tmp` and `/run`, and no network. Files
under `/tmp` are therefore not visible to it. If the sandbox cannot start, the
review fails rather than running anything unsandboxed.

## Limits

- The main agent is not sandboxed; only the reviewer's investigations are.
- OMP's bash tool keeps one shell per session, so functions, aliases, `PATH`
  and directory changes made by an earlier (reviewed) call persist. A later
  command skipped by an `allow` rule runs in that shell state.
- Calls the plugin skips (see the table) are not reviewed.
- If another extension rewrites a tool's input after this plugin has reviewed
  it, the rewritten input runs.
- Imports of host internals (`config`, `config/settings`, `config/registry`,
  `extensibility/plugins` including `PluginManager` for `/auto-review save`,
  `@oh-my-pi/pi-ai/error`) are pinned to OMP 18.19.0.

## Development

```bash
bun install
bun run check
bun run test
```

## License

[MIT](LICENSE)
