//! Sync Key 在设备 keychain 的存储。
//!
//! 复用现有 keychain 模块（`crate::config::keychain`），account 名为 `sync_key`。
//! Sync Key 是 32 字节随机，base64 编码后走 `save_password`（现有 API 只支持字符串）。
//!
//! 跨平台：
//! - 桌面：Windows Credential Manager / macOS Keychain / Linux Secret Service
//! - Android：SharedPreferences + Android Keystore（hardware-backed AES）
//!   （v3 时代 keyring 在 Android 静默降级为内存 mock，v4 已修复）

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

use crate::error::AppError;
use crate::config::keychain;

/// keychain 中的 account 名
const SYNC_KEY_ACCOUNT: &str = "sync_key";

/// 设备 API Key 的 account 名（每个设备的 bearer token）
const DEVICE_API_KEY_ACCOUNT: &str = "sync_device_api_key";

/// 设备 ID 的 account 名
const DEVICE_ID_ACCOUNT: &str = "sync_device_id";

/// 服务器地址的 account 名
const SERVER_URL_ACCOUNT: &str = "sync_server_url";

/// 存储 Sync Key 到 keychain。
///
/// `sync_key` 会被 base64 编码后存储。调用方负责传入后 `zeroize` 原始数组。
pub fn save_sync_key(sync_key: &[u8; 32]) -> Result<(), AppError> {
    let encoded = BASE64.encode(sync_key);
    keychain::save_password(SYNC_KEY_ACCOUNT, &encoded)
}

/// 从 keychain 读取 Sync Key。
///
/// 返回的数组用完应 `zeroize`。
pub fn get_sync_key() -> Result<Option<[u8; 32]>, AppError> {
    let encoded = keychain::get_password(SYNC_KEY_ACCOUNT)?;
    match encoded {
        Some(s) => {
            let bytes = BASE64
                .decode(&s)
                .map_err(|e| AppError::Config(format!("Sync Key base64 解码失败：{}", e)))?;
            if bytes.len() != 32 {
                return Err(AppError::Config(format!(
                    "Sync Key 长度不正确：期望 32 字节，实际 {} 字节",
                    bytes.len()
                )));
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            Ok(Some(key))
        }
        None => Ok(None),
    }
}

/// 删除 Sync Key（账户重置时调用）。
pub fn delete_sync_key() -> Result<(), AppError> {
    keychain::delete_password(SYNC_KEY_ACCOUNT)
}

/// 存储设备 API Key（bearer token）。
pub fn save_device_api_key(api_key: &str) -> Result<(), AppError> {
    keychain::save_password(DEVICE_API_KEY_ACCOUNT, api_key)
}

/// 读取设备 API Key。
pub fn get_device_api_key() -> Result<Option<String>, AppError> {
    keychain::get_password(DEVICE_API_KEY_ACCOUNT)
}

/// 删除设备 API Key。
pub fn delete_device_api_key() -> Result<(), AppError> {
    keychain::delete_password(DEVICE_API_KEY_ACCOUNT)
}

/// 存储设备 ID。
pub fn save_device_id(device_id: &str) -> Result<(), AppError> {
    keychain::save_password(DEVICE_ID_ACCOUNT, device_id)
}

/// 读取设备 ID。
pub fn get_device_id() -> Result<Option<String>, AppError> {
    keychain::get_password(DEVICE_ID_ACCOUNT)
}

/// 删除设备 ID。
pub fn delete_device_id() -> Result<(), AppError> {
    keychain::delete_password(DEVICE_ID_ACCOUNT)
}

/// 存储服务器地址。
pub fn save_server_url(url: &str) -> Result<(), AppError> {
    keychain::save_password(SERVER_URL_ACCOUNT, url)
}

/// 读取服务器地址。
pub fn get_server_url() -> Result<Option<String>, AppError> {
    keychain::get_password(SERVER_URL_ACCOUNT)
}

/// 删除服务器地址。
pub fn delete_server_url() -> Result<(), AppError> {
    keychain::delete_password(SERVER_URL_ACCOUNT)
}

/// 清除所有同步相关凭证（账户重置 / 退出同步时调用）。
///
/// 按顺序删除，任一失败不阻塞后续删除。
pub fn clear_all_sync_credentials() -> Result<(), AppError> {
    let errors: Vec<String> = [
        delete_sync_key(),
        delete_device_api_key(),
        delete_device_id(),
        delete_server_url(),
    ]
    .iter()
    .filter_map(|r| r.as_ref().err().map(|e| e.to_string()))
    .collect();

    if errors.is_empty() {
        Ok(())
    } else {
        Err(AppError::Config(format!(
            "清除同步凭证时部分失败：{}",
            errors.join("; ")
        )))
    }
}

/// 确保 Sync Key 存在，不存在则生成并存储。
///
/// 用于首次设置流程。返回的数组用完应 `zeroize`。
pub fn ensure_sync_key() -> Result<[u8; 32], AppError> {
    if let Some(existing) = get_sync_key()? {
        return Ok(existing);
    }

    let sync_key = super::crypto::generate_sync_key();
    save_sync_key(&sync_key)?;
    Ok(sync_key)
}

/// 测试用的辅助函数：直接存储给定的 Sync Key 字节数组。
#[cfg(test)]
pub fn save_sync_key_bytes(bytes: &[u8; 32]) -> Result<(), AppError> {
    save_sync_key(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这个测试会真实操作 keychain，只在非 CI 环境手动跑
    #[test]
    fn test_save_and_get_sync_key() {
        let mut key = [0u8; 32];
        for (i, b) in key.iter_mut().enumerate() {
            *b = i as u8;
        }

        // 先清理可能的残留
        let _ = delete_sync_key();

        save_sync_key(&key).unwrap();
        let retrieved = get_sync_key().unwrap().expect("应该能读到");

        assert_eq!(key, retrieved);

        // 清理
        delete_sync_key().unwrap();
        assert!(get_sync_key().unwrap().is_none());
    }
}
