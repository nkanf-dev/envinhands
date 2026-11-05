# Per-client SSH identity and persisted access observations

`verifyClientAccess` checks an already authorized real SSH identity/path and the
remote Unix noninteractive sudo or Windows effective administrator token. It does
not install keys/privileges. An explicit absolute `access.identityFile` is now
required. `sshIdentityRef` is the selected key's actual OpenSSH `SHA256:` public
fingerprint, not a hash of the filename. `sshUser` is also part of freshness.

`fingerprintSshIdentity(path,timeoutMs)` invokes installed `ssh-keygen -y -P "" -f
<identityFile>` with argv, no shell, stdin ignored and bounded output/time. Only
public output is captured; JavaScript does not read private-key bytes and neither
key text nor stderr is logged or sent to the service. It derives from the selected
file rather than trusting a potentially stale `.pub` sibling. This noninteractive
route supports unencrypted existing key files; encrypted keys that need a
passphrase cannot be derived with an empty passphrase and fail explicitly. No
passphrase collection, agent fallback or automatic key creation occurs.

The fingerprint is read before and after verification. A changed key or failure
to recheck cannot produce ready. A later current-key fingerprint must be supplied
to `isClientAccessFresh`, together with registration/agent/session/target/route/
user/host-key alias. Same path with different key does not reuse the old ready
observation. This remains a local declaration about the chosen identity; the SSH
client/server authentication and strict host-key checks do the actual network
trust work. The client must use a dedicated explicit identity profile; this is
not a signed SSH authentication transcript or proof to a remote service.

The original injected `CommandRunner` returns only exitCode, not stdout. It is
still used for real SSH route/admin probes. Tests may inject a separate
`fingerprint(identityFile,timeoutMs)` operation; production uses real ssh-keygen.
TTL defaults five minutes and is bounded to at most five minutes. A normal
non-admin result remains ready:false/status:not-ready. No machine heartbeat or
service-side identity can renew a client's evidence.

## Persistent declared-observation API

`createAccessEvidenceApi({dbPath,token})` returns `{fetch,close}`; the root server
mounts `/v1/access-evidence`. The root mutation wrapper handles signed mutation
headers/audit; this module does not recursively record its own POST.

- POST `/v1/access-evidence`: `{requestId,evidence}`. Evidence is the exact
  `ClientAccessEvidence` object (including sshUser and SHA256 fingerprint).
  New201, same request/same input200, conflicting request409. Returns
  `{record:{requestId,evidence,sequence,recordedAt,registration},duplicate}`.
- The referenced immutable registration must already exist in the same DB.
  Missing404; a different registered agent/session409. Root callers register with
  the existing `ChangeClient` first, then submit with the same registration's
  signed transport headers. The API does not invent or replace registrations.
- GET requires `registrationId` and `targetMachineId`; optional `routeId` and
  `sshIdentityRef` narrow a key/path. `after` defaults0 and `limit` defaults100,
  maximum100; the reused client defaults10. Entries are historical append-only
  observations in sequence order, not automatically global latest-ready state.
  `nextAfter` is the last sequence only if more records exist, otherwise null.
  Empty/duplicate/unknown/noncanonical queries are rejected. Request bodies reuse
  the16KiB shared boundary; client responses are bounded256KiB.

`AccessEvidenceClient extends PrimeBridge` provides
`submit(requestId,evidence)` and `list({registrationId,targetMachineId,routeId?,
sshIdentityRef?,after?,limit?})`. Construct with existing `{baseUrl,token,fetch}`;
root can supply `createSignedFetch` as fetch. No new dependency or protocol fork.

The SQLite store initializes/reuses the existing immutable registration schema
through `createChangeStore`, then adds only `access_evidence` and its index. Use
a real filename, not `:memory:`, for this persistence path. Registration snapshots
are returned with historical observations. No machine table is updated and a
submitted ready:true declaration never promotes global machine ready. The bearer
holder can still claim identities; persisted observations are not cryptographic
proofs, delegated grants or protection against a malicious trusted member.

Expiry is evaluated against the consumer's current clock/key/identity, not
rewritten into historical evidence. Querying an old ready row does not mean it is
fresh or supersede a later not-ready result. Consumers use `client.latest({registrationId,targetMachineId,routeId,sshIdentityRef,sshUser})` to select the latest sequence for that exact scope, then use `isClientAccessFresh` with the current session/key/alias. Never use `any(history.ready)`: a newer not-ready result overrides an older success.
A restart preserves checkedAt/expiresAt, never extends TTL.

## Validation and limits

Explicit native tests: `bun test test/client-access.test.ts test/access-evidence.test.ts`.
They cover same-file actual key replacement with stale `.pub`, real public-only
ssh-keygen derivation on an owned generated key, expiry/session/path distinctions,
actual HTTP/SQLite immutable registration binding, idempotent POST/conflicts,
pagination and service restart. The machine remains pending even after accepting
ready evidence. Fake SSH/admin exit-code runners test logic, not actual positive
administrator access. No live keys, real privileges or model API are used.

Node24 can run the client-access file with `--experimental-transform-types`.
Windows Bun child completion has measurable overhead: fixtures generate their
own keys in memory and make one native derivation, avoiding sleeps/time-limit
inflation. Earlier timed-out attempts are preserved in the delivery report.
The main coordinator separately mounts signed transport and checks the real
approved identity/VM; Mac support code does not imply a real Mac/key/admin pass.
