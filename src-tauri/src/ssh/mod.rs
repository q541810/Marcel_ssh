pub mod auth;
pub mod key_material;
pub mod key_store;
pub mod known_hosts;
pub(crate) mod sftp_extract;

mod client;
mod manager;
mod session;
// `session_unusable` 被跨设备同步的 SFTP 存储适配器复用（判断「会话本身坏了」只有这一份依据）。
pub(crate) mod sftp_shared;
#[cfg(test)]
pub(crate) mod sudo_test_support;
#[cfg(test)]
pub(crate) mod test_support;

pub mod connection {
    pub use super::manager::{ConnectionConfig, SessionInfo, SshManager, SshStatus};
    pub use super::session::SshConnection;
}
