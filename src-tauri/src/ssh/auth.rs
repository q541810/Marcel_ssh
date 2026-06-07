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
        key_path: String,
        passphrase: Option<String>,
    },
}

impl fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthMethod::Password { .. } => f
                .debug_struct("AuthMethod::Password")
                .field("password", &"***")
                .finish_non_exhaustive(),
            AuthMethod::PrivateKey { key_path, .. } => f
                .debug_struct("AuthMethod::PrivateKey")
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
