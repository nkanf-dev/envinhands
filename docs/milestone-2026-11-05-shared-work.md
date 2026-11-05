# Bidirectional shared work and formal service milestone

This stage continued the initial requirements instead of stopping at a gap list.
Different actual Windows and Debian hosts held different owned work files. Each
host read the other's text, updated it with an expected SHA256 and read it back.
Both resource owners independently read their physical files and matched API
receipts to registered Agent/session, target resource and before/after hashes.

## Actual results

- Debian collaborator changed Windows static-work notes. Independent Windows
  disk SHA256: `dd4f3413931753d17471ee3d790095696f47d49811c2ca3f6643668c2c82fcac`.
- Windows collaborator changed Debian dynamic-work notes. Independent VM disk
  initially matched `48b0fc4e401dffffb161ee52a58ca26f500e04ead3d2fc84942addd337b1d36a`.
- Real Prime loader/ExtensionRunner/wrapped shared-file tools on Windows then
  appended another authorized review to the VM work file. Actual session-bound
  audit matched. Final VM independent disk was **170 bytes**, SHA256
  `1e5958c8239459b14da0f6724eae10e78e0458fd63f2bb25f8dbd8222ab9a660`.
- VM formal private-config service started in two separate OS processes, stopped
  cleanly and reused the exact config and DB. Inventory and records were equal.
  The old control bus was not replaced. This is not a system boot service.
- Exact158-file Linux source snapshot passed typecheck and **199 pass/1 skip/0
  fail**; original/source/lock hashes unchanged. Later client adapters are not
  retroactively counted in that snapshot.
- Final Windows source at this stage passed **202 tests**, typecheck and actual
  normal Prime loader configuration (seven Env-owned extensions/two skills).
  Three actual full Prime CLI instances also completed strict-mode service
  collaboration via the Env-owned adapter using a deterministic zero-cost
  provider. This is a no-paid-model regression, not new autonomous model proof.

Shared work is a product API/client, CLI `files read/write`, and normal Prime
`envinhands_read_shared_file` / `envinhands_write_shared_file` tools. Only explicit
shared directories are exposed; current scope is UTF-8 files up to64KiB, with
68KiB JSON envelope. It is not arbitrary disk, binary/directory sync, a resource
lock, or protection against malicious concurrent local writers. Existing
strict authorized SSH forwards carry API traffic; this does not prove distant
networks or automatic NAT traversal.

## Other concrete closures

- Actual selected OpenSSH public-key fingerprint replaces the former identity
  path digest; same-path key replacement no longer reuses its prior readiness.
- Append-only per-registration/session/route/key observations persist through
  API/SQLite restart. The latest negative supersedes an older positive.
- Formal services require registered declared mutation headers; a durable intent
  precedes API effects, followed by result/status and known file hashes. Ordinary
  direct CLI writes and Prime per-session collaboration use this transport.
- Known local edit events capture readable before/after hashes without retaining
  text. Unknown Python/shell effects are not invented as file mutations.
- Owner-confirmed Unix apply/owned revoke executes real safe-path file operations
  and real visudo checks in an isolated Linux fixture. Real system privileges
  were not changed; ready remains false until each actual SSH/admin check passes.
- Normal business collaboration now lives in EnvInHands and reuses shared clients,
  rather than requiring Prime example-source changes. No package/lock additions.

## Evidence and remaining work

Main evidence: cross-host-work-20261105T202717Z and
vm-completion-20261105T202907Z/FORMAL-SERVICE-CROSSHOST-DELIVERY.md, including final
independent disk raw. Unix, access evidence, known-edit hashes and Env collaboration
leases have separate implementing-agent reports with real raw/exit evidence.

Original completion still requires approved per-Agent administrator positives,
Windows provisioning, real Mac/six-device coverage, actual distant-site entry and
failure recovery, plus remaining OS/external mutation recording boundaries and
long-term operations. These are not excused by shared-work success; actual normal
work tested above is usable within its scope. See goal-conformance.md.
