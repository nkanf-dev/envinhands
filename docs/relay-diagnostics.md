# Relay session diagnostics

This is opt-in metadata for the existing relay v2 protocol. It does not change
its frames, authentication, readiness deadline, buffering, or close rules. Set
`ENVINHANDS_RELAY_DIAGNOSTICS=1` in the relay, node, and SSH ProxyCommand process
environments to capture all three legs. Roll out only with the operator's
approval; this change does not restart a running service or upgrade any peer.
Without the setting the added periodic relay/node events and proxy logger are
disabled. Existing relay/node debug logging remains unchanged.

Each enabled Unix process writes a private `events.jsonl` under the existing
`ENVINHANDS_LOG_DIR` (or the default `~/.local/state/envinhands`), in its own
`relay-*`, `node-*`, or `proxy-*` directory. Windows logging remains disabled
because this logger does not promise Windows ACL safety. The SSH ProxyCommand
must inherit the setting, relay URL and secret; the readiness runner's ignored
stderr does not suppress the private logger. File logging can fail; check the
logger fault message on stderr when available and do not infer successful
logging merely from the env setting. Avoid slow filesystems: the existing
logger writes synchronously. Enable briefly and use bounded retention. Each
active relay/node session emits a progress snapshot every five seconds. The
proxy emits snapshots every five seconds only after it receives the ready marker.

`ssh_session_open`, `ssh_channel_attached`, `ssh_tcp_connected` (node), and
`ssh_channel_ready` mark setup. `ssh_first_in`, `ssh_first_out`, and
`ssh_tcp_first_write` mark first bytes observed. Each progress/end event has
cumulative `bytesIn`, `bytesOut`, and on node `bytesWritten`, plus
`lastInMs`, `lastOutMs`, `lastWriteMs` when that direction has progressed.
These times are monotonic milliseconds since that process started this
session; `durationMs` is the same clock. The log timestamp is wall clock.
`bytesIn` is client-to-node, `bytesOut` node-to-client; node `bytesWritten`
is the number accepted by the TCP write call. Counts at different points can
legitimately differ in flight; none prove remote application processing.
Relay and node share `sessionId`; `proxy_*` records use a separate local
`connectionId` and `machineId` and must be correlated by node and time, not
assumed to identify the same connection under concurrency. Proxy `bytesIn`
counts bytes submitted to WebSocket, `bytesOut` counts bytes received from it.

The relay reports its generated `closeCode` and, where received, `peerCode`;
node/proxy log available WebSocket close codes and coarse fixed error
categories. On abrupt local termination, no final record or code is guaranteed.
A progress snapshot with unchanged counters is not alone proof of failure: the
SSH application may be idle. No credentials, HTTP headers, SSH plaintext, raw
payloads, or WebSocket close-reason text are deliberately recorded. The metadata
still reveals device IDs, timing and traffic volume; restrict access and retain
only as needed.

At the same time, use an explicitly authorized, independently timed `ssh -vvv`
probe with the same strict host key and identity and compare with target sshd
logs. Existing readiness kills the SSH process after 15 seconds and ignores
stderr; these diagnostics do not change that behavior. Registration or an
accepted public key does not prove a later SSH session channel opened. Small
packet stalls remain unproven until localized; existing 4 MiB fail-fast buffer
limits are a separate large/slow-traffic concern.
