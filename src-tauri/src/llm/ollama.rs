use async_trait::async_trait;

use crate::error::AppError;
use crate::llm::provider::{LlmConfig, LlmMessage, LlmProvider, ToolDefinition};

/// Ollama local LLM provider.
pub struct OllamaProvider {
    config: LlmConfig,
    client: reqwest::Client,
}

impl OllamaProvider {
    pub fn new(config: LlmConfig) -> Self {
        Self {
            config,
            client: reqwest::Client::new(),
        }
    }

    /// Get the configured model name.
    pub fn model(&self) -> &str {
        &self.config.model
    }

    /// Get the base URL (defaults to local Ollama).
    pub fn base_url(&self) -> &str {
        self.config
            .base_url
            .as_deref()
            .unwrap_or("http://localhost:11434/api")
    }
}

#[async_trait]
impl LlmProvider for OllamaProvider {
    async fn send_message(
        &self,
        _messages: &[LlmMessage],
        _tools: &[ToolDefinition],
    ) -> Result<LlmMessage, AppError> {
        // Stub: real implementation will use self.client to call Ollama API
        let _ = &self.client;
        let _ = &self.config;
        Err(AppError::Llm(
            "Ollama provider not yet implemented".into(),
        ))
    }
}
