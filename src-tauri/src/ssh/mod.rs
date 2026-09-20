pub mod auth;
pub mod key_material;
pub mod key_store;
pub mod known_hosts;
pub(crate) mod sftp_extract;

mod client;
mod manager;
mod session;

pub mod connection {
    pub use super::manager::{ConnectionConfig, SessionInfo, SshManager, SshStatus};
    pub use super::session::SshConnection;
}
