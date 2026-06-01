use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("SSH error: {0}")]
    Ssh(String),
    #[error("Agent error: {0}")]
    Agent(String),
    #[error("LLM error: {0}")]
    Llm(String),
    #[error("Config error: {0}")]
    Config(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error(
        "Host key mismatch for {host}:{port} (stored {stored_algorithm} {stored_fingerprint}, presented {presented_algorithm} {presented_fingerprint})"
    )]
    HostKeyMismatch {
        host: String,
        port: u16,
        stored_algorithm: String,
        stored_fingerprint: String,
        presented_algorithm: String,
        presented_fingerprint: String,
    },
    #[error("Host key verification failed: {0}")]
    HostKeyVerification(String),
    #[error("Update error: {0}")]
    Update(String),
    #[error("{0}")]
    Other(String),
}

// Tauri requires Serialize for command return errors. Errors are serialized as
// a structured object `{ kind, message, data? }` so the frontend can reliably
// branch on `kind` (e.g. to drive the host-key-mismatch confirmation flow)
// without resorting to string parsing.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut m = serializer.serialize_map(Some(3))?;
        match self {
            AppError::HostKeyMismatch {
                host,
                port,
                stored_algorithm,
                stored_fingerprint,
                presented_algorithm,
                presented_fingerprint,
            } => {
                m.serialize_entry("kind", "HostKeyMismatch")?;
                m.serialize_entry("message", &self.to_string())?;
                m.serialize_entry(
                    "data",
                    &serde_json::json!({
                        "host": host,
                        "port": port,
                        "storedAlgorithm": stored_algorithm,
                        "storedFingerprint": stored_fingerprint,
                        "presentedAlgorithm": presented_algorithm,
                        "presentedFingerprint": presented_fingerprint,
                    }),
                )?;
            }
            other => {
                let kind = match other {
                    AppError::Ssh(_) => "Ssh",
                    AppError::Agent(_) => "Agent",
                    AppError::Llm(_) => "Llm",
                    AppError::Config(_) => "Config",
                    AppError::Update(_) => "Update",
                    AppError::Io(_) => "Io",
                    AppError::Serde(_) => "Serde",
                    AppError::HostKeyVerification(_) => "HostKeyVerification",
                    AppError::Other(_) => "Other",
                    AppError::HostKeyMismatch { .. } => unreachable!(),
                };
                m.serialize_entry("kind", kind)?;
                m.serialize_entry("message", &other.to_string())?;
            }
        }
        m.end()
    }
}
