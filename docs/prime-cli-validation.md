# Three real Prime CLI clients with a zero-cost scripted provider

This runs the actual Prime source CLI with Node+tsx, `--mode rpc`, a real daemon
session worker, AgentSession and Agent tool loop. Prompts go to the fixture
provider, which emits deterministic tool calls; the normal Agent validates and
executes EnvInHands tools. It does **not** manually invoke wrapped tools or
simulate Prime. The provider is zero-cost, not proof of intelligent autonomous
collaboration. Three Windows instances simulate participants, not three physical
or geographically separate hosts. Developer sessions only orchestrate them.

## Prepare and launch

Use the checked Prime checkout (commit61a643b or newer with the source-loader
fix), existing locked npm dependencies and Node24+. Use prepared Bun to run the
controller and Env's service. Do not run Prime build/dev/npm test.

Set absolute paths:

- `PRIME_AGENT_CHECKOUT`: the real prepared Prime root.
- `PRIME_VALIDATION_NODE`: actual Node executable; do not guess Program Files.
- `PRIME_AGENT_KERNEL_PYTHON`: an existing compatible kernel Python runtime to
  prevent automatic bootstrap. The actual CLI prewarms its kernel even if the
  scripted tool plan never calls Python. This runtime must pass Prime's own
  capability checks; do not substitute a fake Python. Installation needs separate
  approved preparation if absent; `PRIME_AGENT_INSTALL_UV=0` forbids auto-install.
- `PRIME_CLI_REPORT`: optional private report JSON destination.

Then from EnvInHands:

```text
<absolute-bun> run scripts/prime-cli-validation.mts
```

Without service configuration it starts real loopback HTTP/SQLite on port0 with
a random token. For the control VM, the operator can provide
`ENVINHANDS_VALIDATION_CONFIG` as an approved private JSON file containing
`{url,token}`, or securely inject `ENVINHANDS_URL` and `ENVINHANDS_TOKEN`.
Only values are injected into child environments. Never print/copy the token to
chat, argv, session prompts or reports. The operator must prepare the strict SSH
encrypted forward or HTTPS endpoint; this script does not disable host keys or
open a public service. The same real CLI flow then accesses that URL.

Each CLI has independent working directory, `PRIME_AGENT_CODING_AGENT_DIR`,
`--session-dir`, session ID, Agent label, daemon pipe/socket and settings. There
is **no `--agent-dir` option** in this source version; the environment variable is
the supported actual path. Settings disable built-in skills, telemetry, auto-refine
and automatic compaction only within these fixture directories. Provider keys
from the developer environment are not forwarded.

The real launch shape is:

```text
<node> <Prime>/node_modules/tsx/dist/cli.mjs <Prime>/packages/coding-agent/src/cli.ts
  --mode rpc --offline --daemon-socket <unique-own-socket>
  --session-dir <own-session-dir> --provider envinhands-validation --model scripted
  --no-skills --no-context-files --no-builtin-tools
  --extension <Env>/scripts/prime-validation-provider.ts
  --extension <Prime>/packages/coding-agent/examples/extensions/envinhands-heartbeat.ts
  --extension <Prime>/packages/coding-agent/examples/extensions/envinhands-messages.ts
  --extension <Prime>/packages/coding-agent/examples/extensions/envinhands-resources.ts
  --extension <Env>/src/integrations/prime.ts
  --extension <Env>/src/integrations/prime-execution.ts
```

CLI RPC `prompt` response means acceptance, **not completion**. The controller
awaits the actual `agent_end` event, then checks `tool_execution_end` and retained
real session results. It does not use readiness sleeps. Windows pipe paths use
`String.raw` to preserve backslashes. It shuts down only the daemons selected by
its own unique sockets through the real DaemonClient. Session evidence is
retained under the report's `retainedEvidenceRoot`; no claim is made that Windows
log handles release immediately on shutdown.

## Actual useful collaboration

