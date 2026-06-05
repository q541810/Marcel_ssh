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
    format!("mkdir -p {dir} && unzip -o -q {tmp} -d {dir} && rm -f {tmp} && echo OK")
}
