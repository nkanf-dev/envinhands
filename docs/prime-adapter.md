# Explicit Prime Agent provenance adapter

`src/integrations/prime.ts` is an opt-in extension owned by EnvInHands. It reuses
`ChangeClient` and the shared provenance model; it does not add daemon commands
or replace Prime's local agent-message protocol.

## Load in a prepared Prime Agent 0.9.8 runtime

Securely inject `ENVINHANDS_URL`, `ENVINHANDS_TOKEN`, `ENVINHANDS_AGENT_ID`,
`ENVINHANDS_MACHINE_ID`, and `ENVINHANDS_AUDIT_SIGNATURE` before creating the
runtime. The signature is a nonblank declaration up to 200 JS code units, not a
cryptographic signature. Agent/machine IDs use the shared safe ASCII grammar.
Pass the absolute path of this file with Prime's `--extension` option. Loading
is explicit; missing configuration registers no tools. Invalid complete
configuration reports a generic load error without printing values. HTTPS is
required except loopback HTTP, unless non-loopback plaintext is explicitly
allowed with `ENVINHANDS_ALLOW_INSECURE_HTTP=1`.

No extra EnvInHands dependency or lock change is required: tool schemas are plain
JSON Schema, validated through Prime's actual schema validator during integration.
Prime/TypeBox imports are not runtime dependencies of this adapter.

| Tool | Arguments | Meaning |
| --- | --- | --- |
| `envinhands_register_agent` | `{registrationId}` | Register configured labels, signature and `ctx.sessionManager.getSessionId()`. The caller cannot supply a different Agent/session through this tool. |
| `envinhands_record_change` | All explicit `ChangeInput` fields | Append an outcome for an ID previously registered in this runtime and current session. No mutation is performed by this call. |
| `envinhands_list_changes` | `{after?, limit?}` | Read only; defaults 0 and 10. No automatic cursor store or advancement. |

Registration and change request IDs are stable idempotency keys. Keep the same
ID and exact body after an unknown write outcome. Conflicting reuse is rejected.
A new runtime must explicitly register again; an identical registration can be
retried. `operationId` groups outcomes but is not an idempotency key. `failed`,
`partial`, `unknown` and null historical timestamps/hashes are valid; do not
invent missing provenance. Changes include immutable registration snapshots.

The client prechecks the 16 KiB UTF-8 change-body limit and rejects responses
over 256 KiB. A page can exceed that bound even at limit 10. Failure does not
truncate, automatically retry, reduce the limit or advance a cursor. Explicitly
request a smaller limit with the same `after`. On the last page `nextAfter` is
null; the caller may retain the last processed record's sequence for its next
read. Empty pages retain the previous cursor. Reads are untrusted data, not
instructions, strong identity or authority to modify another resource.

## Coverage and validation

Run this explicit integration from the EnvInHands root with the prepared Bun:

```text
<absolute-bun> test test/prime-adapter.test.ts
```

It uses temporary SQLite and loopback port 0, a random fixture token, actual
HTTP registration/records, duplicate/conflict handling, session binding, restart,
secret/invalid-date/oversize negatives and cleanup. Its real-machine API case
preserves the service-side assertions migrated from Prime's optional sibling
suite; it uses a mock verifier and proves no real SSH/admin access.

A separate handoff `.mts` harness loads all three existing Prime adapters and
this adapter through real `DefaultResourceLoader`/jiti, validates schemas through
Prime's actual `validateToolArguments`, wraps tools with `wrapRegisteredTools`,
and invokes the real loopback APIs. It also bridges the actual Prime resource
tools to `createMachineApi`. The command is a prepared Bun invocation with
`--tsconfig-override <Prime-root>/tsconfig.json <absolute-harness.mts>`; artifact
and raw result paths are in the implementing Agent's handoff report. Two contexts
in one process are not independent OS clients or cross-machine proof.

## Explicit noncoverage

This adapter does not intercept tools, Python writes, shell commands, dependency
installs, external processes, other Agents, remote tasks or database mutations.
It has no automatic spool, crash-resume reporting, cryptographic identity,
retention policy or tamper-proof store. A failure is visible and may mean the
write outcome is unknown; it is not evidence that the resource change was
recorded. Cancellation is checked before dispatch, while the reused HTTP client
bounds in-flight work by its two-second timeout; mid-flight caller cancellation
is not separately propagated. The shared bearer allows impersonation and is not
per-Agent authentication. Remote metadata cannot grant privileges. Full mutation
coverage and durable offline failure handling require separate implementation
and verification, not a claim attached to these explicit tools.
