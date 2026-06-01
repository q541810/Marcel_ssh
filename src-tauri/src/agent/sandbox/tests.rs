use super::*;

fn sb() -> Sandbox {
    Sandbox::default()
}

// ---- Original suite (preserved) ----

#[test]
fn test_readonly_commands() {
    assert_eq!(assess_risk("ls -la"), RiskLevel::ReadOnly);
    assert_eq!(assess_risk("cat /etc/hosts"), RiskLevel::ReadOnly);
    assert_eq!(assess_risk("pwd"), RiskLevel::ReadOnly);
    assert_eq!(assess_risk("echo hello"), RiskLevel::ReadOnly);
}

#[test]
fn test_echo_with_redirect_elevated() {
    assert!(assess_risk("echo 'bad' > /etc/passwd") >= RiskLevel::Moderate);
}

#[test]
fn test_destructive_commands() {
    assert_eq!(
        assess_risk("dd if=/dev/zero of=/dev/sda"),
        RiskLevel::Destructive
    );
    assert_eq!(assess_risk("mkfs.ext4 /dev/sda1"), RiskLevel::Destructive);
}

#[test]
fn test_high_risk_commands() {
    assert_eq!(assess_risk("rm -rf /tmp/test"), RiskLevel::HighRisk);
    assert_eq!(assess_risk("sudo apt update"), RiskLevel::HighRisk);
    assert_eq!(assess_risk("chmod 777 /var/www"), RiskLevel::HighRisk);
}

#[test]
fn test_sandbox_blocks_rm_rf_root() {
    assert!(sb().check_command("rm -rf /").is_err());
    assert!(sb().check_command("rm  -rf  /").is_err());
    assert!(sb().check_command("rm --recursive --force /").is_err());
}

#[test]
fn test_sandbox_blocks_mkfs() {
    assert!(sb().check_command("mkfs.ext4 /dev/sda1").is_err());
    assert!(sb().check_command("mkfs /dev/sda1").is_err());
}

#[test]
fn test_sandbox_blocks_dd_to_device() {
    assert!(sb().check_command("dd if=/dev/zero of=/dev/sda").is_err());
    assert!(sb().check_command("dd of=/dev/sda if=/dev/zero").is_err());
}

#[test]
fn test_sandbox_blocks_shell_evasion() {
    assert!(sb().check_command("cat /etc/shadow | bash").is_err());
    assert!(sb()
        .check_command("echo cm0gLXJmIC8= | base64 -d | sh")
        .is_err());
    assert!(sb().check_command("eval 'rm -rf /'").is_err());
}

#[test]
fn test_sandbox_allows_safe_commands() {
    assert!(sb().check_command("ls -la").is_ok());
    assert!(sb().check_command("cat /var/log/syslog").is_ok());
    assert!(sb().check_command("mkdir /tmp/test").is_ok());
}

#[test]
fn test_sandbox_elevates_protected_path_risk() {
    let risk = sb().check_command("mkdir /etc/myapp").unwrap();
    assert!(risk >= RiskLevel::HighRisk);
}

#[test]
fn test_path_prefixed_commands() {
    assert_eq!(assess_risk("/usr/bin/ls -la"), RiskLevel::ReadOnly);
    assert_eq!(assess_risk("/bin/rm -rf /tmp/test"), RiskLevel::HighRisk);
}

// ---- New bypass-coverage suite ----

#[test]
fn bypass_chained() {
    assert!(sb().check_command("ls; rm -rf /").is_err());
    assert!(sb().check_command("true && rm -rf /etc").is_err());
    assert!(sb().check_command("false || rm -rf /usr").is_err());
}

#[test]
fn bypass_quoted_and_path_and_backslash() {
    assert!(sb().check_command("\\rm -rf /").is_err());
    assert!(sb().check_command("'rm' -rf /").is_err());
    assert!(sb().check_command("/bin/rm -rf /").is_err());
}

#[test]
fn bypass_env_wrappers() {
    assert!(sb().check_command("env FOO=1 rm -rf /").is_err());
    assert!(sb().check_command("env -i PATH=/bin rm -rf /").is_err());
    assert!(sb().check_command("sudo rm -rf /").is_err());
    assert!(sb().check_command("sudo -u root rm -rf /").is_err());
    assert!(sb().check_command("nohup rm -rf / &").is_err());
}

#[test]
fn bypass_shell_dash_c() {
    assert!(sb().check_command("bash -c \"rm -rf /\"").is_err());
    assert!(sb().check_command("sh -c 'rm -rf /etc'").is_err());
    assert!(sb().check_command("eval \"rm -rf /\"").is_err());
}

#[test]
fn source_is_high_risk() {
    let r = sb().check_command("source /tmp/evil.sh").unwrap();
    assert!(r >= RiskLevel::HighRisk);
}

#[test]
fn subshell_rejected() {
    assert!(sb().check_command("rm -rf $(cat x)").is_err());
    assert!(sb().check_command("rm -rf `cat x`").is_err());
}

#[test]
fn protected_dir_targets() {
    for p in ["/etc", "/usr", "/var", "/boot", "/home", "/root"] {
        assert!(
            sb().check_command(&format!("rm -rf {}", p)).is_err(),
            "should block rm -rf {}",
            p
        );
    }
}

#[test]
fn root_glob_and_home() {
    assert!(sb().check_command("rm -rf /*").is_err());
    assert!(sb().check_command("rm -rf ~").is_err());
    assert!(sb().check_command("rm -rf $HOME").is_err());
}

#[test]
fn rm_combined_flags() {
    assert!(sb().check_command("rm -rfv /etc").is_err());
    assert!(sb().check_command("rm -vfr /etc").is_err());
    assert!(sb().check_command("rm --recursive --force /etc").is_err());
}

#[test]
fn rm_safe_workspaces() {
    let r = sb().check_command("rm -rf /tmp/build");
    eprintln!("DEBUG /tmp/build => {:?}", r);
    eprintln!("DEBUG dangerous = {}", is_dangerous_rm_target("/tmp/build"));
    eprintln!("DEBUG normalize = {}", normalize_path("/tmp/build"));
    assert!(sb().check_command("rm -rf /tmp/build").is_ok());
    assert!(sb().check_command("rm -rf /home/user/proj/dist").is_ok());
}

#[test]
fn dd_targets() {
    assert!(sb().check_command("dd if=/dev/zero of=/dev/sda").is_err());
    assert!(sb()
        .check_command("dd of=/dev/nvme0n1p1 if=/dev/zero")
        .is_err());
    let r = sb()
        .check_command("dd if=/dev/zero of=/tmp/img bs=1M count=10")
        .unwrap();
    assert_eq!(r, RiskLevel::Destructive);
}

#[test]
fn fork_bomb_blocked() {
    assert!(sb().check_command(":(){ :|:& };:").is_err());
}

#[test]
fn no_false_positive_substring_etc() {
    let r = sb().check_command("cat /myetc/data").unwrap();
    assert_eq!(r, RiskLevel::ReadOnly);
}

#[test]
fn echo_string_no_redirect_is_readonly() {
    let r = sb().check_command("echo \"wrote to /dev/sda\"").unwrap();
    assert_eq!(r, RiskLevel::ReadOnly);
}
