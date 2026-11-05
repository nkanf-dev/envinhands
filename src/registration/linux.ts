/**
 * Linux registration planning only. Neither function touches the filesystem,
 * invokes commands or contacts a network. This module does not create keys or
 * accept private keys. Full administrator sudo is a serious privilege grant.
 */
import { createHash } from "node:crypto";

export interface LinuxRegistrationInput {
  user: string;
  /** One unadorned OpenSSH Ed25519 public key, without options or comment. */
  publicKey: string;
}

export interface LinuxRegistrationPlan {
  readonly kind: "linux-registration-plan";
  readonly version: 1;
  readonly user: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly sudoersPath: string;
  /** Grants unrestricted root, not just permission to run sudo -n true. */
  readonly sudoersContent: string;
  readonly steps: readonly string[];
  readonly rollback: readonly string[];
  readonly ready: false;
}

/** Strictly parse the binary SSH public-key wire structure, not just its label. */
function parseEd25519PublicKey(value: unknown): { line: string; bytes: Buffer } {
  if (typeof value !== "string" || value.length > 128) throw new Error("Invalid public key");
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[0] !== value) throw new Error("Only one unadorned ssh-ed25519 public key is supported");
  const text = match[1];
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text || bytes.length !== 51 ||
      bytes.readUInt32BE(0) !== 11 || bytes.subarray(4, 15).toString("ascii") !== "ssh-ed25519" ||
      bytes.readUInt32BE(15) !== 32) throw new Error("Invalid Ed25519 public key encoding");
  // Compare exact bytes too: ASCII decoding masks high bits.
  if (!bytes.subarray(4, 15).equals(Buffer.from("ssh-ed25519", "ascii"))) {
    throw new Error("Invalid Ed25519 public key encoding");
  }
  return { line: value, bytes };
}

/**
 * Produces a reviewable proposal, not proof of installed access. Only a narrow
 * username/key subset is supported to rule out sudoers and path injection.
 * Account home and filesystem safety cannot be inferred without inspecting the
 * target; no assumption is made that the home is /home/<user>.
 */
export function prepareLinuxRegistration(input: LinuxRegistrationInput): LinuxRegistrationPlan {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => key !== "user" && key !== "publicKey")) {
    throw new Error("Invalid registration input");
  }
  if (typeof input.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.user) || /[^a-z0-9_-]/.test(input.user) || input.user === "root") {
    throw new Error("Invalid or unsupported username");
  }
  const key = parseEd25519PublicKey(input.publicKey);
  const plan: LinuxRegistrationPlan = {
    kind: "linux-registration-plan", version: 1, user: input.user,
    publicKey: key.line,
    fingerprint: `SHA256:${createHash("sha256").update(key.bytes).digest("base64").replace(/=+$/, "")}`,
    sudoersPath: `/etc/sudoers.d/envinhands-${input.user}`,
    sudoersContent: `${input.user} ALL=(ALL:ALL) NOPASSWD: ALL\n`,
    steps: Object.freeze([
      "Resolve the existing local account and its actual home; require trusted ownership and safe paths without symlinks.",
      "Preserve all existing authorized_keys data and add only the specified key if absent; do not replace or truncate existing keys.",
      "Validate the proposed sudoers policy with visudo, then install atomically with safe ownership and permissions, without clobbering an existing file.",
      "Independently verify SSH public-key login and sudo -n true using a trusted host key; this plan does not perform verification.",
    ]),
    rollback: Object.freeze([
      "Remove only the key added by this registration, preserving pre-existing keys and later changes; if ownership of the entry is uncertain, stop and review.",
      "Remove the sudoers drop-in only if it is the unchanged file installed by this registration; validate the resulting sudoers configuration and preserve unrelated policy.",
    ]),
    ready: false,
  };
  return Object.freeze(plan);
}

export interface LinuxRegistrationApplyResult {
  readonly status: "blocked";
  readonly ready: false;
  readonly message: string;
}

/**
 * Explicit apply entry point, deliberately fail-closed. The required secure
 * descriptor-relative no-symlink traversal, race-safe key update and validated
 * atomic sudoers transaction/rollback are not implemented. Never substitute a
 * normal path-based write or claim that either capability has been installed.
 */
export async function applyLinuxRegistration(_plan: LinuxRegistrationPlan): Promise<LinuxRegistrationApplyResult> {
  return { status: "blocked", ready: false,
    message: "Not implemented: secure path traversal, concurrent authorized_keys updates, visudo validation and atomic sudoers installation/rollback. No changes were made." };
}
