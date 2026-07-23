use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("SSH error: {0}")]
    Ssh(String),
    #[error("SFTP error (code {code}): {message}")]
    Sftp { message: String, code: u32 },
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
    #[error("Network error: {0}")]
    Network(String),
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
                    AppError::Sftp { .. } => "Sftp",
                    AppError::Agent(_) => "Agent",
                    AppError::Llm(_) => "Llm",
                    AppError::Config(_) => "Config",
                    AppError::Update(_) => "Update",
                    AppError::Network(_) => "Network",
                    AppError::Io(_) => "Io",
                    AppError::Serde(_) => "Serde",
                    AppError::HostKeyVerification(_) => "HostKeyVerification",
                    AppError::Other(_) => "Other",
                    AppError::HostKeyMismatch { .. } => unreachable!(),
                };
                m.serialize_entry("kind", kind)?;
                m.serialize_entry("message", &other.to_string())?;
                if let AppError::Sftp { code, .. } = other {
                    m.serialize_entry("data", &serde_json::json!({ "code": code }))?;
                }
            }
        }
        m.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialize_err(err: &AppError) -> serde_json::Value {
        serde_json::to_value(err).expect("serialization should succeed")
    }

    fn kind_of(v: &serde_json::Value) -> &str {
        v.get("kind").and_then(|k| k.as_str()).unwrap_or("")
    }

    fn message_of(v: &serde_json::Value) -> &str {
        v.get("message").and_then(|k| k.as_str()).unwrap_or("")
    }

    #[test]
    fn ssh_serializes_correctly() {
        let v = serialize_err(&AppError::Ssh("connection refused".into()));
        assert_eq!(kind_of(&v), "Ssh");
        assert!(message_of(&v).contains("connection refused"));
    }

    #[test]
    fn sftp_serializes_with_code() {
        let v = serialize_err(&AppError::Sftp {
            message: "no such file".into(),
            code: 2,
        });
        assert_eq!(kind_of(&v), "Sftp");
        assert_eq!(
            v.get("data")
                .and_then(|d| d.get("code"))
                .and_then(|c| c.as_u64()),
            Some(2)
        );
    }

    #[test]
    fn sftp_serializes_without_code_on_old_variants() {
        let v = serialize_err(&AppError::Llm("timeout".into()));
        assert_eq!(kind_of(&v), "Llm");
        assert!(v.get("data").is_none());
    }

    #[test]
    fn host_key_mismatch_serializes_full_data() {
        let v = serialize_err(&AppError::HostKeyMismatch {
            host: "example.com".into(),
            port: 22,
            stored_algorithm: "ssh-ed25519".into(),
            stored_fingerprint: "SHA256:abc".into(),
            presented_algorithm: "ssh-ed25519".into(),
            presented_fingerprint: "SHA256:def".into(),
        });
        assert_eq!(kind_of(&v), "HostKeyMismatch");
        let data = v.get("data").expect("HostKeyMismatch must have data");
        assert_eq!(
            data.get("host").and_then(|h| h.as_str()),
            Some("example.com")
        );
        assert_eq!(data.get("port").and_then(|p| p.as_u64()), Some(22));
        assert_eq!(
            data.get("storedAlgorithm").and_then(|s| s.as_str()),
            Some("ssh-ed25519")
        );
    }

    #[test]
    fn every_variant_serializes_with_kind() {
        let cases: Vec<(&str, AppError)> = vec![
            ("Agent", AppError::Agent("test".into())),
            ("Llm", AppError::Llm("test".into())),
            ("Config", AppError::Config("test".into())),
            (
                "Io",
                AppError::Io(std::io::Error::new(std::io::ErrorKind::Other, "test")),
            ),
            (
                "Serde",
                AppError::Serde(serde_json::from_str::<serde_json::Value>("invalid").unwrap_err()),
            ),
            ("Update", AppError::Update("test".into())),
            (
                "HostKeyVerification",
                AppError::HostKeyVerification("test".into()),
            ),
            ("Other", AppError::Other("test".into())),
        ];
        for (expected_kind, err) in cases {
            let v = serialize_err(&err);
            assert_eq!(
                kind_of(&v),
                expected_kind,
                "variant should serialize as kind={expected_kind}"
            );
            assert!(!message_of(&v).is_empty(), "message must not be empty");
        }
    }

    #[test]
    fn io_error_from_conversion() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let app_err: AppError = io_err.into();
        let v = serialize_err(&app_err);
        assert_eq!(kind_of(&v), "Io");
        assert!(message_of(&v).contains("denied"));
    }

    #[test]
    fn serde_error_from_conversion() {
        let json_err = serde_json::from_str::<i32>("not a number").unwrap_err();
        let app_err: AppError = json_err.into();
        let v = serialize_err(&app_err);
        assert_eq!(kind_of(&v), "Serde");
    }

    #[test]
    fn display_output_is_meaningful() {
        let err = AppError::Ssh("refused".into());
        assert!(err.to_string().contains("refused"));

        let err = AppError::Sftp {
            message: "no file".into(),
            code: 2,
        };
        let s = err.to_string();
        assert!(s.contains("no file"));
        assert!(s.contains("2"));
    }
}