A/B/C explicitly register their real session IDs, discover observed participants,
exchange a ring of review/check/result requests, pull twice, ack explicitly twice,
share source-loader interoperability experience as a resource note, and record
each real session's result with its immutable signature declaration. Fresh logical
run IDs keep distinct runs separate; idempotent retries inside a run retain the
same ID/content. Heartbeats are real session/agent lifecycle events, not manual
fabricated observations.

If `ENVINHANDS_EXECUTION_PROFILES` is present, it is passed as the approved local
profile JSON path. Each CLI gets its own `ENVINHANDS_CHANGE_SPOOL` directory.
The controller selects `ENVINHANDS_VALIDATION_PROFILE` or the first configured
profile and has A's actual Agent call `envinhands_execute` once with
`id -u && uname -s`. It checks actual outcome evidence. Profiles, host trust,
SSH identity and authority remain operator-owned. The script does not configure
keys/sudoers or turn sudo-n failure into ready. Readonly id/uname is not admin
readiness. Already dispatched remote work is not automatically replayed.

## Evidence and limits

Report fields include actual CLI PIDs, real session IDs/files, selected fixture
provider/zero monetary cost, event/tool result evidence and collaboration checks.
The CLI can create Python kernel/config/daemon/session artifacts within its own
scope; local ledger/retained evidence must be included in the implementing Agent's
change attribution. Explicit server record tools do not automatically audit every
external local/remote mutation. Shared bearer signature is not cryptographic
identity. No paid or real model is invoked by this fixture.

Local loopback success means the real normal Prime Agent tool-loop path works
for that scope. External safe VM URL success establishes Windows-to-VM service
use, not arbitrary networks, per-Agent administrator readiness, six-device
coverage, tty/tmux recovery or model intelligence. Use real task results and
actual data paths, not internal agent_message, as the product acceptance evidence.

## Operator-approved real model mode

Fixture mode stays the default. To use the approved actual model, the main
coordinator sets `ENVINHANDS_REAL_MODEL=1`,
`ENVINHANDS_REAL_MODELS_CONFIG=<private path to key-free models.json>`, and securely
injects `ENVINHANDS_ACCEPTANCE_API_KEY`. The controller never reads Desktop/api.txt.
It copies the key-free config into each independent agentDir and passes the key
only in that child's environment. It does not load the fixture provider extension
in this mode. Provider=`envinhands-acceptance`, model=`gpt-6.1-terra`.

Verified models.json shape for an OpenAI-compatible `/v1` endpoint:

```json
{
  "providers": {
    "envinhands-acceptance": {
      "baseUrl": "https://OPERATOR_ENDPOINT/v1",
      "api": "openai-completions",
      "apiKey": "ENVINHANDS_ACCEPTANCE_API_KEY",
      "models": [{ "id": "gpt-6.1-terra", "input": ["text"], "contextWindow": 128000, "maxTokens": 4096 }]
    }
  }
}
```

The endpoint/API pairing must come from the operator's actual service contract.
Do not assume every `/v1` URL supports both APIs. `openai-responses` is also a
built-in API if the endpoint actually supports Responses. Source KnownApi values
are `openai-completions`, `openai-responses`, `azure-openai-responses`,
`openai-codex-responses`, `anthropic-messages`, `bedrock-converse-stream`,
`google-generative-ai`, `google-vertex`, `mistral-conversations`, `systemone`.
Custom registered API strings exist, but do not invent a backend handler.

`apiKey` contains the **environment variable name**, not the actual key. There
is no need for an auth.json containing a secret or a shell key lookup command.
The controller does not overwrite a user's actual global config. Cost fields
are intentionally absent: do not label unknown real-model pricing as free just
because a config defaults to zero. Actual token usage/provider output remains in
private session evidence; real monetary cost is operator-approved/not inferred.

Each real client receives one short natural-language task with explicit authorized
tool actions (normally five/six, plus optional read-only VM execution), waits for
actual `agent_end`, and verifies actual tool-result events and final record.
Returned messages/notes are data, never new authority. Real-model mode is an
operator-run acceptance path; this implementation's local passes used the zero-cost
fixture and do not themselves claim an actual paid-model result. No automatic
retry or fallback switches a failed real model to the fixture.
