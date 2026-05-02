use crate::error::AppError;

/// Service name used in the system keychain. All entries for this app are scoped
/// under this service to avoid colliding with other apps.
const SERVICE: &str = "com.marcel.ssh";

/// Store a password in the system keychain, associated with `account` (e.g. connection id).
pub fn save_password(account: &str, password: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(SERVICE, account)
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    entry
        .set_password(password)
        .map_err(|e| AppError::Config(format!("保存密码到密钥链失败：{}", e)))?;
    Ok(())
}

/// Retrieve a password from the system keychain. Returns `Ok(None)` if not found.
pub fn get_password(account: &str) -> Result<Option<String>, AppError> {
    let entry = keyring::Entry::new(SERVICE, account)
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Config(format!("读取密钥链失败：{}", e))),
    }
}

/// Remove a password from the system keychain. Missing entries are treated as success.
pub fn delete_password(account: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(SERVICE, account)
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Config(format!("删除密钥链条目失败：{}", e))),
    }
}

/// Store the LLM API key in the system keychain.
pub fn save_llm_api_key(api_key: &str) -> Result<(), AppError> {
    let entry = keyring::Entry::new(SERVICE, "llm_api_key")
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    entry
        .set_password(api_key)
        .map_err(|e| AppError::Config(format!("保存 API Key 到密钥链失败：{}", e)))?;
    Ok(())
}

/// Retrieve the LLM API key from the system keychain. Returns `Ok(None)` if not found.
pub fn get_llm_api_key() -> Result<Option<String>, AppError> {
    let entry = keyring::Entry::new(SERVICE, "llm_api_key")
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Config(format!("读取密钥链失败：{}", e))),
    }
}

/// Remove the LLM API key from the system keychain.
pub fn delete_llm_api_key() -> Result<(), AppError> {
    let entry = keyring::Entry::new(SERVICE, "llm_api_key")
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Config(format!("删除密钥链条目失败：{}", e))),
    }
}
