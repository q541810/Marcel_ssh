/// Build a shell command to extract a zip archive to target dir, with fallback.
pub(crate) fn build_extract_cmd(archive_path: &str, target_dir: &str) -> String {
    format!(
        "mkdir -p {dir} && (unzip -o {tmp} -d {dir} 2>&1 || python3 -c \"import zipfile; zipfile.ZipFile({tmp}).extractall({dir})\" 2>&1) && rm -f {tmp} && echo OK",
        dir = crate::util::shell_escape(target_dir),
        tmp = crate::util::shell_escape(archive_path)
    )
}
