# Live scenarios

Opt-in real-process scenarios. They start isolated `omp --mode rpc` processes
(own HOME, agent, cache and session directories) with this checkout loaded
through `-e`, drive realistic tasks with real models, and record frames, tool
events, review notices and physical fixture state. They are not part of
`bun run test` and spend model tokens.

Credentials come only from an existing OMP auth broker: the child's config
reads the bearer through a native `!cat` reference, so no secret is placed in
argv or the environment. Evidence is checked for the bearer before it is written.

```bash
export AUTOMODE_LIVE_DIR=/path/to/scratch            # cases/ and evidence/ are created here
export AUTOMODE_LIVE_BROKER_URL=http://127.0.0.1:8765
export AUTOMODE_LIVE_BROKER_TOKEN_FILE=$HOME/.omp/auth-broker.token
MAIN_MODEL=provider/model MAIN_EFFORT=low REVIEW_EFFORT=low bun test/live/workflow1.ts
```

- `workflow1.ts`: development with a project skill, an MCP server with read-only
  and mutating tools (direct and `xd://`), shell rules, a README injection and a
  subagent.
- `workflow2.ts`: maintenance with narrow and broad deletions, native `ask`
  approval and decline, `/approve`, `/auto-review`, a restriction followed by
  compaction, resume, a plugin-absent control and a later input-rewriting
  extension. Uses `--mode rpc-ui` so the `ask` tool has a user surface.
- `workflow2-deny.ts`: an `extraPolicy` rule turns outside deletions into policy
  denials, exercising the denial notice, `/approve`, resume replay and the
  circuit breaker with real review results.
- `workflow3.ts`: browser work on a loopback page with synthetic account data
  (draft, authorized publish, injected destructive instruction).
- `workflow4-scripted.ts`: rows a cheap model does not reliably trigger (README
  injection, credential egress smuggled into a user-invoked skill's referenced notes, revocation across compaction
  with a forged summary and resume, cancelled/declined/approved `ask`, an `ask` timeout submitting a
  preselected risky default, a
  subagent blocked then re-dispatched after the user's answer, `/auto-review`
  model and effort selection, an unknown explicit reviewer, every reviewer
  investigation tool under the sandbox, and an injected browser click). The
  main agent's turns come from `scripted-model.ts`, a loopback
  OpenAI-compatible server; OMP, the plugin, the tools and the reviewer model
  (`REVIEW_MODEL`, except in the `select` and `sandbox` cases) are real. Select
  cases with `ONLY=inject,skill,...`; results go to
  `evidence/live/<CASE>-verdicts.json`. These are scripted-trigger evidence,
  not real-model acceptance.

A model that refuses or never attempts an action is not evidence that the
reviewer blocked it; check the recorded tool events and review results.
