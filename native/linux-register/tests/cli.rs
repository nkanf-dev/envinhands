use std::{fs, process::Command};

#[test]
fn cli_never_applies_or_mutates_fixture() {
    let sandbox = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("cli-test-{}", std::process::id()));
    fs::create_dir_all(&sandbox).unwrap();
    let fixture = sandbox.join("authorized_keys");
    fs::write(&fixture, b"original\n").unwrap();
    let binary = env!("CARGO_BIN_EXE_linux-register");
    let output = Command::new(binary).current_dir(&sandbox)
        .args(["apply", "--confirm", "--user", "agent"]).output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("apply is disabled"));
    assert_eq!(fs::read(&fixture).unwrap(), b"original\n");
    let output = Command::new(binary).current_dir(&sandbox).args([
        "plan", "--user", "agent", "--key",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea"
    ]).output().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("NOT READY"));
    assert_eq!(fs::read(&fixture).unwrap(), b"original\n");
    assert_eq!(fs::read_dir(&sandbox).unwrap().count(), 1);
    fs::remove_dir_all(sandbox).unwrap();
}
