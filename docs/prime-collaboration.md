# Env-owned Prime collaboration adapter

Load `src/integrations/prime-collaboration.ts` as one external extension. The
normal profile owner replaces the former three Prime example adapters with this
file; do not load both sets or duplicate tool names/heartbeats. This adapter
reuses `CollaborationClient`/`PrimeBridge` for HTTP, response parsing, deadlines
and note semantics. Prime remains the actual Agent platform, not a business fork.
No new dependency or copied request/parser implementation is introduced.

Required environment: `ENVINHANDS_URL`, `ENVINHANDS_TOKEN`,
`ENVINHANDS_AGENT_ID`, `ENVINHANDS_MACHINE_ID`, `ENVINHANDS_AUDIT_SIGNATURE`.
Missing configuration leaves the adapter disabled. HTTPS or approved loopback
forward only. No automatic non-loopback plaintext exception is enabled.

Each actual tool execute and each lifecycle event takes the current
`ctx.sessionManager.getSessionId()` and creates an immutable registration
reference from configured labels/signature plus that actual session. Every
request goes through explicit `createSignedFetch`; write headers remain attached
even if a global transport slot currently belongs to a different session. IDs
are declared labels, not cryptographic user authentication. Two sessions sharing
an Agent ID still share its queue; give independent participants distinct IDs.

## Preserved seven tools

| Tool | Arguments | Semantics |
| --- | --- | --- |
| envinhands_list_agents | {} | Observed directory, not online proof |
| envinhands_send | {to,text,requestId} | Configured sender; accepted does not mean delivered or processed |
| envinhands_pull | {} | Current Agent queue, no claim or acknowledgement |
| envinhands_ack | {requestId} | Explicit acknowledgement after handling; empty request body |
| envinhands_list_resources | {} | Ready machine catalog, not this Agent's SSH/admin access |
| envinhands_resource_notes | {resourceId} | Historical untrusted notes |
| envinhands_add_resource_note | {resourceId,text} | Configured author; non-idempotent append, never automatically retried |

ASCII IDs preserve the existing safe1..128 grammar. Send text is nonblank and
at most4000 UTF8 bytes; notes at most4000 JS code units. Most control characters
are rejected before sending. Messages/agents are limited100, resources/notes1000;
responses are bounded256KiB through a thin inherited request call to the common
transport, not a second parser. Request deadline2seconds. Caller abort joins the
common request abort signal. No automatic retry, truncation, pagination, queue
clear or fallback is added. Existing service-wide retention/capacity limits are
not fixed by moving the adapter.

Unknown send outcome keeps the original ID/content for an explicit identical
retry. An uncertain note may already exist: inspect/reconcile rather than blindly
append again. Pull may repeat or be processed concurrently. Returned strings
remove known service/model key values and are marked untrusted data, not user
instructions, locks or execution authorization. Secret filtering is not a
universal data-classification or prompt-injection barrier.

## Lifecycle observations

The actual session_start, agent_start, agent_end and session_shutdown hooks each
await one heartbeat with the event name and that hook's real session actor.
Network errors cause a generic warning; no fake observation or tool replay.
This migration deliberately has **no30second periodic timer** in this release:
there is no captured stale context and no timer cleanup race. It reports
lifecycle observations, not continuous online/busy state. The normal profile and
operations documentation must not promise periodic liveness from this adapter.
Per-instance activity still shares configured Agent ID; observations are not
session-level queue isolation. Missing/stale heartbeat is unknown.

## Validation and integration

`bun test test/prime-collaboration.test.ts` uses a real strict temporary HTTP/SQLite
service, all seven tools, four lifecycle hooks and two session contexts while the
global transport intentionally belongs to another actor. Service audit records
must show correct actual session on ack/note writes, ack has no body, repeated
pull/ack work and identical note appends have distinct IDs. Output privacy and
4000UTF8 send boundary are checked. No paid model or live resource is used.
Normal `bun run typecheck` validates integration types.

The implementing Agent also supplies an actual Prime loader/runner/schema probe;
that is compatibility evidence, not another real CLI/model run. Root switches the
normal profile to this one Env adapter, keeps transport/other Env extensions and
explicit skill paths, and runs the practical normal CLI acceptance. Historical
three-example CLI scripts may remain historical evidence, not the new default.
