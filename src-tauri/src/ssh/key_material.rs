//! 私钥来源解析：把"用户给的私钥"变成一段私钥文本，并在读不出时**说清是哪一种读不出**。
//!
//! 这里没有状态，全是纯函数，方便单测——因为判断"是否需要密码"必须对每一类私钥格式
//! 都准：前端据此决定要不要弹密码框，判错了就会重演旧行为（私钥文件根本不存在，却
//! 一直追问用户要密码）。
//!
//! 支持的格式由 russh（后接 ssh-key）决定：OpenSSH 私钥（含 bcrypt 加密）、PKCS#1
//! PEM、传统 PKCS#5 加密 PEM、PKCS#8（含加密）、PuTTY `.ppk`。

use std::path::PathBuf;

use russh::keys::{decode_secret_key, Error as KeyError, PrivateKey};

use crate::error::{AppError, KeyAuthCode};

/// 私钥都是几 KB 的文本。选了别的大文件要当场报错，别读进内存再慢慢解析。
pub const MAX_KEY_BYTES: usize = 1024 * 1024;

fn key_error(code: KeyAuthCode, message: impl Into<String>) -> AppError {
    AppError::KeyAuth {
        code,
        message: message.into(),
    }
}

/// 展开开头的 `~`、`~/`、`~\`。
///
/// 非做不可：输入框的占位符一直写着 `~/.ssh/id_rsa`，用户照抄下来就是必然失败——
/// russh 只认真实路径，从不展开，而且报的是底层 IO 错误，看不出是这里的问题。
pub fn expand_tilde(path: &str) -> PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
    }
    let rest = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"));
    match rest {
        Some(rest) => match dirs::home_dir() {
            Some(home) => home.join(rest),
            // 找不到家目录就原样返回，让下游报"文件不存在"，
            // 而不是悄悄指向某个猜出来的位置
            None => PathBuf::from(trimmed),
        },
        None => PathBuf::from(trimmed),
    }
}

/// 字节 → 私钥文本：去掉 UTF-8 BOM，非文本直接判定为"不是私钥"。
pub fn text_from_bytes(bytes: Vec<u8>) -> Result<String, AppError> {
    let bytes = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => rest.to_vec(),
        None => bytes,
    };
    String::from_utf8(bytes).map_err(|_| {
        key_error(
            KeyAuthCode::UnsupportedKey,
            "这个文件不是文本格式的私钥（私钥应为 OpenSSH、PEM、PKCS#8 或 PuTTY 文本）",
        )
    })
}

/// 读取私钥文件（支持 `~` 展开），失败时给出可操作的中文原因。
pub fn read_key_file(path: &str) -> Result<String, AppError> {
    let resolved = expand_tilde(path);
    let meta = std::fs::metadata(&resolved).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => key_error(
            KeyAuthCode::KeyNotFound,
            format!("私钥文件不存在：{}", resolved.display()),
        ),
        std::io::ErrorKind::PermissionDenied => key_error(
            KeyAuthCode::KeyUnreadable,
            format!("没有读取这个私钥文件的权限：{}", resolved.display()),
        ),
        _ => key_error(
            KeyAuthCode::KeyUnreadable,
            format!("读取私钥文件失败：{}（{}）", resolved.display(), e),
        ),
    })?;

    if meta.is_dir() {
        return Err(key_error(
            KeyAuthCode::KeyUnreadable,
            format!("{} 是一个目录，不是私钥文件", resolved.display()),
        ));
    }
    if meta.len() > MAX_KEY_BYTES as u64 {
        return Err(key_error(
            KeyAuthCode::UnsupportedKey,
            format!("这个文件有 {} MB，不像是私钥", meta.len() / 1_048_576),
        ));
    }

    let bytes = std::fs::read(&resolved).map_err(|e| {
        key_error(
            KeyAuthCode::KeyUnreadable,
            format!("读取私钥文件失败：{}（{}）", resolved.display(), e),
        )
    })?;
    text_from_bytes(bytes)
}

/// 私钥文本里是否有"这是加密私钥"的明示标记。
///
/// OpenSSH 格式的加密信息藏在 base64 里（只能解码后才知道，靠 `KeyIsEncrypted` 兜底），
/// 但 PKCS#8 加密、传统 PEM 的 `DEK-Info`、PuTTY 的 `Encryption` 行都是明文标记——
/// 而这三类在"没给密码"时解出来的错误各不相同，只能靠文本特征才能准确判定"缺密码"。
fn text_marks_encrypted(text: &str) -> bool {
    text.contains("BEGIN ENCRYPTED PRIVATE KEY")
        || text.contains("DEK-Info:")
        || (text.contains("PuTTY-User-Key-File-") && text.contains("Encryption: aes"))
}

