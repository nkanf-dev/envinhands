# 2026-11-05: portable provenance and verified execution milestone

This is an experimental milestone, not full six-device/public-network delivery.

## Delivered

- Shared HTTP boundary reused by bus, catalog and provenance APIs, without changing existing message/heartbeat/catalog wires.
- Immutable declared Agent registration, append-only change records, idempotent retries, bounded pages and honest failure/partial/unknown outcomes.
- Portable CLI and client, fsynced offline queue with atomic no-overwrite publication and case-sensitive ID preservation on Windows.
- Reusable pre-effect audit boundary and once-only local/remote execution. Real SSH route probes, strict host trust, finite selection budget, no task replay after start.
- Identity/session/route-specific actual-client administrator observation with TTL, separate from server readiness.
- External Prime audit adapter and real-loader independent OS-process test hosts owned by this repository. Prime is not a required runtime for the core CLI/server.

## Native checks and real evidence

- Windows Bun1.4.4: stage full suite169 pass/0 fail/0 skip when prepared sibling Prime source is available. Without it, the optional direct-import heartbeat case is explicitly skipped. It is not a real-loader test.
- Normal TypeScript gate includes src/test and portable `.mts` scripts. Frozen dependency installation did not change package.json/bun.lock and ran no dependency lifecycle scripts.
- Real DefaultResourceLoader/jiti/schema/wrapped tools, separate OS client processes, session isolation, lifecycle observations, both message directions, replay/conflict/pull/ack, client restart, explicit audit and resource notes pass in the dedicated no-model fixture. This is not a full Prime daemon/TUI/model run.
- Debian control VM verified immutable audit74 and execution82 source snapshots independently, typecheck and respective full suites157/1skip and164/1skip, all frozen source hashes unchanged. These earlier artifacts do not prove later source changes.
- Real Windows compiled ProxyCommand over strict encrypted control SSH forwarding reaches VM relay/node/sshd. Wrong relay secret and wrong SSH host key are rejected. Actual sudo-n remains failure/not-ready.
- Actual local compiled execution mutated an owned fixture once with local pre/post records. Actual remote read-only id/uname ran through selected verified route with local pre/post records, no invented synchronization receipt.
- User-prefix Unix tmux preserved the same worker PID across two real SSH PTY detach/reconnect cycles. This is not unexpected-network-loss, reboot or Env Unix tmux CLI self-SSH proof.

## Retained failures

First Windows typecheck and full-suite platform assumptions failed and were preserved before actual fixes. The wrong-host-key validation driver's Windows file-URL path bug failed before being fixed; it did not prove host-key rejection on that first run. Prime actual source-loader missing-dist and Windows test launcher defects were separately fixed by its owner. Later passes do not erase any first failure. Negative controls deliberately fail if provenance registration or successful ack is falsely assumed.

## Not yet closed

Automatic coverage of arbitrary tool/external mutations; actual Windows-to-VM Prime runtime clients; every Agent's successful administrator identity; full job-result recovery; multi-backend tunnel deployment/probing; public-network/TLS deployment, backup/capacity governance and all six real platforms. User-required outcome goals remain unchanged; declarations and shared bearer are not cryptographic signatures or per-Agent authentication.

The VM `EnvInHands-Debian12` is the current control host and can be used for final integration acceptance. No public ports, SSH keys, sudoers or security settings changed in this milestone. Detailed non-secret raw/exit receipts and Agent-attributed modification ledgers remain in the local workspace handoff evidence; credentials, runtime binaries and temporary DBs are not repository content.
