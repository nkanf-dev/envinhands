# Registered API mutations and direct CLI identity

The formal `service CONFIG_JSON` entry requires declared Agent registration for
non-audit API writes. `x-envinhands-registration` carries base64url JSON of the
existing five-field immutable registration; `x-envinhands-operation-id` identifies
this dispatch. Shared bearer authentication still applies. These headers declare
an actor, not a cryptographic login or additional authorization.

The service persists unknown intent before dispatch. It appends success/failed/
unknown with HTTP status afterward. If intent cannot persist, dispatch is blocked;
if completion cannot persist, the response says effects may exist. Message/note
bodies and credentials are not copied into audit records. Resource IDs identify
known machine/message/Agent/shared-file targets, and shared-file write receipts
supply before/after SHA256. Access evidence must match its request registration.

Ordinary mutating commands (`device register`, `collaborate heartbeat/send/ack/
add-note`, `files write`, legacy `register`) now require securely supplied:

- ENVINHANDS_AGENT_ID
- ENVINHANDS_MACHINE_ID
- ENVINHANDS_SESSION_ID
- ENVINHANDS_AUDIT_SIGNATURE

CLI registration IDs are derived from this identity. Do not reuse another Agent's
session. GET/read-only commands do not require a mutation identity. `verify-access`
uses its explicit registration on stdin and persists observations if service URL/
token are configured. `provision` additionally needs an absolute durable change
spool and existing owner-confirmed local administrator context; installation does
not imply readiness.

The normal Prime profile loads session-bound signed transport **first**, then
the Env-owned collaboration adapter and the other adapters. Current real ctx.session ID
is bound before lifecycle writes. It only affects service-origin POSTs, rejects
redirects for those writes and does not alter model/provider requests. Normal
same-process reload rebinds one owned wrapper; explicit request identity survives
other wrappers. The default process-global transport lives until process exit so
late shutdown heartbeat hooks remain attributed; embedded hosts can dispose only
after all session shutdown work. Concurrent request-context routing still needs
explicit per-request identity; don't assume one global session describes all
simultaneous Agents.

Legacy `startAgentBusServer` calls can opt out of strict mode to preserve older
clients, but unsigned writes are recorded as service observations with original
actor unknown, not attributed to a fabricated Agent. New formal deployments must
use strict mode. Neither this HTTP boundary nor tool observation is an OS-wide
watcher; external processes, dependency installation and operator deployment work
still need their own registered records.
