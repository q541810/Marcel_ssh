#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArchiveType {
    Zip,
    TarGz,
    TarBz2,
    TarXz,
    Tar,
}

/// Compound extensions ordered longest-first so `.tar.gz` matches before `.gz`.
const ARCHIVE_EXTENSIONS: &[(&str, ArchiveType)] = &[
    (".tar.gz", ArchiveType::TarGz),
    (".tar.bz2", ArchiveType::TarBz2),
    (".tar.xz", ArchiveType::TarXz),
    (".tgz", ArchiveType::TarGz),
    (".tbz2", ArchiveType::TarBz2),
    (".txz", ArchiveType::TarXz),
    (".tar", ArchiveType::Tar),
    (".zip", ArchiveType::Zip),
];

pub(crate) fn get_archive_type(filename: &str) -> Option<ArchiveType> {
    let lower = filename.to_ascii_lowercase();
    for &(ext, kind) in ARCHIVE_EXTENSIONS {
        if lower.ends_with(ext) {
            return Some(kind);
        }
    }
    None
}

/// Build a shell command to extract an archive to a target dir.
///
/// Returns "OK" on success.
pub(crate) fn build_extract_to_dir_cmd(
    archive_path: &str,
    target_dir: &str,
    kind: ArchiveType,
) -> String {
    let dir = crate::util::shell_escape(target_dir);
    let arc = crate::util::shell_escape(archive_path);
    let tmp = "$(mktemp -d /tmp/marcel-extract-XXXXXX)";
    let extract = match kind {
        ArchiveType::Zip => format!("unzip -q {arc} -d \"$tmp\""),
        ArchiveType::TarGz => format!("tar xzf {arc} -C \"$tmp\""),
        ArchiveType::TarBz2 => format!("tar xjf {arc} -C \"$tmp\""),
        ArchiveType::TarXz => format!("tar xJf {arc} -C \"$tmp\""),
        ArchiveType::Tar => format!("tar xf {arc} -C \"$tmp\""),
    };
    format!(
        "tmp={tmp} && trap 'rm -rf \"$tmp\"' EXIT && {extract} && mkdir -p {dir} && cd \"$tmp\" && conflict_file=\"$tmp/.marcel-conflict\" && find . -mindepth 1 -print | while IFS= read -r p; do rel=${{p#./}}; if [ -e {dir}/\"$rel\" ]; then echo CONFLICT: \"$rel\" > \"$conflict_file\"; break; fi; done && if [ -s \"$conflict_file\" ]; then cat \"$conflict_file\"; exit 1; fi && cp -a \"$tmp\"/. {dir}/ && echo OK"
    )
}

pub(crate) fn build_unzip_check_cmd() -> &'static str {
    "command -v unzip >/dev/null 2>&1 && echo OK || echo MISSING_UNZIP"
}

pub(crate) fn build_tar_check_cmd() -> &'static str {
    "command -v tar >/dev/null 2>&1 && echo OK || echo MISSING_TAR"
}

pub(crate) fn build_zip_check_cmd() -> &'static str {
    "command -v zip >/dev/null 2>&1 && echo OK || echo MISSING_ZIP"
}

/// Build a shell command to compress a directory into an archive.
///
/// `source_dir` must be an absolute path. It is split into parent + basename
/// so that `tar -C <parent> <basename>` / `zip` produces an archive containing
/// the directory itself (not its contents flattened).
///
/// Returns "OK" on success, "FAILED" on non-zero exit. The caller checks for
/// the "OK" marker to determine success (same convention as extract).
pub(crate) fn build_compress_to_archive_cmd(
    source_dir: &str,
    target_path: &str,
    kind: ArchiveType,
) -> Result<String, &'static str> {
    // Trim trailing '/' so rsplit_once gives the correct basename.
    // Root "/" is rejected upstream by the system-path blacklist.
    let trimmed = source_dir.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("源路径无效");
    }
    let (parent, dirname) = trimmed
        .rsplit_once('/')
        .map(|(p, n)| (p, n))
        .unwrap_or(("", trimmed));
    if dirname.is_empty() {
        return Err("源路径无效");
    }
    // parent == "" means source is a top-level dir like /home; tar -C "" fails,
    // so normalize to "/".
    let parent = if parent.is_empty() { "/" } else { parent };

    let parent_esc = crate::util::shell_escape(parent);
    let dirname_esc = crate::util::shell_escape(dirname);
    let target_esc = crate::util::shell_escape(target_path);

    let compress = match kind {
        ArchiveType::TarGz => {
            format!("tar -czf {target_esc} -C {parent_esc} {dirname_esc}")
        }
        ArchiveType::Zip => {
            // zip needs to chdir to parent first; -r recursive, -q quiet (we
            // still want stderr for errors), -y store symlinks as-is.
            format!("cd {parent_esc} && zip -rqy {target_esc} {dirname_esc}")
        }
        _ => return Err("压缩仅支持 tar.gz 和 zip"),
    };

    Ok(format!("{compress} && echo OK || echo FAILED"))
}

pub(crate) fn has_tool(check_output: &str) -> bool {
    check_output.lines().any(|line| line.trim() == "OK")
}

// Keep the old name as an alias for backward compatibility.
pub(crate) fn has_unzip(check_output: &str) -> bool {
    has_tool(check_output)
}

