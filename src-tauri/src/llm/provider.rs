use serde::{Deserialize, Serialize};

/// Environment variables for configuring LLM providers:
/// - `MARCEL_SSH_LLM_API_KEY`: API key for the LLM provider (required for production use)
/// - `MARCEL_SSH_LLM_MODEL`: Model name to use (default: "gpt-4")
/// - `MARCEL_SSH_LLM_BASE_URL`: Custom API endpoint (optional, uses provider default if not set)
/// - `MARCEL_SSH_LLM_ALLOW_INVALID_CERTS`: Allow self-signed certs ("true" or "1", default: false)
///
/// Security note: Never hardcode API keys in source code. Always use environment variables
/// or the system keychain for sensitive credentials.

/// Role of a message in the LLM conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LlmRole {
    System,
    User,
    Assistant,
    Tool,
}

/// A tool call requested by the LLM.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// A message in the LLM conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmMessage {
    pub role: LlmRole,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_call_id: Option<String>,
    /// Reasoning/thinking content from the model (DeepSeek thinking mode).
    /// Must be passed back to the API unchanged in subsequent requests.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reasoning_content: Option<String>,
}

impl LlmRole {
    pub fn to_string(&self) -> &'static str {
        match self {
            LlmRole::System => "system",
            LlmRole::User => "user",
            LlmRole::Assistant => "assistant",
            LlmRole::Tool => "tool",
        }
    }
}

impl LlmMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::System,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::User,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::Assistant,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
        }
    }
}

/// Configuration for an LLM provider.
/// 
/// Note: `api_key` is excluded from serialization to prevent it from being
/// written to disk. It should be stored securely in the system keychain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    #[serde(default = "default_provider")]
    pub provider_type: ProviderType,
    #[serde(skip_serializing, default)]
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    /// Allow self-signed / invalid TLS certificates. Useful for on-prem
    /// inference servers behind self-signed HTTPS endpoints.
    #[serde(default)]
    pub allow_invalid_certs: bool,
}

fn default_provider() -> ProviderType {
    ProviderType::OpenAI
}

fn default_temperature() -> f32 {
    0.1
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider_type: ProviderType::OpenAI,
            // API key must be provided via environment variable or keychain
            // Never hardcode API keys in source code
            api_key: std::env::var("MARCEL_SSH_LLM_API_KEY").unwrap_or_default(),
            // Default to gpt-4, but allow override via environment
            model: std::env::var("MARCEL_SSH_LLM_MODEL").unwrap_or_else(|_| "gpt-4".to_string()),
            // No default base URL - users must configure their own endpoint
            base_url: std::env::var("MARCEL_SSH_LLM_BASE_URL").ok(),
            temperature: 0.1,
            // Only allow invalid certs if explicitly set via environment variable
            // This is a security-sensitive setting that should not have a permissive default
            allow_invalid_certs: std::env::var("MARCEL_SSH_LLM_ALLOW_INVALID_CERTS")
                .map(|v| v == "true" || v == "1")
                .unwrap_or(false),
        }
    }
}

/// Supported LLM providers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderType {
    OpenAI,
}

/// Tool definition passed to the LLM for function calling.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Trait for LLM provider implementations.
#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    /// Send messages to the LLM and get a complete response.
    async fn send_message(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
    ) -> Result<LlmMessage, crate::error::AppError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_llm_config_serialization_excludes_api_key() {
        let config = LlmConfig {
            provider_type: ProviderType::OpenAI,
            api_key: "super-secret-key-12345".to_string(),
            model: "gpt-4".to_string(),
            base_url: Some("https://api.openai.com".to_string()),
            temperature: 0.7,
            allow_invalid_certs: false,
        };

        // Serialize to JSON
        let json = serde_json::to_string(&config).expect("Failed to serialize");

        // Verify API key is NOT in the JSON
        assert!(!json.contains("super-secret-key-12345"), 
            "API key should not be serialized to JSON");
        assert!(!json.contains("apiKey"), 
            "apiKey field should not appear in JSON");
        
        // Verify other fields ARE present
        assert!(json.contains("gpt-4"), "Model should be in JSON");
        assert!(json.contains("openai"), "Provider type should be in JSON");
        
        println!("Serialized JSON: {}", json);
    }

    #[test]
    fn test_llm_config_deserialization_with_openai() {
        // JSON without apiKey field (as it would be read from file)
        let json = r#"{
            "providerType": "openai",
            "model": "gpt-4",
            "temperature": 0.5,
            "allowInvalidCerts": false
        }"#;

        let config: LlmConfig = serde_json::from_str(json)
            .expect("Failed to deserialize");

        assert_eq!(config.provider_type, ProviderType::OpenAI);
        assert_eq!(config.model, "gpt-4");
        // API key should be empty when deserialized from file
        assert_eq!(config.api_key, "");
    }

    #[test]
    fn test_llm_config_default_no_hardcoded_secrets() {
        // Clear environment variables to test defaults
        std::env::remove_var("MARCEL_SSH_LLM_API_KEY");
        std::env::remove_var("MARCEL_SSH_LLM_BASE_URL");
        std::env::remove_var("MARCEL_SSH_LLM_ALLOW_INVALID_CERTS");

        let config = LlmConfig::default();

        // Verify no hardcoded API key
        assert_eq!(config.api_key, "", 
            "Default config should not have hardcoded API key");

        // Verify no hardcoded internal IP addresses
        if let Some(ref base_url) = config.base_url {
            assert!(!base_url.contains("192.168."),
                "Default base_url should not contain hardcoded internal IP");
            assert!(!base_url.contains("10."),
                "Default base_url should not contain hardcoded internal IP");
            assert!(!base_url.contains("172.16."),
                "Default base_url should not contain hardcoded internal IP");
        }

        // Verify allow_invalid_certs defaults to false (secure default)
        assert!(!config.allow_invalid_certs,
            "Default should not allow invalid certificates");

        // Model can have a safe default (not a secret)
        assert!(!config.model.is_empty(),
            "Model should have a value");
    }
}
