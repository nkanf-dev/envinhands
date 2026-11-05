# Verified SSH routes and audited remote execution

`src/transports/ssh-routes.ts` performs real strict SSH authentication probes before selecting a route. It reuses `transports/policy.ts` rather than introducing a second ranking policy. Routes are explicit host/port candidates or a preconfigured jump host, not promises that UU/rathole/Internet paths are configured.

- Every candidate uses the same trusted `hostKeyAlias`, `BatchMode=yes` and `StrictHostKeyChecking=yes`.
- Optional identity/known_hosts paths are local references only. No private key or password is uploaded.
- Preference ordering and a total probe budget bound attempts. Each candidate is tried at most once in a selection.
- A successful `true` proves this SSH identity/path at that time, **not administrator readiness**, continued availability or every Agent's access.
- Existing SSH streams never migrate between routes. New commands are not retried after they start.

## Portable audited `exec`

`bun src/cli.ts exec` or compiled `envinhands exec` reads one JSON object from stdin (16KiB total). `ENVINHANDS_CHANGE_SPOOL` must point to an absolute caller-owned directory. No server connection is needed to preserve local evidence.

```json
{
  "registration": {"registrationId":"reg-a","agentId":"agent-a","sessionId":"session-a","machineId":"client-a","signature":"Agent A"},
  "change": {
    "operationId":"operation-a","registrationId":"reg-a","targetMachineId":"control-vm",
    "resourceId":"workspace:example","action":"remote-command","summary":"Run the approved task",
    "reason":"User task","authority":"Current request reference","beforeSha256":null,"afterSha256":null,"evidenceRef":null
  },
  "routes":[{"id":"direct","host":"control.example","port":22}],
  "access":{"user":"agent","hostKeyAlias":"control.example"},
  "priority":["direct"],"probeBudgetMs":15000,"command":"id -u","timeoutMs":10000
}
```

The example is read-only. Do not run a modifying command without user authorization for its target and effects. Command text is intentionally a remote-shell command; it is never interpreted by a local shell. Do not put credentials in it. Remote stdout/stderr stream to local stderr as untrusted data; stdout contains a JSON operation receipt.

The reusable `runAuditedOperation` boundary writes and fsyncs a signed unknown/intent event before work. It calls the mutation exactly once and appends a separate outcome event. If intent cannot persist, work does not start. If completion cannot persist, the return value explicitly says `locallyRecorded:false` and outcome unknown; it does not manufacture a receipt. Local queue does not mean server synchronization. `change flush` explicitly synchronizes.

`exec` first probes the route, then starts one SSH command. A command return code0 gives success; a nonzero remote command gives failed; SSH255, signal, timeout or ambiguous error gives unknown. A remote command may have changed resources even when exit is nonzero. Timeout terminates only the owned local SSH child, not a proven remote task cancellation. No automatic replay, rollback or job-result protocol is implied. `started` records whether the command's SSH child actually spawned.

## Real evidence and limits

On the current Windows client, an unavailable loopback candidate failed then the control VM candidate succeeded with existing strict trusted host key and approved identity. Actual read-only execution printed UID1000/Linux and left two durable local records. Separately compiled ProxyCommand traversed Windows -> encrypted control SSH forward -> VM relay -> vm-self node -> real sshd, rejected a wrong relay secret and wrong host key, and preserved actual sudo-n failure/not-ready.

These do not prove separate Agent administrator identities, public NAT traversal, all six devices, arbitrary backends, or tmux recovery. Authentication probing and once-only execution are current implementation slices, not the complete future multi-backend controller. Direct/jump/forwarded-endpoint routes must already exist; this module does not install tunnel software or open ports.

Every resource mutation must use a traceable boundary or explicit change record. This API/CLI cannot detect external programs or an Agent that bypasses the integration. No automatic global filesystem interception, strong signature or tamper protection is claimed.

## Local resource execution

`envinhands exec --local` accepts the same `registration` and `change` metadata plus `executable`, `args`, `cwd`, and `timeoutMs` instead of remote routes/access/command. `targetMachineId` must equal the registration's local `machineId`. `cwd` is absolute; process launch uses argv with `shell:false`. The same signed durable intent/outcome records are written. This is a portable mutation gateway, not an OS sandbox; commands can start descendants, and terminating the owned child does not prove all descendants or effects stopped. Use only authorized commands and no credentials in arguments.

The `runLocalExecution` and `runRemoteExecution` APIs share their process lifecycle and provenance boundary. A caller may pass a before/after hash if actually observed; the wrapper does not invent hashes for arbitrary shell commands. For each operation, use a precise resource reference and evidence reference. Explicit local queue flush publishes registration and each event to the control service, preserving request IDs across uncertain responses.
