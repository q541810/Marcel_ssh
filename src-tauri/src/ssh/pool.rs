/// Connection pool — currently a thin re-export of SshManager.
/// Will implement actual pooling (keepalive, reconnection, max connections) in Phase 2.
pub use super::connection::SshManager as ConnectionPool;
