# Normal opt-in Prime profile

`prime-profile` emits a small `settings.json` fragment. It does not write settings,
start a model, create an Agent registration, install dependencies or grant access.

```text
<absolute-bun> src/cli.ts prime-profile <absolute-EnvInHands-root> [absolute-prepared-Prime-root]
```

Merge the resulting `extensions` and `skills` lists into a **private per-client**
Prime `settings.json`, preserving other approved configuration. Do not blindly
replace existing settings. The profile includes the session-bound signed HTTP transport first, the Env-owned
prime-collaboration extension (heartbeat/messages/resources), Env explicit records, execution,
local read-only files, shared-host read/compare-write files and automatic tool-event observation, plus explicit absolute
paths to the two Env project skills. Thus a client can work in its own unrelated
workdir without losing the project skills or relying on CTF-only setup.

Use a prepared Prime 0.9.8 runtime with its locked Node dependencies and the
source-loader fix. All business extension paths now point into EnvInHands; the
optional second root argument is accepted for earlier command compatibility but
no longer locates Prime example extensions. There is no new Env package dependency. Start Prime via
its normal installed/source CLI; do not pass `--no-skills` or `--no-extensions`
if those configured resources are required.

Securely inject per-client values before startup:

- `ENVINHANDS_AGENT_ID`, `ENVINHANDS_MACHINE_ID`, `ENVINHANDS_AUDIT_SIGNATURE`.
- A distinct absolute `ENVINHANDS_CHANGE_SPOOL` for that client.
- `ENVINHANDS_URL` and `ENVINHANDS_TOKEN` via protected configuration/environment,
  not settings output or command arguments. Use HTTPS or approved loopback SSH
  access. Different clients must not inherit another client's Agent identity.
- Optional `ENVINHANDS_EXECUTION_PROFILES` for approved SSH tasks and
  `ENVINHANDS_RESOURCE_ROOTS` JSON for local read-only files. These adapters are
  inactive when their required configuration is missing; inspect actual loaded
  resources rather than assuming every generated path enables a tool.

The observation adapter records known tool invocations/results, not every file
mutation. An `edit` relative path uses actual `ctx.cwd` to identify the absolute
resource; shell/Python/custom calls remain hashed tool references without guessed
remote effects. Direct CLI/API writes and background/system operations still need
their own registered signed records. A profile is not a global audit monitor.

## Actual verification and boundaries

A fresh empty agentDir with this emitted profile and an unrelated workdir was
loaded by real Prime `SettingsManager.create` / `DefaultResourceLoader.reload`.
The final seven-extension Env-owned profile loaded without errors; tool_call/tool_result/agent_end and
session_shutdown observation handlers were present; collaboration, audit,
execution, local read-only and shared-host read/write tools registered. Both original skill bodies were
readable from their explicit Env paths. Network requests and model calls were
zero; only owned fixture settings/files were created and cleaned up.

The retained entry is `verify-normal-prime-profile.mts` in the main controller's
handoff evidence, with `normal-prime-profile-native-first.raw.log` / `.result.json`
(exit 0). This is actual normal settings loading, not a new paid model run. The
prior real-model ring/CTF used restricted validation configuration with
`--no-skills`; their success does not prove models used these skills. The CLI
acceptance recipe now also loads observation outside CTF; prior E1 relied on
explicit records and must not be rewritten as historical automatic coverage.

## Shared work on another host

A host service can expose explicit `sharedRoots`, never an entire home by default.
Normal tools `envinhands_read_shared_file` and `envinhands_write_shared_file` use
that configured service's resource ID and relative file path. Read returns text
and SHA256. Write requires that expected SHA256; null only creates a missing
file. A stale hash yields a conflict, not an overwrite. See [shared-files.md](shared-files.md)
and [api-mutation-attribution.md](api-mutation-attribution.md).

A client needs a real encrypted route to that host service. Existing strict SSH
local/reverse forwarding can supply loopback URLs; it does not make an unreachable
site appear automatically. Each write uses the executing actual Prime session's
explicit identity even if another session reloaded a process-level transport.
Known local edit observations now also carry readable before/after file hashes;
unknown tools do not pretend to identify all side effects.

The Env-owned collaboration adapter uses actual lifecycle context for each heartbeat and tool. It does not currently start a 30-second timer; lifecycle observations are not continuous liveness. Previous seven/nine-path profile reports remain historical snapshots, not the final configuration.
