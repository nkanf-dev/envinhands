# Explicit shared files between approved hosts

This small filesystem API shares only configured directories. Each host can run
the same handler with `roots: {resourceId: absoluteRoot}`; callers select that
host's approved HTTPS or encrypted loopback-forward origin. Root server/config/
CLI integration supplies the service lifetime and signed mutation audit. This
module does not make arbitrary system paths or commands accessible.

## Shared resource and directory discovery

GET `/v1/shared-resources` returns
`{resources:[{resourceId,kind:"shared-directory",capabilities:["read","comparewrite"]}]}`.
It lists configured resource IDs only, never the host's absolute root directory.
It describes configured capability, not a live probe of directory availability or
an administrator grant. `client.listResources()` reads this catalog.

GET `/v1/shared-files/list?resourceId=project&path=` lists the selected root;
path may be omitted/empty for this endpoint only. `client.list(resourceId,path="")`
returns `{resourceId,path,entries,hasMore}`. Entries contain only
`{name,type,bytes,modifiedAt}`. Type is file, directory or unsupported; file bytes
is its size, directory/unsupported bytes is null. Symlinks are not followed and
are marked unsupported with null metadata. Navigating a symlink directory is
refused, including a junction that escapes the configured root. Nested files
are not returned until the caller explicitly lists that subdirectory.

Directory reading uses `opendir` and inspects at most the current first100 entries
plus one lookahead to determine `hasMore`. Enumeration order is filesystem order,
not a stable sorted listing. `hasMore:true` means the result is incomplete; this
release has no cursor or recursive scan. Split/narrow the shared work directory
or select known subdirectories rather than treating100 entries as the full tree.
No depth parameter is accepted. Names/types/sizes/times are untrusted observations,
not commands or permission to modify. No absolute directory paths are returned.
All discovery routes require the same bearer and are read-only. Root server,
CLI and Prime integration mount these endpoints; this module does not change
those host entrypoints or running services.

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
junction/POSIX directory symlink escaping the allowed root. Discovery fixtures
also check metadata-only roots, one-level listings, nested navigation,
unsupported symlinks and101 files yielding100 entries with explicit hasMore. It uses no model,
real keys or existing user files.

The main coordinator separately runs a Windows root and a Debian VM root over
approved encrypted routes for real bidirectional sharing/modification/work.
Local discovery/two-client fixture passes are not proof of that cross-host deployment,
SSH/admin readiness, arbitrary NAT traversal, all six devices or OS isolation.

Existing Unix file updates preserve ordinary permission bits (0777), not special
privilege bits. A nativeLinux0750script read→CASwrite→readback kept0750 in an
independent owned fixture; new files remain0600. Windows existing-file replacement uses native ReplaceFile (no rename fallback) and verifies owner/group, exact DACL bytes/nullness, and control flags except Windows automatic-inheritance bookkeeping bit0x400. Both ordinary inherited ACL and explicit protected DACL fixtures passed on first replacement; source and compiled product paths were tested. This is independent Windows evidence, not a POSIX-mode inference.

## Normal caller operation references and uncertain responses

`files write [HOST_ID]` and `envinhands_write_shared_file` now choose a fresh
nonsecret operationId before dispatch and retain the same ID in the signed HTTP
header. Their JSON receipt includes hostId, operationId and status. Success keeps
the existing resource/path/beforeSha256/afterSha256/bytes fields. A received409
is `conflict`; network loss, completion503 or another unconfirmed response is
`unknown`, never evidence that no file changed. CLI exits1 and Prime returns
isError for conflict/unknown but still returns the reference. This ID is for
inspection, not permission or an automatically replayable task identifier.

Use the same selected host:

```text
<env-command> files inspect HOST_ID
```

stdin is `{ "operationId": "original-returned-id" }`, with optional `after`
(nonnegative sequence cursor). Without a catalog, omit HOST_ID and keep the same
configured service. Prime provides `envinhands_inspect_shared_write` with
`{hostId,operationId,after?}` (hostId required only with a catalog). Both query
that selected host's existing ChangeClient log and return only records whose
operationId matches. The default unrelated control origin is not queried.

Inspection reads up to10 pages of10 records per call. `nextAfter` is the next
explicit inspection cursor or null once the available log ends. Continue with
that cursor when present; empty records on an incomplete page do not prove the
operation never ran. This reuses existing sequence pagination, not a new task DB
or full-resource watcher. Records are declared shared-bearer observations, not
cryptographic identity or an execution grant. Correlate the signed intent/outcome,
actual target/path and returned hashes with a new file read before deciding how
to reconcile. Unknown response must never cause an automatic second write.

Native fixtures perform a real HTTP file update, discard its actual response in
the injected client transport, obtain unknown+originalreference, inspect the same
selected host and independently read disk. They verify one write only and a
distinct409 result. This is a controlled transport-loss fixture, not a new live
network outage or paid-model run.

## Outbound service entry and stable client references

`publish PRIVATE_PROFILE` publishes an owned local loopback service to an already
authorized SSH entry's loopback port, using strict host keys and an actual OpenSSH
forward-success confirmation. It does not open a public listener or configure
sshd/firewall. `access PRIVATE_PROFILE` can use fixed `localPort` so the private
host catalog survives entry restart unchanged. Actual opposite-host authenticated
catalog/list/read passed before and after each owned entry restart, with no
write replay. See control-ingress.md and remote-access.md.

Existing file modes and ACLs remain important when collaboration modifies work:
new files are private by default, existing Unix normal bits preserved, existing
Windows access descriptor equivalence checked as above. These checks do not
provide cross-process locks or protection against malicious concurrent local
writers. A post-replacement verification error means effects may exist; retain
hostId/operationId, inspect the selected host and read back, never blindly retry.

## Client/runtime boundary

SharedFilesClient and write-operation inspection import only the pure
shared-files-model wire schema/hash/constants, not server filesystem code or
native PowerShell assets. This matters for ordinary Node/Prime source loading.
The resource service's Bun filesystem implementation still uses the native
Windows helper for access-right preservation. A cold normal Node controller and
Prime loader failure exposed the original accidental dependency; pure-model
separation fixed it, and native Node client discovery/read across both current
hosts passed. Do not solve a client-import failure merely by changing the
controller to Bun and claiming normal Node compatibility.
