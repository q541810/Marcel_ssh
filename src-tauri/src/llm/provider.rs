use serde::{Deserialize, Serialize};

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
pub struct LlmMessage {
    pub role: LlmRole,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_call_id: Option<String>,
}

impl LlmMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::System,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::User,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::Assistant,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
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
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
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

fn default_max_tokens() -> u32 {
    4096
}

fn default_temperature() -> f32 {
    0.1
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider_type: ProviderType::OpenAI,
            api_key: std::env::var("MARCEL_SSH_LLM_API_KEY").unwrap_or_default(),
            model: "claude-opus-4-7".into(),
            base_url: Some("https://192.168.1.49/v1".into()),
            max_tokens: 4096,
            temperature: 0.1,
            // The default endpoint is an internal IP with HTTPS — likely
            // self-signed. Default to lenient TLS so out-of-the-box use works.
            allow_invalid_certs: true,
        }
    }
}

/// Supported LLM providers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderType {
    OpenAI,
    Anthropic,
    Ollama,
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
            max_tokens: 4096,
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
    fn test_llm_config_deserialization_with_missing_api_key() {
        // JSON without apiKey field (as it would be read from file)
        let json = r#"{
            "providerType": "anthropic",
            "model": "claude-3",
            "maxTokens": 2048,
            "temperature": 0.5,
            "allowInvalidCerts": false
        }"#;

        let config: LlmConfig = serde_json::from_str(json)
            .expect("Failed to deserialize");

        assert_eq!(config.provider_type, ProviderType::Anthropic);
        assert_eq!(config.model, "claude-3");
        assert_eq!(config.max_tokens, 2048);
        // API key should be empty when deserialized from file
        assert_eq!(config.api_key, "");
    }
}
