# Loopback HTTP access through authorized SSH

`startRemoteAccess` in `src/remote-access.ts` turns an already authorized SSH
route into a private local TCP forward. It uses Node `net` and default `ssh`
from the current process PATH, with no shell or additional dependency.

```ts
import { startRemoteAccess } from "./src/remote-access.ts";
const access = await startRemoteAccess({
  host: approvedSshHost,
  user: approvedSshUser,
  port: 22,
  hostKeyAlias: trustedKnownHostsAlias,
  identityFile: absoluteExistingPrivateKeyReference,
  knownHostsFile: absoluteTrustedKnownHostsReference,
  destinationHost: "127.0.0.1",
  destinationPort: approvedControlHttpPort
});
try {
  // access.url is http://127.0.0.1:<random-port>.
  // Inject the service bearer into the HTTP client, never into SSH argv.
  await useApprovedService(access.url);
} finally {
  await access.close();
}
```

The local listener is always `127.0.0.1`, port0. The returned `url` and `port`
indicate that this local listener is ready, not that SSH authentication or the
remote HTTP service has succeeded. Make an actual authenticated API request to
verify that service path. No blind delay or fake readiness probe is needed.

Each accepted connection creates one owned `ssh -W 127.0.0.1:<destinationPort>`
process. It reuses `buildSshRouteArgv` for host/user/port/credential-path checking,
`BatchMode=yes`, `StrictHostKeyChecking=yes`, fixed trusted HostKeyAlias,
IdentitiesOnly when an identity file is selected, and optional `jump` to an
already configured trusted jump host. `hostKeyAlias` defaults to the supplied
SSH host; supply it explicitly when a stable alias is used across routes.

The bridge removes the route builder's `-n`, because forwarding requires stdin,
and inserts `-W` **before** `-- <ssh-host>`. `-T` remains. It never constructs a
shell command or remote shell payload. Arguments contain only endpoint data and
references to existing local credential files, not private-key contents, bearer
tokens or passwords. SSH diagnostics are drained but not sent to HTTP clients or
logged by the bridge. Connection failure closes that connection; it does not
silently switch routes or replay HTTP requests.

Native stream pipes provide backpressure. The local listener allows half-open
TCP so request EOF can reach SSH stdin while a response is still read. A normal
SSH stdout EOF ends the client response; failed SSH closes the socket. Explicit
`close()` stops the listener, destroys only owned sockets, terminates only owned
SSH children, and awaits server/child closure. It is idempotent. It is not a
remote command cancellation or shutdown of the remote HTTP service.

## Platform and authority

The same code supports Node-compatible Windows/Linux/macOS runtimes with an
existing OpenSSH executable and credentials. No actual IP, user, key path or
jump host is embedded. It does not install keys, modify sudoers/sshd/firewalls,
create a NAT tunnel backend or guarantee arbitrary Internet reachability.
Both sides still need the already configured authorized route to the common
entry host. A loopback listener avoids public binding but is not an isolation
boundary against other processes running as the same local user.

The SSH destination is restricted to that host's `127.0.0.1` and the configured
port. The service must be bound/configured appropriately. Per-client admin
readiness remains separate from working SSH forwarding; ordinary authorized
SSH login can forward HTTP even if `sudo -n` is unavailable. Use strict trusted
host keys; do not set accept-new/disable checks for convenience.

Opening/closing this bridge creates local resources. The caller should include
its actual endpoint/owned-process lifecycle in the existing signed attribution
boundary. This API does not invent an Agent signature or log secrets on behalf
of an arbitrary caller.

## Tests and evidence

`<absolute-bun> test test/remote-access.test.ts` uses a real local HTTP service,
random TCP ports and real stdio child processes as an injectable SSH stand-in.
It verifies actual payload transfer, shared strict argv including `-J`, correct
`-W` position/no `-n`, closed-port behavior and closing active owned children.
No real SSH private key or remote VM is needed for these fixtures. A prepared
Node24 can also run `node --experimental-transform-types --test test/remote-access.test.ts`. Plain strip-only mode rejects the reused route module's TypeScript parameter property; no source rewrite is needed.

The injection is test-only; production default is the real `ssh` binary.
Fixture transfer proves bridge mechanics, not OpenSSH authentication, a real Mac,
Windows-to-VM route or arbitrary network traversal. The main coordinator performs
the real VM check using the approved existing SSH identity and service.

## CLI profile

`envinhands access /absolute/path/to/ssh-profile.json` uses the same RemoteAccessOptions JSON, emits the local loopback URL, stays running, and closes owned resources on SIGINT/SIGTERM. Set other clients' ENVINHANDS_URL to that URL and inject the control token separately. The JSON contains endpoint and existing credential-path references, not bearer/private-key contents. A working backend must be confirmed by an actual API request. This provides the same entry on Windows, Linux and macOS rather than per-machine scripts.

For geographically separated members, the configured SSH host or jump must really be reachable from each site; the feature does not create an Internet path by itself. Use an existing approved jump/VPN or an independently configured encrypted relay/API ingress. Do not open the experiment's default wildcard ports as a shortcut.

Main coordinator's actual Windows→DebianVM test returnedHTTP200 and observed live Agents using this product API, then closed the owned bridge. This confirms the authorized current route works; actual remote-site network acceptance remains separate.
