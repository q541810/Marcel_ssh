use serde::{Deserialize, Serialize};

/// Types of SSH channels that can be opened.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ChannelType {
    Shell,
    Exec,
    Sftp,
}

/// Placeholder for SSH channel management.
/// Will be backed by russh channels in Phase 1.
#[derive(Debug)]
pub struct SshChannel {
    pub id: String,
    pub channel_type: ChannelType,
    pub session_id: String,
}

impl SshChannel {
    pub fn new(id: String, channel_type: ChannelType, session_id: String) -> Self {
        Self {
            id,
            channel_type,
            session_id,
        }
    }
}
