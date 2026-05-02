use serde::Deserialize;
use zeroize::Zeroize;

/// SSH authentication method.
///
/// Note: Only `Deserialize` is implemented (not `Serialize`) to prevent
/// passwords/passphrases from being accidentally sent back to the frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase")]
pub enum AuthMethod {
    Password { password: String },
    PrivateKey {
        key_path: String,
        passphrase: Option<String>,
    },
}

impl Drop for AuthMethod {
    fn drop(&mut self) {
        match self {
            AuthMethod::Password { password } => {
                password.zeroize();
            }
            AuthMethod::PrivateKey { passphrase: Some(p), .. } => {
                p.zeroize();
            }
            _ => {}
        }
    }
}
