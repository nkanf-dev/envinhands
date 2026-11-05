# Publish a private control ingress over authorized SSH

`publish <absolute-private-profile.json>` establishes one owned SSH reverse
forward. This connects an already reachable, authorized SSH entry host back to
a local service. It does not create a public listener, install SSH keys, change
sshd/GatewayPorts/firewall settings or make an unreachable entry host reachable.
The main CLI mounts `runRemotePublishCli`; this module never starts on import.

Profile example (references only, no token/private-key contents):

```json
{"host":"trusted-entry.example","user":"agent","hostKeyAlias":"trusted-entry.example","identityFile":"/private/identity-reference","knownHostsFile":"/private/known-hosts","localServicePort":8787,"remotePort":41234}
```

Optional `port` selects the SSH port; `jump` is an existing authorized SSH jump
host. Both TCP ports must be fixed integers1..65535. The local target and remote
bind are always127.0.0.1. No additional keys such as remoteBind or token are
accepted. Use Unix owner0600 for the absolute profile, or a private Windows ACL.
Profile reads are bounded16KiB; do not put credentials in argv or logs.

The implementation reuses strict `buildSshRouteArgv`: BatchMode,
StrictHostKeyChecking, configured host-key alias/identity/known_hosts and no shell.
It adds `-N -v -o ExitOnForwardFailure=yes -R
127.0.0.1:REMOTE:127.0.0.1:LOCAL`. ServerAlive probes detect loss; they do not
replay service requests. SSH stderr is inspected in memory within a64KiB setup
budget and never echoed. Ready requires the exact OpenSSH debug1 remote-forward
success line with matching bind and target ports, not process spawn, elapsed
time or just authentication. An unrecognized/missing confirmation times out as
failure, never guessed success. This implementation targets current OpenSSH
English diagnostics; other log formats fail closed and need actual validation.

Ready JSON has `url`, `remoteHost`, `remotePort`, `encryptedSSH:true` and
`backendVerified:false`. **url is loopback ON THE SSH ENTRY HOST**, not a URL
usable directly on the publishing client or a third member's machine. Remote
forward confirmation means SSH accepted the forward, not that the local HTTP
service exists or authenticated requests work. Server policy must preserve the
requested loopback bind (do not use GatewayPorts yes). Verify actual binding and
perform a real authenticated HTTP request through the chosen full route before
claiming product reachability. Never print the bearer.

Other clients can use their existing strict `access` route to that same entry
host's loopback remotePort; a fixed approved localPort keeps their client URL
stable across manually coordinated reconnects. No automatic reconnection or
request replay occurs. On loss the publication's `finished` rejects. Restart
only the tunnel, query original file/operation state, and do not blindly repeat
uncertain writes. SIGINT/SIGTERM closes and awaits only this owned SSH child;
shutdown does not stop the local service or unrelated SSH processes.

`startRemotePublish(options,{signal?,setupTimeoutMs?,spawn?})` returns
`{remoteHost,remotePort,url,finished,close}` after confirmation. Injected spawn
is for fixtures. Native tests check process/argv/confirmation/close/cancellation,
not actual SSH authentication, host trust, port policy or HTTP connectivity.
The coordinator separately owns real Windows↔VM product-route acceptance.