/// 这把私钥自身是否带密码保护。对全部受支持的格式都成立：
/// 先看文本明示标记，再用"不给密码解一次"兜住 OpenSSH。
pub fn is_encrypted(text: &str) -> bool {
    text_marks_encrypted(text) || matches!(decode_secret_key(text, None), Err(KeyError::KeyIsEncrypted))
}

/// 解码私钥文本，失败时翻译成带原因码的结构化错误。
pub fn decode_pem(text: &str, passphrase: Option<&str>) -> Result<PrivateKey, AppError> {
    decode_secret_key(text, passphrase)
        .map_err(|e| classify_decode_failure(text, passphrase.is_some(), &e))
}

/// 解码失败 → 给用户的话 + 给前端的下一步判据。
fn classify_decode_failure(text: &str, passphrase_supplied: bool, err: &KeyError) -> AppError {
    // 先判"密码问题"：这类原因最容易被别的错误掩盖，而它恰恰是唯一该向用户追问的情况
    if is_encrypted(text) {
        return if passphrase_supplied {
            key_error(KeyAuthCode::BadPassphrase, "私钥密码不正确")
        } else {
            key_error(KeyAuthCode::NeedsPassphrase, "此私钥已加密，请输入私钥密码")
        };
    }

    match err {
        KeyError::UnsupportedKeyType { key_type_string, .. } => key_error(
            KeyAuthCode::UnsupportedKey,
            format!(
                "不支持这个私钥的类型（{}）。支持 OpenSSH、PEM、PKCS#8 与 PuTTY(.ppk) 私钥。",
                key_type_string
            ),
        ),
        KeyError::CouldNotReadKey | KeyError::Decode(_) => key_error(
            KeyAuthCode::UnsupportedKey,
            "这个文件不是可识别的私钥。支持 OpenSSH、PEM、PKCS#8 与 PuTTY(.ppk) 私钥。",
        ),
        KeyError::IO(e) if e.kind() == std::io::ErrorKind::NotFound => {
            key_error(KeyAuthCode::KeyNotFound, "私钥文件不存在或已被移动")
        }
        other => key_error(
            KeyAuthCode::KeyUnreadable,
            format!("私钥读取失败：{}", other),
        ),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 现场拼一把 ed25519 OpenSSH 私钥。**不用随机数**：ssh-key 的 `random()`
    /// 要求 rand_core 0.10 的 RNG，而这里引的 aes-gcm 用的是 rand_core 0.6，
    /// 两者 trait 不同源；`from_bytes` + `encrypt_with` 都是确定性的，测试反而更稳。
    /// `pub(crate)`：key_store 的单测也用它，避免两处各写一份造钥匙的代码。
    pub(crate) fn key_text(seed: u8, passphrase: Option<&str>) -> String {
        use russh::keys::ssh_key::private::{
            Ed25519Keypair, Ed25519PrivateKey, KeypairData,
        };
        use russh::keys::ssh_key::{Cipher, Kdf, LineEnding, PrivateKey};

        let private = Ed25519PrivateKey::from_bytes(&[seed; 32]);
        let key = PrivateKey::new(
            KeypairData::Ed25519(Ed25519Keypair {
                public: private.clone().into(),
                private,
            }),
            "test",
        )
        .expect("build ed25519 key");
        let key = match passphrase {
            Some(pw) => key
                .encrypt_with(
                    Cipher::Aes256Ctr,
                    Kdf::Bcrypt {
                        salt: vec![seed.wrapping_add(1); 16],
                        rounds: 16,
                    },
                    0x5A5A_5A5A,
                    pw,
                )
                .expect("encrypt"),
            None => key,
        };
        key.to_openssh(LineEnding::LF)
            .expect("encode")
            .to_string()
    }

    #[test]
    fn expand_tilde_handles_the_placeholder_we_advertise() {
        let home = dirs::home_dir().expect("test environment must have a home dir");
        assert_eq!(expand_tilde("~/.ssh/id_rsa"), home.join(".ssh/id_rsa"));
        assert_eq!(expand_tilde("~\\.ssh\\id_rsa"), home.join(".ssh\\id_rsa"));
        assert_eq!(expand_tilde("~"), home);
    }

    #[test]
    fn expand_tilde_leaves_ordinary_paths_alone() {
        // 绝对路径、相对路径、以及"波浪号不在开头"的情况都不能被动过
        assert_eq!(expand_tilde("/etc/ssh/key"), PathBuf::from("/etc/ssh/key"));
        assert_eq!(expand_tilde("keys/id_rsa"), PathBuf::from("keys/id_rsa"));
        assert_eq!(
            expand_tilde("C:\\Users\\me\\k"),
            PathBuf::from("C:\\Users\\me\\k")
        );
        assert_eq!(expand_tilde("a~b/c"), PathBuf::from("a~b/c"));
    }

    #[test]
    fn expand_tilde_trims_surrounding_whitespace() {
        let home = dirs::home_dir().expect("test environment must have a home dir");
        assert_eq!(expand_tilde("  ~/k  "), home.join("k"));
    }

    #[test]
    fn text_from_bytes_strips_bom_and_rejects_binary() {
        assert_eq!(
            text_from_bytes(vec![0xEF, 0xBB, 0xBF, b'a']).unwrap(),
            "a".to_string()
        );
        let err = text_from_bytes(vec![0xFF, 0xFE, 0x00]).unwrap_err();
        // 非文本文件要给"不是私钥"，而不是底层编码错误
        match err {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::UnsupportedKey),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn missing_file_reports_not_found_not_passphrase() {
        let err = read_key_file("/definitely/not/here/id_rsa").unwrap_err();
        match err {
            AppError::KeyAuth { code, message } => {
                assert_eq!(code, KeyAuthCode::KeyNotFound);
                assert!(message.contains("不存在"), "message was: {message}");
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn directory_is_rejected_without_panicking() {
        let err = read_key_file("/").unwrap_err();
        match err {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::KeyUnreadable),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn garbage_text_is_reported_as_unsupported_format() {
        let err = decode_pem("hello, this is not a key", None).unwrap_err();
        match err {
            AppError::KeyAuth { code, message } => {
                assert_eq!(code, KeyAuthCode::UnsupportedKey);
                assert!(
                    message.contains("不是可识别的私钥"),
                    "message was: {message}"
                );
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn encrypted_pkcs8_without_passphrase_asks_for_one() {
        // PKCS#8 加密私钥在"没给密码"时，解码器给的是通用错误，
        // 只有文本特征能识别出"缺密码"——这条就是防那个回归。
        let text =
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n";
        assert!(is_encrypted(text));
        let err = decode_pem(text, None).unwrap_err();
        match err {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::NeedsPassphrase),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn encrypted_key_with_wrong_passphrase_says_so() {
        let text =
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n";
        let err = decode_pem(text, Some("wrong")).unwrap_err();
        match err {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::BadPassphrase),
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn putty_encrypted_marker_is_detected() {
        let text = "PuTTY-User-Key-File-3: ssh-rsa\nEncryption: aes256-cbc\n";
        assert!(is_encrypted(text));
        // 未加密的 ppk 不该被误判成需要密码
        let plain = "PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none\n";
        assert!(!is_encrypted(plain));
    }

    #[test]
    fn plain_openssh_key_decodes_and_needs_no_passphrase() {
        let text = key_text(1, None);
        assert!(!is_encrypted(&text));
        assert!(decode_pem(&text, None).is_ok());
        // 未加密的密钥被塞了密码也不该变成"缺密码"
        assert!(decode_pem(&text, Some("whatever")).is_ok());
    }

    #[test]
    fn encrypted_openssh_key_classifies_passphrase_correctly() {
        let text = key_text(2, Some("s3cret"));
        assert!(is_encrypted(&text), "encrypted OpenSSH key must be detected");

        match decode_pem(&text, None).unwrap_err() {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::NeedsPassphrase),
            other => panic!("unexpected error: {other:?}"),
        }
        match decode_pem(&text, Some("wrong")).unwrap_err() {
            AppError::KeyAuth { code, .. } => assert_eq!(code, KeyAuthCode::BadPassphrase),
            other => panic!("unexpected error: {other:?}"),
        }
        assert!(decode_pem(&text, Some("s3cret")).is_ok());
    }

    #[test]
    fn encryption_does_not_change_the_key_identity() {
        // 加密不改变密钥身份：同一把密钥加密前后指纹必须一致，
        // 否则"按指纹去重"会把同一把钥匙存成两份
        let plain = key_text(3, None);
        let encrypted = key_text(3, Some("pw"));

        let plain_key = decode_pem(&plain, None).unwrap();
        let encrypted_key = decode_pem(&encrypted, Some("pw")).unwrap();
        assert_eq!(
            plain_key.fingerprint(russh::keys::HashAlg::Sha256),
            encrypted_key.fingerprint(russh::keys::HashAlg::Sha256)
        );
    }

    #[test]
    fn different_keys_have_different_fingerprints() {
        let a = decode_pem(&key_text(4, None), None).unwrap();
        let b = decode_pem(&key_text(5, None), None).unwrap();
        assert_ne!(
            a.fingerprint(russh::keys::HashAlg::Sha256),
            b.fingerprint(russh::keys::HashAlg::Sha256)
        );
    }
}
