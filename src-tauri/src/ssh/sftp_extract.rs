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
pub(crate) fn build_extract_to_dir_cmd(archive_path: &str, target_dir: &str, kind: ArchiveType) -> String {
    let dir = crate::util::shell_escape(target_dir);
    let arc = crate::util::shell_escape(archive_path);
    let extract = match kind {
        ArchiveType::Zip => format!("unzip -o -q {arc} -d {dir}"),
        ArchiveType::TarGz => format!("tar xzf {arc} -C {dir}"),
        ArchiveType::TarBz2 => format!("tar xjf {arc} -C {dir}"),
        ArchiveType::TarXz => format!("tar xJf {arc} -C {dir}"),
        ArchiveType::Tar => format!("tar xf {arc} -C {dir}"),
    };
    format!("mkdir -p {dir} && {extract} && echo OK || (exit 1)")
}

pub(crate) fn build_unzip_check_cmd() -> &'static str {
    "command -v unzip >/dev/null 2>&1 && echo OK || echo MISSING_UNZIP"
}

pub(crate) fn build_tar_check_cmd() -> &'static str {
    "command -v tar >/dev/null 2>&1 && echo OK || echo MISSING_TAR"
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
        assert!(cmd.contains("unzip -o -q"));
        assert!(cmd.contains("-d"));
    }
}
