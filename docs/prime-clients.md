# Independent Prime ExtensionRunner clients (no model)

These explicit fixtures run EnvInHands business adapters in **separate OS
processes** using the actual Prime `DefaultResourceLoader`, `ExtensionRunner`,
`SessionManager`, schema validator and tool wrapper. They do not create full
Prime daemon/TUI/model Agents. They do not establish Windows-to-VM, SSH/admin,
relay/tmux or six-device acceptance by themselves.

## Prepared prerequisites and execution

- Fixed Bun runtime (tested with 1.4.4); use its absolute path, no global install.
- A real, prepared Prime checkout with the source-loader fix and its locked
  dependencies. `PRIME_AGENT_CHECKOUT` selects it; no Windows path is embedded
  in either script. File imports use platform file URLs.
- EnvInHands source with its existing locked dependencies and the provenance
  adapter/client/server. No new manifest/lock dependency is added by these files.

From the EnvInHands root, set `PRIME_AGENT_CHECKOUT` to the approved local Prime
root and optionally `PRIME_CLIENT_REPORT` to a private output JSON path, then run:

```text
<absolute-bun> run scripts/verify-prime-clients.mts
```

The controller starts the real service at `127.0.0.1` on port 0 with a temporary
SQLite DB and random token. It starts A and B with separate allowlisted process
environments, data directories and sessions. No real provider key is forwarded.
Only the configured service origin is allowed by the client fetch guard; the
fixture does not configure or call any model provider. `--offline` alone is not
used as proof that provider requests cannot happen.

The controller checks:

- Actual PIDs, distinct session IDs, actual loader/tool registration and real
  schema validation, not a constructed extension API.
- A/B send in both directions; observed 201/200/409, repeat pull, explicit repeat
  ack and absence after ack.
- Each heartbeat lifecycle event through the real runner, with actual transport
  completion followed by service observation. No readiness sleep or polling loop.
- Register with each actual session ID, append/read explicit change records,
  resource notes and ready-only empty catalog semantics.
- Stop/restart A with a new process/session; both queues survive and B remains
  usable. The restarted process cannot reuse A's cached registration authority.
- Wrong bearer gets 401; absent configuration loads no tools; invalid tool schema
  input fails before transport.
- Orderly stop of owned processes/API and removal of only owned temporary files.

A deliberate negative control is part of this fixture, not an implementation
fallback or retry:

```text
<absolute-bun> run scripts/verify-prime-clients.mts --fault=ack-unavailable
```

This routes B's ack requests to an explicit fixture 503. The actual queued message
must remain; the controller's post-ack empty-queue assertion must fail with exit
1. The default run has no fault. A negative-control failure is recorded separately,
never called a passed acceptance run or retried until green.

## Standalone client JSONL protocol

`<absolute-bun> run --tsconfig-override <Prime-root>/tsconfig.json scripts/prime-client.mts`
starts the process. Required local variables: `PRIME_AGENT_CHECKOUT`,
`PRIME_CLIENT_DATA_DIR`. Adapter variables are the existing `ENVINHANDS_URL`,
`ENVINHANDS_TOKEN`, `ENVINHANDS_AGENT_ID`, `ENVINHANDS_MACHINE_ID` and
`ENVINHANDS_AUDIT_SIGNATURE`. Securely inject tokens into environment; never put
them in command arguments, chat, reports or shell history.

The first stdout record is `{type:"ready", pid, sessionId, tools, ...}`. Each
stdin line is one object with a unique string `id` and one command:

```json
{"id":"s1","type":"status"}
{"id":"c1","type":"call","name":"envinhands_pull","args":{}}
{"id":"e1","type":"lifecycle","event":"session_start"}
{"id":"e2","type":"lifecycle","event":"session_shutdown"}
{"id":"x1","type":"close"}
```

Replies have the same `id`, `ok` and optional `result`. Tool arguments are passed
to the shared actual Prime validator and existing tool implementation. This
local fixture protocol is not a new public EnvInHands or Prime daemon protocol.
Lifecycle names are the four existing hooks; the host waits for the actual
tracked fetch completions before acknowledging. Service failures remain visible
in status wire metadata; HTTP acceptance does not prove recipient processing.

`PRIME_CLIENT_FIXTURE_FAULT=ack-unavailable` is for the negative controller only.
Do not enable it for a real remote client. The client does not claim mid-flight
caller cancellation or rollback of an already dispatched mutation.

## Attribution and cleanup

Each process writes a local declared registration and `fixture-changes.jsonl`
inside its own data directory. The controller collects these, its own declaration
and ledger into the optional report **before** deleting the temporary directory,
and records actual cleanup completion afterward. These records cover the known
fixture setup, explicit HTTP mutation response and cleanup paths. They do not
prove automatic capture of arbitrary Python/shell/external/remote writes or
cryptographic identity. The test also verifies explicit server registrations and
change records through the loaded tools. Shared bearer labels are not strong
identity or authorization grants.

## Minimal VM export, not a whole repository deployment

A measured esbuild source graph for the seven real runtime entrypoints contains
798 local files, approximately 7.5 MB of source. Its raw package-external bundle
was about 5.8 MB / 55 files, but it is **not an accepted portable artifact**:
bundling changes `import.meta`-relative package, theme, index-alias and resource
paths. A successful bundle command is not successful runtime acceptance.

The safe next export should preserve the relevant `packages/*/src` layout and
loader aliases, required package manifests/theme JSON assets, the three existing
adapter sources, and the root path configuration. Exclude `.git`, unrelated
docs/tests/history, actual settings, keys, `.env`, business DBs and build outputs.
A separate dependency closure manifest must retain the existing lock's exact
versions/integrities. Initial graph externals include jiti, TypeBox,
chalk/marked/cli-highlight, ignore/glob/minimatch/yaml, proper-lockfile/uuid,
model/MCP and transitively imported packages. Do not guess that jiti+TypeBox alone
is sufficient. Do not copy Windows native modules to Linux or fetch new versions
outside the lock/cooldown rules.

The graph/hash manifest and measured failed-bundle limitations are attached to
the implementation report. The current controller verifies a source checkout;
no thin packaged/Linux loader is claimed ready yet. A Linux runtime closure must
be exported, hash checked and run as a separate gate before the coordinator uses
it on the control VM. VM-side Bun availability alone does not satisfy Prime
runtime dependencies. This is a bounded source/dependency fixture, not making the
whole Prime repository an EnvInHands business dependency.

For TypeScript validation, the current Env tsconfig does not include `.mts`
scripts. The implementing report therefore records an explicit native `tsc`
command for these two scripts in addition to regular `bun run typecheck`.
