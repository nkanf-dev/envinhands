# Linux registration: fail-closed prototype

This is **not a registration tool yet**. It only validates input and prints a
proposed plan. It never reads or changes accounts, home directories, SSH,
authorized_keys, sudoers, system configuration, or services. It does not use
`sudo` or `visudo`. `apply` always returns a nonzero exit code, even if passed
confirmation flags. There is no rollback command because nothing is changed.
Do not rely on this program to grant or revoke access. A successful plan does
not mean an account exists, a host is reachable, or a node is ready.

## Build and test

Requires Rust and the system libsodium development library (including its linker
name, for example `libsodium-dev` on Debian-family systems). It has no Cargo
crate dependencies. From this directory, run:

```sh
cargo test
cargo run -- plan --user agent --key 'ssh-ed25519 BASE64'
cargo run -- apply
```

Replace `BASE64` with an actual canonical OpenSSH Ed25519 public-key blob.
The `--key` argument must be exactly `ssh-ed25519 BASE64`, with no comment,
authorized_keys options, or extra whitespace. Account names use the deliberately
narrow ASCII pattern `[a-z_][a-z0-9_-]{0,30}`; some valid Linux names are
rejected. This is input screening, **not** account or home validation. Never
pass a private key. Printed public keys are public, but command arguments may
be visible to other local users.

The public-key parser checks canonical standard base64, the exact SSH wire
format and length, libsodium Ed25519 point validation, including canonical encoding, curve
membership, and prime-order subgroup checks. This prototype makes no claim that the key belongs to a particular team
or that possession of its private key has been proven.

## Work required before enabling apply

No individual item below makes this prototype safe to apply. A complete design
needs independent security review and failure/concurrency tests, including:

* Resolve the existing account and its canonical home from the local system.
  Use directory descriptors and `openat`/`openat2` with no symlink traversal;
  check file types, ownership, permissions, and identities after open. Never
  trust a previously checked string path. Define trusted root and symlink rules.
* Preserve every existing `authorized_keys` entry, handle concurrent updates
  without lost writes or truncation, and refuse unsafe files. Correctly define
  locking with other writers, crash recovery, fsync, and exact revocation.
* Safely create a uniquely named sudoers drop-in, without clobbering any existing
  file; validate the exact staged content with trusted `visudo`; atomically
  publish without replacement and sync it. Prevent edits or swaps between
  validation and publication. Define restrictive ownership and modes.
* Require explicit on-machine confirmation that clearly states the account
  receives unrestricted, passwordless root sudo. Specify idempotency, partial
  failure, recovery, and exact revocation. If they cannot be guaranteed, refuse
  to proceed; a two-file operation is not automatically transactional.
* Do not enable or claim SSH connectivity or node readiness. The existing
  independent gate must actually verify SSH login and noninteractive sudo.

All tests must run against isolated temporary directories and a mock `visudo`,
without root and without touching the real system or invoking `sudo`.
