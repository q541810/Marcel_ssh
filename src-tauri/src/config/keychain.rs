use crate::error::AppError;

/// Service name used in the system keychain. All entries for this app are scoped
/// under this service to avoid colliding with other apps.
const SERVICE: &str = "com.marcel.ssh";

// ── Android ──────────────────────────────────────────────────────────────────
// keyring v4 的 `v1` 便利模块只覆盖 macOS/Windows/Linux，Android 不在其中
// （v1.rs set_credential_store 对 Android 无分支，Entry::new 返回 NoDefaultStore）。
// 因此 Android 直接用 android-native-keyring-store（SharedPreferences + Android
// Keystore AES 加密，hardware-backed），通过 keyring-core 的 Entry API 操作。
// ndk-context 由 Tauri Android 在启动时初始化（util.rs 已在用 android_context()）。

#[cfg(target_os = "android")]
mod android_store {
    use std::sync::{Arc, OnceLock};

    use keyring_core::{api::CredentialStoreApi, Entry, Error, Result};

    /// 单例 store，避免每次 Entry::new 都重建 vault 连接。
    fn store() -> Result<&'static Arc<android_native_keyring_store::Store>> {
        static STORE: OnceLock<Result<Arc<android_native_keyring_store::Store>>> =
            OnceLock::new();
        STORE
            .get_or_init(android_native_keyring_store::Store::new)
            .as_ref()
            .map_err(|e| {
                Error::PlatformFailure(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("Android 密钥存储初始化失败：{e}"),
                )
                .into())
            })
    }

    pub fn entry(service: &str, user: &str) -> Result<Entry> {
        store()?.build(service, user, None)
    }

    /// 把 keyring-core 的 NoEntry 映射为 Ok(None)，其他错误原样冒泡。
    pub fn get_optional_password(entry: &Entry) -> Result<Option<String>> {
        match entry.get_password() {
            Ok(pw) => Ok(Some(pw)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// 删除条目，NoEntry 视为成功（与桌面端 delete_password 语义一致）。
    pub fn delete_if_exists(entry: &Entry) -> Result<()> {
        match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(target_os = "android")]
use android_store as store_impl;

// ── Desktop ──────────────────────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
mod desktop_store {
    use keyring::{Entry, Error, Result};

    pub fn entry(service: &str, user: &str) -> Result<Entry> {
        Entry::new(service, user)
    }

    pub fn get_optional_password(entry: &Entry) -> Result<Option<String>> {
        match entry.get_password() {
            Ok(pw) => Ok(Some(pw)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn delete_if_exists(entry: &Entry) -> Result<()> {
        match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(not(target_os = "android"))]
use desktop_store as store_impl;

/// Store a password in the system keychain, associated with `account` (e.g. connection id).
pub fn save_password(account: &str, password: &str) -> Result<(), AppError> {
    let entry = store_impl::entry(SERVICE, account)
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    entry
        .set_password(password)
        .map_err(|e| AppError::Config(format!("保存密码到密钥链失败：{}", e)))?;
    Ok(())
}

/// Retrieve a password from the system keychain. Returns `Ok(None)` if not found.
pub fn get_password(account: &str) -> Result<Option<String>, AppError> {
    let entry = store_impl::entry(SERVICE, account)
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    store_impl::get_optional_password(&entry)
        .map_err(|e| AppError::Config(format!("读取密钥链失败：{}", e)))
}

/// Remove a password from the system keychain. Missing entries are treated as success.
pub fn delete_password(account: &str) -> Result<(), AppError> {
    let entry = store_impl::entry(SERVICE, account)
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    store_impl::delete_if_exists(&entry)
        .map_err(|e| AppError::Config(format!("删除密钥链条目失败：{}", e)))
}

/// Store the LLM API key in the system keychain.
pub fn save_llm_api_key(api_key: &str) -> Result<(), AppError> {
    let entry = store_impl::entry(SERVICE, "llm_api_key")
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    entry
        .set_password(api_key)
        .map_err(|e| AppError::Config(format!("保存 API Key 到密钥链失败：{}", e)))?;
    Ok(())
}

/// Retrieve the LLM API key from the system keychain. Returns `Ok(None)` if not found.
pub fn get_llm_api_key() -> Result<Option<String>, AppError> {
    let entry = store_impl::entry(SERVICE, "llm_api_key")
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    store_impl::get_optional_password(&entry)
        .map_err(|e| AppError::Config(format!("读取密钥链失败：{}", e)))
}

/// Remove the LLM API key from the system keychain.
pub fn delete_llm_api_key() -> Result<(), AppError> {
    let entry = store_impl::entry(SERVICE, "llm_api_key")
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    store_impl::delete_if_exists(&entry)
        .map_err(|e| AppError::Config(format!("删除密钥链条目失败：{}", e)))
}

/// Store the web search API key in the system keychain.
pub fn save_web_search_api_key(api_key: &str) -> Result<(), AppError> {
    let entry = store_impl::entry(SERVICE, "web_search_api_key")
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    entry
        .set_password(api_key)
        .map_err(|e| AppError::Config(format!("保存搜索 API Key 到密钥链失败：{}", e)))?;
    Ok(())
}

/// Retrieve the web search API key. Returns `Ok(None)` if not found.
pub fn get_web_search_api_key() -> Result<Option<String>, AppError> {
    let entry = store_impl::entry(SERVICE, "web_search_api_key")
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    store_impl::get_optional_password(&entry)
        .map_err(|e| AppError::Config(format!("读取搜索 API Key 失败：{}", e)))
}

/// Remove the web search API key from the system keychain.
pub fn delete_web_search_api_key() -> Result<(), AppError> {
    let entry = store_impl::entry(SERVICE, "web_search_api_key")
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    store_impl::delete_if_exists(&entry)
        .map_err(|e| AppError::Config(format!("删除搜索 API Key 失败：{}", e)))
}

