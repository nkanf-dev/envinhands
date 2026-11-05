# Lightweight host onboarding: Linux, macOS and Windows

`src/device-registration.ts` provides the same collector/client path for supported
hosts without changing machine API/storage or installing SSH keys, sudoers,
OpenSSH or network routes. It is an inventory registration helper, not a complete
administrator provisioning workflow.

## Caller API

- `collectLocalDevice()` obtains local hostname, runtime platform/architecture,
  current username as the SSH-user candidate, and default SSH port22.
- `collectDeviceRegistration({id, host, name?, sshUser?, sshPort?, relayNodeId?}, collector?)`
  combines an explicitly chosen stable ID and reachable address with collected
  metadata. The collector is injectable for embedding/testing.
- `DeviceRegistrationClient` extends existing `PrimeBridge` and reuses its
  authenticated bounded transport. Construct with `{baseUrl,token,fetch,timeoutMs?}`.
- `await client.registerDevice(options, {verify?:boolean}, collector?)` creates
  the machine through the existing POST `/v1/machines`. Default: register only,
  return actual pending record, `verificationRequested:false`, scope null.
- Only explicit `{verify:true}` performs bodyless POST
  `/v1/machines/<encoded-id>/verify`. The returned `ready` or `not-ready` state
  and service-provided verification scope are preserved. HTTP200 alone is not
  interpreted as ready. Verification error does not delete a created record.

Example in a prepared, authorized caller:

```ts
import { DeviceRegistrationClient } from "./src/device-registration.ts";
const client = new DeviceRegistrationClient({ baseUrl: serviceOrigin, token: securelyInjectedToken, fetch });
const receipt = await client.registerDevice({ id: "team-device-a", host: explicitlyReachableHost, sshUser: approvedSshUser });
// Inspect receipt.machine.status. Default is pending, not administrator-ready.
```

`id` and `host` have no hostname-derived fallback. Detected hostname is a display
name only; a local hostname does not prove DNS/routing from the control host.
The user supplies a real reachable address or an already configured relay route.
No connection probe, DNS discovery or automatic public exposure occurs here.
The current OS username may not be the intended authorized SSH login; provide
`sshUser` explicitly in that case. Domain-qualified Windows usernames outside
the existing API grammar are not silently rewritten into another identity.

Native platform mapping is `linux -> linux`, `darwin -> macos`,
`win32 -> windows`. Unsupported platform reports an error rather than claiming
compatibility. Architecture remains in the returned local observation. It is
not sent as a new field: the current machine API does not accept/store arch.
A future catalog architecture change must be agreed separately, not overloaded
into notes or OS strings.

## Transport, duplicate calls and actual access

Use a correctly secured HTTPS endpoint for remote traffic, or an approved strict
SSH-encrypted forward to a loopback service. `PrimeBridge` supplies bearer auth,
request timeout, redirect rejection and a 256KiB client response limit here.
Do not put token values in commands, scripts, notes or output. Shared bearer
labels are not per-Agent strong identity.

Registration POST has no requestId/idempotent-upsert contract. Existing ID returns
409 and is not silently verified/replaced. A timeout can leave a pending record;
inspect inventory instead of automatically replaying or changing the stable ID.
An explicit verification still checks **the server's SSH identity**, not every
Agent identity. Current ready TTL and strict-host-key/admin checks remain the
service's responsibility. Each actual client must separately verify its approved
identity/path and noninteractive administrator capability before claiming access.
This helper does not configure keys, privileges or a locked resource reservation.

Registration/verification modify catalog state. The embedding CLI or Agent must
associate those calls with its signed resource-change boundary/records; this
helper does not fabricate an Agent session or automatic attribution from the
OS username. Existing automatic tool observation covers a tool event, not all
external calls to this API helper.

## Native evidence and platform limits

`<absolute-bun> test test/device-registration.test.ts` checks the three injected
platforms and actual native local collection, then real loopback HTTP/SQLite
pending registration, explicit ready/not-ready scope, exact allowed request
fields/bodyless verify and401/409. The verifier is a fixture; no SSH/admin
provisioning occurs. `<absolute-bun> run typecheck` validates the native project.

Tests run on the current Windows host. Injected `darwin` mapping and shared
portable code are **not real Mac runtime/SSH/admin acceptance**. Each Mac, Linux
host and deployment still needs its own authorized address, identity and runtime
checks. No claim of six-device completion is made by this module.

## Unified CLI

Run the same `envinhands device register` on Windows/Linux/macOS, passing JSON on stdin with explicit stable `id` and reachable `host`. Optional `name`, `sshUser`, `sshPort`, `relayNodeId` override observed defaults. The command collects local OS/hostname/user/architecture, sends only supported catalog fields and returns actual pending data. `verify:true` requests the service's SSH check explicitly; default registration never claims SSH/admin setup.

`envinhands device inventory` asks the control host for ready, pending and not-ready records. This uses additive `includeNotReady=true` support; old servers reject that new query rather than silently hiding failures. Default resource discovery stays ready-only. Upgrade the control host before using this inventory switch. A failed or expired record remains registered; it is not equivalent to a usable resource for every Agent.
