// libsodium performs canonical encoding, curve and prime-subgroup checks.
#[link(name = "sodium")]
unsafe extern "C" {
    fn crypto_core_ed25519_is_valid_point(point: *const u8) -> i32;
}

// A 51-byte SSH blob encodes to exactly 68 unpadded standard-base64 bytes.
fn decode_key_blob(text: &str) -> Option<[u8; 51]> {
    let bytes = text.as_bytes();
    if bytes.len() != 68 { return None; }
    fn digit(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62), b'/' => Some(63), _ => None,
        }
    }
    let mut out = [0u8; 51];
    for (i, part) in bytes.chunks_exact(4).enumerate() {
        let a = digit(part[0])?; let b = digit(part[1])?;
        let c = digit(part[2])?; let d = digit(part[3])?;
        out[3*i] = (a << 2) | (b >> 4);
        out[3*i+1] = (b << 4) | (c >> 2);
        out[3*i+2] = (c << 6) | d;
    }
    Some(out)
}
use std::process::ExitCode;

// Deliberately narrower than the set of all Linux account names. In particular,
// no sudoers metacharacters, whitespace, domain separators, or control bytes.
fn validate_user(user: &str) -> Result<(), &'static str> {
    let b = user.as_bytes();
    if b.is_empty() || b.len() > 31 || !(b[0].is_ascii_lowercase() || b[0] == b'_') {
        return Err("account must match [a-z_][a-z0-9_-]{0,30}");
    }
    if !b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-') {
        return Err("account must match [a-z_][a-z0-9_-]{0,30}");
    }
    Ok(())
}

// Accept exactly a canonical, option-free OpenSSH Ed25519 public key with no
// comment. This rejects authorized_keys options, newline injection, and hidden
// data. The key is a two-string RFC 4251 blob, with no trailing bytes.
fn validate_key(key: &str) -> Result<(), &'static str> {
    let b64 = key.strip_prefix("ssh-ed25519 ").ok_or("expected ssh-ed25519 key")?;
    if b64.is_empty() || b64.bytes().any(|c| c.is_ascii_whitespace()) {
        return Err("key comments, options, and whitespace are not accepted");
    }
    let blob = decode_key_blob(b64).ok_or("invalid canonical base64")?;
    if blob.len() != 51 || blob[..4] != [0, 0, 0, 11] || &blob[4..15] != b"ssh-ed25519" || blob[15..19] != [0, 0, 0, 32] {
        return Err("invalid Ed25519 SSH wire encoding");
    }
    let bytes: [u8; 32] = blob[19..].try_into().map_err(|_| "invalid key length")?;
    // SAFETY: bytes is a live 32-byte array, which libsodium reads but does not modify.
    if unsafe { crypto_core_ed25519_is_valid_point(bytes.as_ptr()) } != 1 {
        return Err("invalid, non-canonical, or weak Ed25519 point");
    }
    Ok(())
}

fn usage() {
    eprintln!("Usage: linux-register plan --user USER --key 'ssh-ed25519 BASE64'\n       linux-register apply [ARGS...]\n\nThis is a no-side-effects planning prototype. Apply is not implemented.");
}

fn run(args: &[String]) -> Result<(), String> {
    let Some(command) = args.first().map(String::as_str) else { usage(); return Err("missing command".into()) };
    if command == "apply" {
        return Err("apply is disabled: no system changes were made".into());
    }
    if command != "plan" { usage(); return Err("unknown command".into()); }
    let mut user = None;
    let mut key = None;
    let mut i = 1;
    while i < args.len() {
        if i + 1 >= args.len() { return Err("option needs a value".into()); }
        let slot = match args[i].as_str() {
            "--user" => &mut user,
            "--key" => &mut key,
            _ => return Err("unknown option".into()),
        };
        if slot.is_some() { return Err("duplicate option".into()); }
        *slot = Some(args[i + 1].as_str());
        i += 2;
    }
    let user = user.ok_or("missing --user")?;
    let key = key.ok_or("missing --key")?;
    validate_user(user)?;
    validate_key(key)?;
    println!("PLAN ONLY — no changes made\nAccount: {user}\nPublic key: {key}\nProposed access: SSH public key and unrestricted passwordless root sudo\nNot checked: account, home, ownership, sshd, sudoers, visudo, connectivity\nNOT READY: apply is disabled; independent SSH and sudo gate required");
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => { eprintln!("error: {err}"); ExitCode::FAILURE }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINda mAGCsQq30L/lTxmTnXMVl8W6xQuYr0/ynvwbJURH";
    fn encode(blob: &[u8]) -> String {
        let abc = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        assert_eq!(blob.len() % 3, 0);
        let mut result = String::new();
        for p in blob.chunks_exact(3) {
            for n in [p[0] >> 2, (p[0] << 4 | p[1] >> 4) & 63, (p[1] << 2 | p[2] >> 6) & 63, p[2] & 63] {
                result.push(abc[n as usize] as char);
            }
        }
        result
    }
    // RFC 8032, section 7.1, first test vector.
    fn good_key() -> String {
        let hex = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
        let mut blob = b"\0\0\0\x0bssh-ed25519\0\0\0\x20".to_vec();
        for n in (0..hex.len()).step_by(2) { blob.push(u8::from_str_radix(&hex[n..n+2], 16).unwrap()); }
        format!("ssh-ed25519 {}", encode(&blob))
    }
    #[test] fn valid_key_and_user() {
        assert!(validate_key(&good_key()).is_ok());
        for user in ["alice", "_svc", "agent-01", "a_b"] { assert!(validate_user(user).is_ok()); }
    }
    #[test] fn bad_users() {
        for user in ["", "root ALL=(ALL) NOPASSWD: ALL", "-a", "1a", "a\nb", "a:b", "UPPER", "a/b", "é", "abcdefghijklmnopqrstuvwxyz123456"] {
            assert!(validate_user(user).is_err(), "accepted {user:?}");
        }
    }
    #[test] fn key_injection_and_shape() {
        let key = good_key();
        for bad in [format!("{key} comment"), format!("{key}\nssh-ed25519 injected"), format!("command=evil {key}"), key.replace("ssh-ed25519", "ssh-rsa"), KEY.to_string(), format!("{key}=")] {
            assert!(validate_key(&bad).is_err(), "accepted {bad:?}");
        }
        let mut blob = decode_key_blob(key.split_once(' ').unwrap().1).unwrap().to_vec();
        assert!(validate_key(&format!("{key}A")).is_err());
        blob[18] = 31;
        assert!(validate_key(&format!("ssh-ed25519 {}", encode(&blob))).is_err());
        blob[18] = 32; blob[19..].fill(0);
        assert!(validate_key(&format!("ssh-ed25519 {}", encode(&blob))).is_err());
    }
    #[test] fn apply_always_fails_and_options_are_strict() {
        assert!(run(&["apply".into(), "--confirm".into()]).is_err());
        assert!(run(&["plan".into(), "--user".into(), "alice".into(), "--user".into(), "bob".into(), "--key".into(), good_key()]).is_err());
        assert!(run(&["plan".into(), "--user".into(), "alice".into(), "--key".into(), good_key()]).is_ok());
    }
}
