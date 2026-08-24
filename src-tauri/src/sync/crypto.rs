//! E2E 加密核心：HKDF 密钥派生、AES-GCM 加解密、Sync Key 生成。
//!
//! 信任链：
//!   配置码（32 位随机字符串，用户手抄保存）
//!     │  HKDF 派生
//!     ▼
//!   包装密钥（Wrapping Key，32 字节）
//!     │  AES-GCM 加密
//!     ▼
//!   encrypted_sync_key（存服务端，密文）
//!     │  AES-GCM 解密
//!     ▼
//!   Sync Key（256 位随机，存设备 keychain，真正加密数据的密钥）
//!
//! 安全：
//! - Sync Key 用完 `zeroize` 清零
//! - 配置码只在配对时短暂存在于内存，配对完即清零
//! - 服务端只看到密文 + 版本号，无法读取任何配置内容

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use zeroize::Zeroize;

use crate::error::AppError;

/// Sync Key 长度（字节），256 位
pub const SYNC_KEY_LEN: usize = 32;

/// AES-GCM nonce 长度（字节），12 字节是 GCM 标准推荐
const NONCE_LEN: usize = 12;

/// HKDF info：仅配置码（v1，兼容旧账户）
const WRAPPING_KEY_INFO_V1: &[u8] = b"marcel_ssh_sync_wrapping_key_v1";

/// HKDF info：配置码 + 账户密码（v2）
const WRAPPING_KEY_INFO_V2: &[u8] = b"marcel_ssh_sync_wrapping_key_v2";

/// HKDF salt，固定值（配置码本身已是高熵，salt 固定不影响安全性）
const HKDF_SALT: &[u8] = b"marcel_ssh_sync";

/// 新账户密码最小长度（字符，按 Unicode 标量计）
pub const MIN_ACCOUNT_PASSWORD_LEN: usize = 8;

/// 生成随机 Sync Key（256 位）。
///
/// 返回的数组用完应 `zeroize`，但调用方负责。
pub fn generate_sync_key() -> [u8; SYNC_KEY_LEN] {
    let mut key = [0u8; SYNC_KEY_LEN];
    OsRng.fill_bytes(&mut key);
    key
}

/// 从配置码派生包装密钥（v1：仅配置码，兼容旧账户）。
///
/// 配置码 → HKDF-SHA256 → 32 字节包装密钥
pub fn derive_wrapping_key(config_code: &str) -> [u8; SYNC_KEY_LEN] {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), config_code.as_bytes());
    let mut wrapping_key = [0u8; SYNC_KEY_LEN];
    hk.expand(WRAPPING_KEY_INFO_V1, &mut wrapping_key)
        .expect("HKDF expand 32 字节不会失败");
    wrapping_key
}

/// 从配置码 + 账户密码派生包装密钥（v2）。
///
/// IKM = config_code || 0x00 || password；info 与 v1 分离，避免与旧包装碰撞。
pub fn derive_wrapping_key_v2(config_code: &str, password: &str) -> [u8; SYNC_KEY_LEN] {
    let mut ikm = Vec::with_capacity(config_code.len() + 1 + password.len());
    ikm.extend_from_slice(config_code.as_bytes());
    ikm.push(0);
    ikm.extend_from_slice(password.as_bytes());
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), &ikm);
    ikm.zeroize();
    let mut wrapping_key = [0u8; SYNC_KEY_LEN];
    hk.expand(WRAPPING_KEY_INFO_V2, &mut wrapping_key)
        .expect("HKDF expand 32 字节不会失败");
    wrapping_key
}

/// 校验新账户密码（pair_first 强制）。
pub fn validate_account_password(password: &str) -> Result<(), AppError> {
    let len = password.chars().count();
    if len < MIN_ACCOUNT_PASSWORD_LEN {
        return Err(AppError::Config(format!(
            "账户密码至少 {} 位",
            MIN_ACCOUNT_PASSWORD_LEN
        )));
    }
    Ok(())
}

