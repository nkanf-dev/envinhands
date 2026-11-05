# Explicit shared files between approved hosts

This small filesystem API shares only configured directories. Each host can run
the same handler with `roots: {resourceId: absoluteRoot}`; callers select that
host's approved HTTPS or encrypted loopback-forward origin. Root server/config/
CLI integration supplies the service lifetime and signed mutation audit. This
module does not make arbitrary system paths or commands accessible.

## Core and HTTP interface

`createSharedFiles({roots})` returns `read(resourceId,path)` and `write(input)`.
`createSharedFilesApi({roots,token})` returns `{fetch,close}` for root mounting at
`/v1/shared-files`. `SharedFilesClient extends PrimeBridge` reuses authenticated
bounded transport, with `.read(resourceId,path)` and `.write(input)`.

GET `/v1/shared-files?resourceId=project&path=notes.txt` returns200:

```json
{"resourceId":"project","path":"notes.txt","text":"current UTF-8 text","sha256":"64 lowercase hex digits"}
```

POST accepts all four fields and returns200 for update or creation:

```json
{"resourceId":"project","path":"notes.txt","text":"replacement text","expectedSha256":"hash obtained by read"}
```

Receipt is `{resourceId,path,beforeSha256,afterSha256,bytes}`. Root mutation audit
can use these actual resource/path/hash values without logging request text.
`expectedSha256:null` means **create only if absent**, not blind overwrite. An
existing file requires its current exact hash; stale/mismatched hash returns409.
Use read -> expected write -> receipt/disk verification. Do not automatically
retry a modifying request after an unknown response. A retried already accepted
write can now conflict, so inspect the target instead of generating assumptions.

Files are at most65536 UTF-8 bytes. Empty text is valid. GET preserves a UTF-8 BOM
so returned text hashes to the original bytes. Binary/invalid UTF-8 read returns
400; oversized file413; missing file/parent/resource404; outside-root or nonregular
403; invalid paths/fields400; missing/wrong bearer401. API JSON write envelope is
bounded68KiB, independently of the old general16KiB HTTP boundary. JSON escaping
or long paths can exceed that envelope even if text alone fits64KiB; client/API
reject, never truncate. Root audit must apply the endpoint's matching bounded
body handling. Read responses use a512KiB client ceiling for escaped JSON, while
write receipts use256KiB.

## Path and write mechanics

The root must already exist. Paths are relative `/`-separated ordinary filenames;
absolute paths, empty/dot/dotdot components, backslashes, drive/stream colons,
control characters and trailing-dot/space components are rejected. No automatic
directory creation occurs. Root realpath and existing parent realpath are checked
for containment. Final symlink/nonregular files are refused; symlink parents that
leave the root are refused. Approved roots/parent directories remain operator
controlled. This is not a hostile OS-user sandbox: another local process able to
replace directories concurrently is outside the shared-bearer trusted-team model.

Writes are serialized per canonical target within one process. Expected hash is
checked inside that queue and immediately before publication. Data goes to a
unique same-directory0600 file, is fsynced, then existing-file update publishes by
atomic rename. Creation publishes by atomic no-overwrite hard link then removes
the temporary link, so a concurrently created file is not silently overwritten.
Parent directory fsync is used where Node supports it; Windows does not expose
equivalent directory durability. This is no promise of cross-process atomic CAS
against arbitrary external writers or a resource reservation/lease. External
changes should be reconciled via hashes, not an automatic write replay.

All temp artifacts are owned by the current write. A post-publication error can
mean effects exist even if the receipt was lost or durability failed. Only inspect
actual target/receipts before retrying. Hashes are observations, not authentication.
No shell, Python watcher, code execution or guessed remote mutation target is used.

## Authentication and mutation attribution

Bearer sharing trusts the team, not multi-tenant role isolation. Use only approved
resource roots; anyone with the token has broad file authority there. Service
credential content is rejected from this API's text/write result paths, but that
is not an arbitrary secret detector. Do not place sensitive unrelated files in
shared roots. No bearer/private-key material belongs in argv, logs or shared text.

POST must be mounted under the root's existing mutation audit/signed actor
transport. The handler itself does not re-register or recursively audit the actor.
It returns before/after hashes for that root boundary. GET is read only. The core
can be embedded directly, but that embedding caller must supply its own declared
mutation attribution; this API does not invent a real Agent/session identity.
`close()` prevents subsequent handler requests; root HTTP lifetime owns draining
already accepted writes and stopping listeners.

## Native validation and actual use

`bun test test/shared-files.test.ts` uses a real temporary HTTP handler, two client
instances, actual files and independent disk readback. It covers create/read/
expected-update/stale conflict/create-only conflict, competing same-hash writers,
64KiB file/BOM, authentication, missing files, traversal and a real Windows
junction/POSIX directory symlink escaping the allowed root. It uses no model,
real keys or existing user files.

The main coordinator separately runs a Windows root and a Debian VM root over
approved encrypted routes for real bidirectional sharing/modification/work.
Local two-client fixture passes are not proof of that cross-host deployment,
SSH/admin readiness, arbitrary NAT traversal, all six devices or OS isolation.
