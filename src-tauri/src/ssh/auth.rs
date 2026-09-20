use serde::Deserialize;
use std::fmt;
use zeroize::Zeroize;

/// SSH authentication method.
///
/// Note: Only `Deserialize` is implemented (not `Serialize`) to prevent
/// passwords/passphrases from being accidentally sent back to the frontend.
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum AuthMethod {
    Password {
        password: String,
    },
    PrivateKey {
        /// 密钥库条目的 id（导入进来的私钥）。与 `key_path` 二选一，优先它。
        #[serde(default)]
        key_id: Option<String>,
        /// 私钥文件路径：老数据，以及"就想直接指向 ~/.ssh/id_rsa 这个活文件"的用法。
        /// 开头的 `~` 会被展开。
        #[serde(default)]
        key_path: Option<String>,
        passphrase: Option<String>,
    },
}

/// Runtime ProxyJump configuration (credentials included).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
}

impl fmt::Debug for JumpConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JumpConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("auth_method", &self.auth_method)
            .finish()
    }
}

impl fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthMethod::Password { .. } => f
                .debug_struct("AuthMethod::Password")
                .field("password", &"***")
                .finish_non_exhaustive(),
            AuthMethod::PrivateKey {
                key_id, key_path, ..
            } => f
                .debug_struct("AuthMethod::PrivateKey")
                .field("key_id", key_id)
                .field("key_path", key_path)
                .field("passphrase", &"***")
                .finish_non_exhaustive(),
        }
    }
}

impl Drop for AuthMethod {
    fn drop(&mut self) {
        match self {
            AuthMethod::Password { password } => {
                password.zeroize();
            }
            AuthMethod::PrivateKey {
                passphrase: Some(p),
                ..
            } => {
                p.zeroize();
            }
            _ => {}
        }
    }
}
