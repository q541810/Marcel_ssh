use crate::error::AppError;

/// POSIX shell-escape a value: wrap in single quotes, escape embedded quotes.
/// Safe for `sh`, `bash`, `zsh`, `dash`.
pub(crate) fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Truncate a long string for inclusion in tool output. Adds a marker line
/// indicating the original size so the LLM can react appropriately.
pub(crate) fn truncate_output(s: String, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s;
    }
    // Find the closest valid char boundary <= max_bytes.
    let mut cut = max_bytes;
    while !s.is_char_boundary(cut) && cut > 0 {
        cut -= 1;
    }
    format!(
        "{}...\n[truncated to {} bytes; original {} bytes]",
        &s[..cut],
        cut,
        s.len()
    )
}

pub(crate) fn validate_sftp_remote_path(path: &str) -> Result<String, AppError> {
    if path.is_empty() {
        return Err(AppError::Ssh("路径不能为空".into()));
    }
    if !path.starts_with('/') {
        return Err(AppError::Ssh("必须使用绝对路径".into()));
    }
    if path.contains('\0') {
        return Err(AppError::Ssh("路径包含非法字符".into()));
    }
    for component in path.split('/') {
        if component == ".." {
            return Err(AppError::Ssh("不允许路径穿越 (..)".into()));
        }
    }
    let normalized = path.replace("//", "/");
    Ok(normalized)
}

pub(crate) fn validate_local_path(path: &str) -> Result<String, AppError> {
    if path.is_empty() {
        return Err(AppError::Ssh("路径不能为空".into()));
    }
    if path.contains('\0') {
        return Err(AppError::Ssh("路径包含非法字符".into()));
    }
    for component in path.split(['/', '\\']) {
        if component == ".." {
            return Err(AppError::Ssh("不允许路径穿越 (..)".into()));
        }
    }
    Ok(path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_escape_handles_quotes() {
        assert_eq!(shell_escape("foo"), "'foo'");
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
        assert_eq!(shell_escape("a b"), "'a b'");
    }

    #[test]
    fn truncate_output_respects_limit() {
        let s = "a".repeat(100);
        let out = truncate_output(s.clone(), 50);
        assert!(out.len() < 200);
        assert!(out.contains("truncated"));

        let short = "hello".to_string();
        assert_eq!(truncate_output(short.clone(), 100), short);
    }
}
