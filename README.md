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

## Loading

The package declares its entry in `package.json` (`omp.extensions`). Load it
for one run with `omp -e /path/to/omp-automode`, or install it as an OMP plugin.
When the plugin is not loaded, nothing is reviewed.

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

- **Allow**: the action runs and a notice shows risk, authorization and the
  reason.
- **Deny**: the action does not run. The agent is told not to work around the
  denial, to choose a safer route or ask you, and to retry only after your
  informed approval.
- **Failure or timeout**: the action does not run, and the agent is told this
  is not a finding that the action is unsafe.
- **Context too large**: when the action and its minimum evidence cannot fit
  the reviewer model's context, you are asked to confirm that exact call
  manually; without an interactive answer it stays blocked.

Three consecutive denials, or ten denials among the last fifty reviews in one
run, interrupt the run so you can redirect it.

Denials arrive as ordinary tool errors. The agent can use OMP's `ask` tool to
explain the risk and get your decision.

## Commands

- `/auto-review`: show the effective reviewer model and effort and where each
  comes from; change either for this session, or return to the configured
  defaults. Choices are saved in the session and restored on resume.
- `/approve`: pick one of the last ten denials on this branch, review the full
  action and its risk, and confirm to approve one reviewed retry of exactly that
  action. The reviewer still runs, now knowing you approved it; a changed action
  is reviewed normally. Approvals are not restored after a resume or branch
  change; the denial list is.

## Configuration

Settings use OMP's plugin configuration (`omp plugin config set omp-automode
<key> <value>`), with project overrides in `.omp/plugin-overrides.json`.

| Key | Default | Meaning |
|---|---|---|
| `model` | session model | Reviewer model, e.g. `anthropic/claude-sonnet-4-5` |
| `effort` | `low` if supported, else the model default; with the session model, the session's effort | Reviewer reasoning effort |
| `timeoutMs` | `90000` | Deadline for one review, shared by up to three attempts |
| `rules` | `[]` | Shell rules: JSON array of `{"prefix": ["git", "status"], "decision": "allow" \| "forbidden"}` |
| `policy` | built-in | Replaces the security policy section |
| `extraPolicy` | empty | Added after the security policy |
| `policyTemplate` | built-in | Replaces the whole template; it may use `{{ tenant_policy_config }}` and `{{ extra_policy }}` |

An unavailable model or an effort the model does not support is reported as a
review failure; the plugin never substitutes another model.

The plugin raises OMP's `extensionHandlers.toolCallTimeoutMs` for the current
session to at least `timeoutMs + 5000` while it is loaded, without saving it.

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
- Imports of host internals (`config/settings`, `config/registry`,
  `extensibility/plugins`, `@oh-my-pi/pi-ai/error`) are pinned to OMP 18.19.0.

## Development

```bash
bun install
bun run check
bun run test
```

## License

[MIT](LICENSE)