/// 解密 Sync Key：优先 v2（码+密码），失败再试 v1（仅码，兼容旧账户）。
///
/// 错误文案统一，不区分码错/密码错。
pub fn decrypt_sync_key_with_password(
    config_code: &str,
    password: &str,
    encrypted_sync_key: &str,
) -> Result<[u8; SYNC_KEY_LEN], AppError> {
    if !password.is_empty() {
        let wrapping_v2 = derive_wrapping_key_v2(config_code, password);
        if let Ok(key) = decrypt_sync_key(&wrapping_v2, encrypted_sync_key) {
            return Ok(key);
        }
    }
    // 旧账户：仅配置码包装；或密码错误时再试 v1（码对则成功）
    let wrapping_v1 = derive_wrapping_key(config_code);
    decrypt_sync_key(&wrapping_v1, encrypted_sync_key)
        .map_err(|_| AppError::Config("配置码或密码错误".into()))
}

/// 用包装密钥加密 Sync Key。
///
/// 输出格式：`base64(nonce(12) || ciphertext)`（ciphertext 已含 GCM tag）
pub fn encrypt_sync_key(
    wrapping_key: &[u8; SYNC_KEY_LEN],
    sync_key: &[u8; SYNC_KEY_LEN],
) -> Result<String, AppError> {
    let cipher = Aes256Gcm::new_from_slice(wrapping_key)
        .map_err(|e| AppError::Config(format!("AES 密钥初始化失败：{}", e)))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, sync_key.as_ref())
        .map_err(|e| AppError::Config(format!("AES-GCM 加密失败：{}", e)))?;

    // 拼接 nonce + ciphertext
    let mut combined = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);

    Ok(BASE64.encode(&combined))
}

/// 用包装密钥解密 Sync Key。
///
/// 输入格式：`base64(nonce(12) || ciphertext)`
pub fn decrypt_sync_key(
    wrapping_key: &[u8; SYNC_KEY_LEN],
    encrypted_sync_key: &str,
) -> Result<[u8; SYNC_KEY_LEN], AppError> {
    let cipher = Aes256Gcm::new_from_slice(wrapping_key)
        .map_err(|e| AppError::Config(format!("AES 密钥初始化失败：{}", e)))?;

    let combined = BASE64
        .decode(encrypted_sync_key)
        .map_err(|e| AppError::Config(format!("base64 解码失败：{}", e)))?;

    if combined.len() < NONCE_LEN {
        return Err(AppError::Config("encrypted_sync_key 长度不足".into()));
    }

    let (nonce_bytes, ciphertext) = combined.split_at(NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);

    let mut plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AppError::Config("AES-GCM 解密失败（配置码错误或数据损坏）".into()))?;

    if plaintext.len() != SYNC_KEY_LEN {
        plaintext.zeroize();
        return Err(AppError::Config("解密后的 Sync Key 长度不正确".into()));
    }

    let mut sync_key = [0u8; SYNC_KEY_LEN];
    sync_key.copy_from_slice(&plaintext);
    plaintext.zeroize();

    Ok(sync_key)
}

/// 用 Sync Key 加密任意数据（配置值、聊天记录等）。
///
/// 输出格式：`base64(nonce(12) || ciphertext)`
pub fn encrypt_data(sync_key: &[u8; SYNC_KEY_LEN], plaintext: &[u8]) -> Result<String, AppError> {
    let cipher = Aes256Gcm::new_from_slice(sync_key)
        .map_err(|e| AppError::Config(format!("AES 密钥初始化失败：{}", e)))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| AppError::Config(format!("AES-GCM 加密失败：{}", e)))?;

    let mut combined = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);

    Ok(BASE64.encode(&combined))
}

/// 用 Sync Key 解密数据。
///
/// 输入格式：`base64(nonce(12) || ciphertext)`
pub fn decrypt_data(sync_key: &[u8; SYNC_KEY_LEN], encrypted: &str) -> Result<Vec<u8>, AppError> {
    let cipher = Aes256Gcm::new_from_slice(sync_key)
        .map_err(|e| AppError::Config(format!("AES 密钥初始化失败：{}", e)))?;

    let combined = BASE64
        .decode(encrypted)
        .map_err(|e| AppError::Config(format!("base64 解码失败：{}", e)))?;

    if combined.len() < NONCE_LEN {
        return Err(AppError::Config("加密数据长度不足".into()));
    }

    let (nonce_bytes, ciphertext) = combined.split_at(NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| AppError::Config("AES-GCM 解密失败（Sync Key 错误或数据损坏）".into()))
}