/// Build a shell command to extract a zip archive to target dir (used by folder upload).
///
/// Returns "OK" on success so the caller can distinguish success from
/// partial/failed extraction.
pub(crate) fn build_extract_cmd(archive_path: &str, target_dir: &str) -> String {
    build_extract_to_dir_cmd(archive_path, target_dir, ArchiveType::Zip)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn tar_check_command_works() {
        let cmd = build_tar_check_cmd();
        assert!(cmd.contains("command -v tar"));
        assert!(has_tool("OK\n"));
        assert!(!has_tool("MISSING_TAR\n"));
    }

    #[test]
    fn detects_archive_types() {
        assert_eq!(get_archive_type("a.zip"), Some(ArchiveType::Zip));
        assert_eq!(get_archive_type("a.tar"), Some(ArchiveType::Tar));
        assert_eq!(get_archive_type("a.tar.gz"), Some(ArchiveType::TarGz));
        assert_eq!(get_archive_type("a.tgz"), Some(ArchiveType::TarGz));
        assert_eq!(get_archive_type("a.tar.bz2"), Some(ArchiveType::TarBz2));
        assert_eq!(get_archive_type("a.tbz2"), Some(ArchiveType::TarBz2));
        assert_eq!(get_archive_type("a.tar.xz"), Some(ArchiveType::TarXz));
        assert_eq!(get_archive_type("a.txz"), Some(ArchiveType::TarXz));
        assert_eq!(get_archive_type("a.txt"), None);
        assert_eq!(get_archive_type("a.gz"), None); // bare .gz is not a tar.gz
        assert_eq!(get_archive_type("a.TAR.GZ"), Some(ArchiveType::TarGz));
    }

    #[test]
    fn build_tar_extract_cmd_uses_correct_flags() {
        let cmd = build_extract_to_dir_cmd("/tmp/a.tar.gz", "/home/user", ArchiveType::TarGz);
        assert!(cmd.contains("tar xzf"));
        assert!(cmd.contains("-C"));
        assert!(cmd.contains("mkdir -p"));
    }

    #[test]
fn build_extract_cmd_produces_valid_zip_command() {
    let cmd = build_extract_cmd("/tmp/a.zip", "/home/user");
    assert!(cmd.contains("unzip -q"));
    assert!(!cmd.contains("unzip -o"));
    assert!(cmd.contains("CONFLICT"));
    assert!(cmd.contains("cp -a"));
}

#[test]
fn zip_check_command_works() {
    let cmd = build_zip_check_cmd();
    assert!(cmd.contains("command -v zip"));
    assert!(has_tool("OK\n"));
    assert!(!has_tool("MISSING_ZIP\n"));
}

#[test]
fn compress_cmd_tar_gz_splits_parent_and_basename() {
    let cmd =
        build_compress_to_archive_cmd("/home/user/foo", "/tmp/foo.tar.gz", ArchiveType::TarGz)
            .unwrap();
    assert!(cmd.contains("tar -czf"));
    assert!(cmd.contains("-C '/home/user'"));
    assert!(cmd.contains("'foo'"));
    assert!(cmd.contains("'/tmp/foo.tar.gz'"));
    assert!(cmd.ends_with("&& echo OK || echo FAILED"));
}

#[test]
fn compress_cmd_zip_uses_cd_and_zip_rqy() {
    let cmd =
        build_compress_to_archive_cmd("/home/user/foo", "/tmp/foo.zip", ArchiveType::Zip).unwrap();
    assert!(cmd.contains("cd '/home/user'"));
    assert!(cmd.contains("zip -rqy"));
    assert!(cmd.contains("'/tmp/foo.zip'"));
    assert!(cmd.contains("'foo'"));
}

#[test]
fn compress_cmd_normalizes_root_parent() {
    // /home (top-level dir) → parent should be "/"
    let cmd =
        build_compress_to_archive_cmd("/home", "/tmp/home.tar.gz", ArchiveType::TarGz).unwrap();
    assert!(cmd.contains("-C '/'"));
    assert!(cmd.contains("'home'"));
}

#[test]
fn compress_cmd_trims_trailing_slash() {
    let cmd = build_compress_to_archive_cmd(
        "/home/user/foo/",
        "/tmp/foo.tar.gz",
        ArchiveType::TarGz,
    )
    .unwrap();
    // trailing / must not produce empty basename
    assert!(cmd.contains("'foo'"));
    assert!(!cmd.contains("''"));
}

#[test]
fn compress_cmd_rejects_invalid_paths() {
    // empty after trim → root "/"
    assert!(build_compress_to_archive_cmd("/", "/x.tar.gz", ArchiveType::TarGz).is_err());
    // unsupported format
    assert!(build_compress_to_archive_cmd(
        "/home/user/foo",
        "/tmp/foo.tar",
        ArchiveType::Tar
    )
    .is_err());
}

#[test]
fn compress_cmd_escapes_special_chars_in_dirname() {
    // dirname with space and quote must be shell-escaped
    let cmd = build_compress_to_archive_cmd(
        "/home/user/my dir",
        "/tmp/out.tar.gz",
        ArchiveType::TarGz,
    )
    .unwrap();
    // 'my dir' is the escaped form of "my dir"
    assert!(cmd.contains("'my dir'"));
}
}
