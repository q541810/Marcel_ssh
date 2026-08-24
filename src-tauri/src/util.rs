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
    let mut normalized = path.to_string();
    while normalized.contains("//") {
        normalized = normalized.replace("//", "/");
    }
    Ok(normalized)
}

pub(crate) fn validate_local_path(path: &str) -> Result<String, AppError> {
    if path.is_empty() {
        return Err(AppError::Ssh("路径不能为空".into()));
    }
    if path.contains('\0') {
        return Err(AppError::Ssh("路径包含非法字符".into()));
    }
    // Android SAF content:// URI：由系统文件选择器返回，实际访问经 ContentResolver
    // 按 fd 打开，无法拼接文件系统路径，".." 组件检查对其无意义且会误伤编码内容。
    if is_content_uri(path) {
        return Ok(path.to_string());
    }
    for component in path.split(['/', '\\']) {
        if component == ".." {
            return Err(AppError::Ssh("不允许路径穿越 (..)".into()));
        }
    }
    Ok(path.to_string())
}

/// Android SAF 返回的 content:// URI（文档选择器 / 保存对话框）。
pub(crate) fn is_content_uri(path: &str) -> bool {
    path.starts_with("content://")
}

/// 从 content:// URI 的最后一段推导兜底文件名（DISPLAY_NAME 查询失败时使用）。
/// 例：`content://...:documents/document/primary%3ADownload%2Ffoo.txt` → `foo.txt`。
pub(crate) fn content_uri_fallback_name(uri: &str) -> Option<String> {
    let last = uri.trim_end_matches('/').rsplit('/').next()?;
    let decoded = percent_decode_lossy(last);
    let name = decoded
        .rsplit(['/', ':'])
        .next()
        .unwrap_or(&decoded)
        .trim()
        .to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// 极简 percent 解码（无效编码序列原样保留），仅用于兜底文件名展示。
fn percent_decode_lossy(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let (Some(h), Some(l)) = (
                bytes.get(i + 1).and_then(|b| (*b as char).to_digit(16)),
                bytes.get(i + 2).and_then(|b| (*b as char).to_digit(16)),
            ) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Android：通过 ContentResolver 查询 content:// URI 的 DISPLAY_NAME。
/// 任何 JNI 失败都返回 None（调用方回退到 URI 段解析），不 panic、不留 pending exception。
#[cfg(target_os = "android")]
pub(crate) fn query_content_display_name(uri: &str) -> Option<String> {
    use jni::objects::{JObject, JString, JValue};
    use jni::JNIEnv;

    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.ok()?;
    let mut guard = vm.attach_current_thread().ok()?;
    let env: &mut JNIEnv = &mut guard;

    fn run(
        env: &mut jni::JNIEnv,
        context_ptr: *mut std::ffi::c_void,
        uri: &str,
    ) -> jni::errors::Result<Option<String>> {
        let context = unsafe { JObject::from_raw(context_ptr as jni::sys::jobject) };
        let resolver = env
            .call_method(
                &context,
                "getContentResolver",
                "()Landroid/content/ContentResolver;",
                &[],
            )?
            .l()?;
        let uri_str: JObject = env.new_string(uri)?.into();
        let uri_obj = env
            .call_static_method(
                "android/net/Uri",
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[JValue::Object(&uri_str)],
            )?
            .l()?;
        let col: JObject = env.new_string("_display_name")?.into();
        let projection = env.new_object_array(1, "java/lang/String", &col)?;
        let projection_obj: JObject = projection.into();
        let cursor = env
            .call_method(
                &resolver,
                "query",
                "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
                &[
                    JValue::Object(&uri_obj),
                    JValue::Object(&projection_obj),
                    JValue::Object(&JObject::null()),
                    JValue::Object(&JObject::null()),
                    JValue::Object(&JObject::null()),
                ],
            )?
            .l()?;
        if cursor.is_null() {
            return Ok(None);
        }

        let inner = read_display_name(env, &cursor, &col);
        // 内层失败时先清掉 pending exception，再关 cursor，避免 JNI 处于非法状态。
        if inner.is_err() {
            let _ = env.exception_clear();
        }
        let _ = env.call_method(&cursor, "close", "()V", &[]);
        inner
    }

    fn read_display_name(
        env: &mut jni::JNIEnv,
        cursor: &JObject,
        col: &JObject,
    ) -> jni::errors::Result<Option<String>> {
        let moved = env.call_method(cursor, "moveToFirst", "()Z", &[])?.z()?;
        if !moved {
            return Ok(None);
        }
        let idx = env
            .call_method(
                cursor,
                "getColumnIndex",
                "(Ljava/lang/String;)I",
                &[JValue::Object(col)],
            )?
            .i()?;
        if idx < 0 {
            return Ok(None);
        }
        let s = env
            .call_method(
                cursor,
                "getString",
                "(I)Ljava/lang/String;",
                &[JValue::Int(idx)],
            )?
            .l()?;
        if s.is_null() {
            return Ok(None);
        }
        let jstr = JString::from(s);
        let out: String = env.get_string(&jstr)?.into();
        Ok(Some(out))
    }

    match run(env, ctx.context(), uri) {
        Ok(name) => name
            .map(|n| n.replace(['/', '\\', '\0'], "_"))
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty() && n != "." && n != ".."),
        Err(_) => {
            let _ = env.exception_clear();
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ──────────── shell_escape / truncate_output (existing) ────────────

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

    #[test]
    fn truncate_output_non_ascii_boundary() {
        let s = "αααααααααα"; // 10 × 2-byte chars = 20 bytes
        let out = truncate_output(s.to_string(), 5);
        assert!(out.contains("truncated"));
        assert!(out.starts_with("αα"));
    }

    // ──────────── validate_sftp_remote_path ────────────

    #[test]
    fn validate_sftp_remote_path_accepts_valid_absolute() {
        assert_eq!(
            validate_sftp_remote_path("/home/user").unwrap(),
            "/home/user"
        );
        assert_eq!(validate_sftp_remote_path("/").unwrap(), "/");
        assert_eq!(
            validate_sftp_remote_path("/var/log/nginx").unwrap(),
            "/var/log/nginx"
        );
    }

    #[test]
    fn validate_sftp_remote_path_rejects_empty() {
        assert!(validate_sftp_remote_path("").is_err());
    }

    #[test]
    fn validate_sftp_remote_path_rejects_relative() {
        assert!(validate_sftp_remote_path("home/user").is_err());
        assert!(validate_sftp_remote_path("../etc").is_err());
    }

    #[test]
    fn validate_sftp_remote_path_rejects_parent_component() {
        assert!(validate_sftp_remote_path("/etc/../passwd").is_err());
        assert!(validate_sftp_remote_path("/../root").is_err());
    }

    #[test]
    fn validate_sftp_remote_path_rejects_null_byte() {
        assert!(validate_sftp_remote_path("/etc/passwd\0hidden").is_err());
    }

    #[test]
    fn validate_sftp_remote_path_normalizes_double_slash() {
        assert_eq!(
            validate_sftp_remote_path("//home//user//").unwrap(),
            "/home/user/"
        );
        assert_eq!(validate_sftp_remote_path("/a//b///c").unwrap(), "/a/b/c");
    }

    // ──────────── validate_local_path ────────────

    #[test]
    fn validate_local_path_accepts_valid() {
        assert!(validate_local_path("/home/user/file.txt").is_ok());
        assert!(validate_local_path("C:\\Users\\file.txt").is_ok());
        assert!(validate_local_path("./relative/path").is_ok());
    }

    #[test]
    fn validate_local_path_rejects_empty() {
        assert!(validate_local_path("").is_err());
    }

    #[test]
    fn validate_local_path_rejects_null_byte() {
        assert!(validate_local_path("/tmp/test\0secret").is_err());
    }

    #[test]
    fn validate_local_path_rejects_parent_unix() {
        assert!(validate_local_path("/etc/../passwd").is_err());
    }

    #[test]
    fn validate_local_path_rejects_parent_windows() {
        assert!(validate_local_path("C:\\Users\\..\\secret").is_err());
    }

    // ──────────── content:// URI ────────────

    #[test]
    fn validate_local_path_allows_content_uri() {
        // SAF URI 常见形态：document id 里带 %3A（:）与 %2F（/），不能被 ".." 检查误伤
        assert!(validate_local_path(
            "content://com.android.externalstorage.documents/document/primary%3ADownload%2Ffoo..txt"
        )
        .is_ok());
        assert!(validate_local_path("content://media/external/file/1234").is_ok());
    }

    #[test]
    fn validate_local_path_content_uri_still_rejects_null() {
        assert!(validate_local_path("content://media/external/file/12\034").is_err());
    }

    #[test]
    fn is_content_uri_detects_scheme() {
        assert!(is_content_uri("content://authority/doc/1"));
        assert!(!is_content_uri("/home/user/file"));
        assert!(!is_content_uri("C:\\Users\\file.txt"));
        assert!(!is_content_uri("contents/file"));
    }

    #[test]
    fn content_uri_fallback_name_decodes_last_segment() {
        assert_eq!(
            content_uri_fallback_name(
                "content://com.android.externalstorage.documents/document/primary%3ADownload%2Freport.pdf"
            ),
            Some("report.pdf".to_string())
        );
        assert_eq!(
            content_uri_fallback_name("content://media/external/file/1234"),
            Some("1234".to_string())
        );
        assert_eq!(
            content_uri_fallback_name("content://provider/document/msf%3A5678"),
            Some("5678".to_string())
        );
        assert_eq!(content_uri_fallback_name(""), None);
    }
}
