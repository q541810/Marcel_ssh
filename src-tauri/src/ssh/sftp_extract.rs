/// Build a shell command to extract a zip archive to target dir.
///
/// Uses only `unzip` + `rm` to avoid injecting shell-escaped paths into
/// embedded Python code (the previous python3 fallback was vulnerable to
/// injection when paths contained single quotes). If `unzip` is not
/// available on the remote host, the extraction fails and the caller
/// should fall back to individual file operations via SFTP.
///
/// Returns "OK" on success so the caller can distinguish success from
/// partial/failed extraction.
pub(crate) fn build_extract_cmd(archive_path: &str, target_dir: &str) -> String {
    let dir = crate::util::shell_escape(target_dir);
    let tmp = crate::util::shell_escape(archive_path);
    // On success: mkdir → unzip → rm tmp → echo OK → exit 0
    // On failure: the || branch always runs rm -f to clean up the temp file
    format!("mkdir -p {dir} && unzip -o -q {tmp} -d {dir} && rm -f {tmp} && echo OK || (rm -f {tmp}; exit 1)")
}

pub(crate) fn build_unzip_check_cmd() -> &'static str {
    "command -v unzip >/dev/null 2>&1 && echo OK || echo MISSING_UNZIP"
}

pub(crate) fn has_unzip(check_output: &str) -> bool {
    check_output.lines().any(|line| line.trim() == "OK")
}

#[cfg(test)]
mod tests {
    use super::{build_unzip_check_cmd, has_unzip};

    #[test]
    fn unzip_check_command_reports_ok_or_missing() {
        let cmd = build_unzip_check_cmd();

        assert!(cmd.contains("command -v unzip"));
        assert!(cmd.contains("echo OK"));
        assert!(cmd.contains("echo MISSING_UNZIP"));
    }

    #[test]
    fn detects_available_unzip_from_exact_ok_line() {
        assert!(has_unzip("OK\n"));
        assert!(has_unzip("some warning\nOK\n"));
    }

    #[test]
    fn treats_missing_or_ambiguous_output_as_unavailable() {
        assert!(!has_unzip("MISSING_UNZIP\n"));
        assert!(!has_unzip(""));
        assert!(!has_unzip("NOT_OK\n"));
    }
}