/// 计算字符串的 SHA-256 hex 哈希（用于配置码 → account_id）。
pub fn sha256_hex(value: &str) -> String {
    use sha2::Digest;
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let result = hasher.finalize();
    // hex 编码
    let mut hex = String::with_capacity(64);
    for byte in result.iter() {
        hex.push_str(&format!("{:02x}", byte));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sync_key_encrypt_decrypt() {
        let config_code = "test_config_code_abc123";
        let wrapping_key = derive_wrapping_key(config_code);
        let sync_key = generate_sync_key();

        let encrypted = encrypt_sync_key(&wrapping_key, &sync_key).unwrap();
        let decrypted = decrypt_sync_key(&wrapping_key, &encrypted).unwrap();

        assert_eq!(sync_key, decrypted);
    }

    #[test]
    fn test_data_encrypt_decrypt() {
        let sync_key = generate_sync_key();
        let plaintext = b"hello sync world";

        let encrypted = encrypt_data(&sync_key, plaintext).unwrap();
        let decrypted = decrypt_data(&sync_key, &encrypted).unwrap();

        assert_eq!(plaintext.as_slice(), decrypted.as_slice());
    }

    #[test]
    fn test_decrypt_with_wrong_config_code() {
        let sync_key = generate_sync_key();

        let wrapping_key_1 = derive_wrapping_key("config_code_a");
        let encrypted = encrypt_sync_key(&wrapping_key_1, &sync_key).unwrap();

        let wrapping_key_2 = derive_wrapping_key("config_code_b");
        assert!(decrypt_sync_key(&wrapping_key_2, &encrypted).is_err());
    }

    #[test]
    fn test_sha256_hex() {
        let hash = sha256_hex("hello");
        assert_eq!(hash.len(), 64);
        // 同输入同输出
        assert_eq!(hash, sha256_hex("hello"));
        // 不同输入不同输出
        assert_ne!(hash, sha256_hex("world"));
    }

    #[test]
    fn test_wrapping_key_v2_deterministic() {
        let a = derive_wrapping_key_v2("code-aaa", "password1");
        let b = derive_wrapping_key_v2("code-aaa", "password1");
        assert_eq!(a, b);
    }

    #[test]
    fn test_wrapping_key_v2_differs_from_v1_and_wrong_password() {
        let code = "code-bbb";
        let v1 = derive_wrapping_key(code);
        let v2 = derive_wrapping_key_v2(code, "correct-pass");
        let v2_wrong = derive_wrapping_key_v2(code, "wrong-pass");
        assert_ne!(v1, v2);
        assert_ne!(v2, v2_wrong);
    }

    #[test]
    fn test_v2_encrypt_decrypt_and_dual_unwrap() {
        let code = "cfgcode_v2_test_xxxxxxxx"; // 长度不限，派生层任意 str
        let password = "my-secret-password";
        let sync_key = generate_sync_key();
        let wrapping = derive_wrapping_key_v2(code, password);
        let encrypted = encrypt_sync_key(&wrapping, &sync_key).unwrap();

        let opened = decrypt_sync_key_with_password(code, password, &encrypted).unwrap();
        assert_eq!(sync_key, opened);

        assert!(decrypt_sync_key_with_password(code, "bad-password", &encrypted).is_err());
    }

    #[test]
    fn test_v1_legacy_unwrap_with_empty_or_any_password() {
        let code = "legacy_config_code_only";
        let sync_key = generate_sync_key();
        let wrapping = derive_wrapping_key(code);
        let encrypted = encrypt_sync_key(&wrapping, &sync_key).unwrap();

        // 空密码：直接走 v1
        let opened = decrypt_sync_key_with_password(code, "", &encrypted).unwrap();
        assert_eq!(sync_key, opened);
        // 乱填密码：v2 失败后回退 v1 仍成功
        let opened2 = decrypt_sync_key_with_password(code, "ignored-for-v1", &encrypted).unwrap();
        assert_eq!(sync_key, opened2);
    }

    #[test]
    fn test_validate_account_password() {
        assert!(validate_account_password("short").is_err());
        assert!(validate_account_password("12345678").is_ok());
        assert!(validate_account_password("密码八个字刚好了").is_ok()); // 8 个字
    }
}
