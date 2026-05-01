use async_trait::async_trait;

use crate::error::AppError;
use crate::llm::provider::{LlmConfig, LlmMessage, LlmProvider, ToolDefinition};

/// Anthropic Claude LLM provider.
pub struct AnthropicProvider {
    config: LlmConfig,
    client: reqwest::Client,
}

impl AnthropicProvider {
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

    /// Get the base URL (defaults to Anthropic's API).
    pub fn base_url(&self) -> &str {
        self.config
            .base_url
            .as_deref()
            .unwrap_or("https://api.anthropic.com/v1")
    }
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    async fn send_message(
        &self,
        _messages: &[LlmMessage],
        _tools: &[ToolDefinition],
    ) -> Result<LlmMessage, AppError> {
        // Stub: real implementation will use self.client to call Anthropic API
        let _ = &self.client;
        let _ = &self.config;
        Err(AppError::Llm(
            "Anthropic provider not yet implemented".into(),
        ))
    }
}
