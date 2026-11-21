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

/// token 估算的进程内 memo（`meter::estimate_message` 的首算结果存在这里，
/// 后续每轮的全量估算退化为求和）。`usize::MAX` = 未算。**消息内容被原地改写
/// 时必须回 MAX**（唯一的改写点是 `pruner::prune_messages`，经
/// `meter::invalidate_estimate` 重置）。跳过序列化：绝不进请求体、不落库。
#[derive(Debug)]
pub struct TokenMemo(pub std::sync::atomic::AtomicUsize);

impl Clone for TokenMemo {
    fn clone(&self) -> Self {
        Self(std::sync::atomic::AtomicUsize::new(
            self.0.load(std::sync::atomic::Ordering::Relaxed),
        ))
    }
}

impl Default for TokenMemo {
    /// 默认 = 未算（不能 derive：`AtomicUsize::default()` 是 0，会被当成已算的 0）。
    fn default() -> Self {
        Self(std::sync::atomic::AtomicUsize::new(Self::UNCOMPUTED))
    }
}

impl TokenMemo {
    /// 未算哨兵值。
    pub const UNCOMPUTED: usize = usize::MAX;

    #[inline]
    pub fn get(&self) -> Option<usize> {
        match self.0.load(std::sync::atomic::Ordering::Relaxed) {
            Self::UNCOMPUTED => None,
            v => Some(v),
        }
    }

    #[inline]
    pub fn set(&self, tokens: usize) {
        self.0.store(tokens, std::sync::atomic::Ordering::Relaxed);
    }

    #[inline]
    pub fn invalidate(&self) {
        self.0
            .store(Self::UNCOMPUTED, std::sync::atomic::Ordering::Relaxed);
    }
}

/// A message in the LLM conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmMessage {
    pub role: LlmRole,
    pub content: String,
    /// token 估算 memo（见 [`TokenMemo`]）。serde 跳过：Default 给未算哨兵。
    #[serde(skip, default)]
    pub estimate_cache: TokenMemo,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_call_id: Option<String>,
    /// Reasoning/thinking content from the model (DeepSeek thinking mode).
    /// Must be passed back to the API unchanged in subsequent requests.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reasoning_content: Option<String>,
    /// Relative paths under config `images/` for user-attached images.
    /// Serialized to multimodal content only when vision is enabled.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub image_paths: Option<Vec<String>>,
    /// Stream terminal reason from the provider (`stop` / `length` / `tool_calls`
    /// / `content_filter`). `None` when the provider does not report it.
    /// `length` means the response was truncated at the token cap.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub finish_reason: Option<String>,
    /// 持久化消息的 DB row id（`messages.id`，统一 id 域）：
    /// 历史消息来自后端快照投影保留的 `dbId`；运行中新增消息由
    /// `save_msg` 返回的 id 回填。压缩时被压区间末条的 id 作为 `tail_db_id`
    /// 指针交给前端/DB 定位卡片——取代一切位置数数与指纹验证。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub db_id: Option<String>,
    /// `db_id` 是否对前端 store 可见（前端消息有 `dbId`）：
    /// - history 入口（快照投影保留 dbId 的消息）→ `true`；
    /// - 运行中落库的消息：落库处**广播** `messageSaved` 的（回合锚点、
    ///   assistant 正文/工具轮、tool 结果）→ `true`——前端 live 消息由此对上
    ///   库内身份，单回合长任务的可压区间才有已知锚点；未广播的系统合成
    ///   注入（哑火补问、作业通知、计划提醒）→ `false`（前端 store 无此消息）。
    ///
    /// 自动 pressure 压缩按 `known_only` 收缩：区间末条必是前端能找到的消息，
    /// **live 降级路径实际不再触发**；overflow 强制压缩允许压运行中消息
    /// （恢复超长任务，降级作为救命场景的防御保留）。
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub db_id_known: bool,
    /// 这条用户消息的发送时刻。`Some` 时，发给模型的那一刻会在正文前补一行时间标记
    /// （见 [`LlmMessage::request_text`]），让模型知道现在几点、距上一条隔了多久。
    ///
    /// **只影响请求体，`content` 始终是原文**——它要落库、给界面显示、取会话标题、
    /// 进压缩摘要，都不该带标记。只有主 agent 的用户消息 / 作业告知会被设置
    /// （`manager::build_agent_messages` 按 audience 决定，子 agent 保持 `None`）。
    /// 取值来自落库的 `created_at`，所以同一条消息每一轮发出去的标记逐字节相同，
    /// 不会打断提示词缓存。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sent_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// 时间标记里的星期。
const WEEKDAYS_ZH: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/// 一行时间标记的 token 估算（`meter` 用；实际约 15~20 个 token）。
pub const SENT_AT_TAG_TOKENS: usize = 18;

/// 把发送时刻格式化成模型看的标记，形如 `[2026-11-12 周四 14:03 UTC+8]`。
/// 精确到分钟：够判断「刚才 / 昨天 / 上周」，又不会因为秒数制造无谓的 token。
pub fn format_sent_at_tag(at: chrono::DateTime<chrono::FixedOffset>) -> String {
    use chrono::{Datelike, Timelike};
    let offset_secs = at.offset().local_minus_utc();
    let tz = if offset_secs == 0 {
        "UTC".to_string()
    } else {
        let abs = offset_secs.abs();
        let (h, m) = (abs / 3600, abs % 3600 / 60);
        let sign = if offset_secs < 0 { '-' } else { '+' };
        if m == 0 {
            format!("UTC{sign}{h}")
        } else {
            format!("UTC{sign}{h}:{m:02}")
        }
    };
    format!(
        "[{:04}-{:02}-{:02} {} {:02}:{:02} {}]",
        at.year(),
        at.month(),
        at.day(),
        WEEKDAYS_ZH[at.weekday().num_days_from_monday() as usize],
        at.hour(),
        at.minute(),
        tz
    )
}

/// 按本机时区格式化（用户在哪个时区打字，标记就写哪个时区）。
pub fn local_sent_at_tag(at: chrono::DateTime<chrono::Utc>) -> String {
    let local = at.with_timezone(&chrono::Local);
    format_sent_at_tag(local.with_timezone(local.offset()))
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
            image_paths: None,
            finish_reason: None,
            db_id: None,
            db_id_known: false,
            estimate_cache: Default::default(),
            sent_at: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::User,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
            image_paths: None,
            finish_reason: None,
            db_id: None,
            db_id_known: false,
            estimate_cache: Default::default(),
            sent_at: None,
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: LlmRole::Assistant,
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
            image_paths: None,
            finish_reason: None,
            db_id: None,
            db_id_known: false,
            estimate_cache: Default::default(),
            sent_at: None,
        }
    }

    /// 发给模型的文本：`sent_at` 有值的用户消息在正文前补一行时间标记，其余原样。
    /// 请求体构建（`openai::build_request_content`）是唯一调用方——标记不进内存
    /// 里的 `content`，也就不会被落库或显示。
    pub fn request_text(&self) -> std::borrow::Cow<'_, str> {
        match (self.role == LlmRole::User, self.sent_at) {
            (true, Some(at)) => {
                let tag = local_sent_at_tag(at);
                if self.content.is_empty() {
                    std::borrow::Cow::Owned(tag)
                } else {
                    std::borrow::Cow::Owned(format!("{tag}\n{}", self.content))
                }
            }
            _ => std::borrow::Cow::Borrowed(&self.content),
        }
    }
}

/// Placeholder injected into text when an image is not sent as multimodal content.
pub const IMAGE_PLACEHOLDER: &str = "[image]";

/// Apply vision policy before sending to the provider:
/// - Vision OFF: never send images; append `[image]` placeholders.
/// - Vision ON: every image-bearing user message keeps its images.
///   Context compaction still works: the summarizer request runs through the same
///   body builder, so images inside a compacted region are visible to the summary
///   model before the region is replaced by a checkpoint.
pub fn apply_vision_policy(messages: &mut [LlmMessage], vision: bool) {
    if !vision {
        for msg in messages.iter_mut() {
            if let Some(paths) = msg.image_paths.take() {
                if !paths.is_empty() {
                    append_image_placeholders(&mut msg.content, paths.len());
                }
            }
        }
    }
}

fn append_image_placeholders(content: &mut String, count: usize) {
    if count == 0 {
        return;
    }
    let block = std::iter::repeat(IMAGE_PLACEHOLDER)
        .take(count)
        .collect::<Vec<_>>()
        .join(" ");
    if content.is_empty() {
        *content = block;
    } else if !content.contains(IMAGE_PLACEHOLDER) {
        content.push('\n');
        content.push_str(&block);
    }
}

/// Configuration for an LLM provider.
///
/// Note: `api_key` is excluded from serialization to prevent it from being
/// written to disk. It should be stored securely in the system keychain.
///
/// **采样温度刻意不在这里**：请求体默认不带 `temperature`，交给 provider /
/// 模型自己的默认值（未知 provider 不注入采样参数，与 ZCode 的做法一致）。
/// 需要固定温度时写在 `extra_body` 里（`{"temperature": 0.7}`），它合并进
/// 请求体顶层。旧配置残留的 `temperature` 键反序列化时被静默忽略。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    #[serde(default = "default_provider")]
    pub provider_type: ProviderType,
    #[serde(skip_serializing, default)]
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
    /// Maximum number of automatic retries on transient LLM errors (0 = no retry).
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
    /// Delay between retries in seconds.
    #[serde(default = "default_retry_delay")]
    pub retry_delay_secs: f32,
    /// Comma-separated HTTP status codes/ranges that should trigger a retry.
    /// Examples: "408, 429, 500-599"
    #[serde(default = "default_retry_http_statuses")]
    pub retry_http_statuses: String,
    /// 首字超时（秒）：从请求发出到收到首个 SSE 字节的空闲超时，20-250，默认 60。
    #[serde(default = "default_first_byte_timeout")]
    pub first_byte_timeout_secs: u64,
    /// 超时后是否自动重试（默认开启），复用 max_retries 预算。
    #[serde(default = "default_retry_on_timeout")]
    pub retry_on_timeout: bool,
    /// Whether the configured model accepts image inputs (multimodal / vision).
    #[serde(default)]
    pub vision: bool,
    /// Free-form JSON object merged into the outgoing chat completion request body.
    /// Use this to set provider-specific or otherwise-unexposed parameters
    /// (e.g. `thinking`, `top_p`, `max_tokens`, `seed`). Keys here override
    /// the typed fields above on conflict. Not used for model-approval calls.
    ///
    /// NOTE: 不加 `skip_serializing_if = "Option::is_none"`，保持序列化形状稳定，
    /// 旧设置 JSON 反序列化时 `null` 与 `None` 行为一致。
    #[serde(default)]
    pub extra_body: Option<serde_json::Value>,
    /// 「非首位系统消息转为普通消息」：开启后，构建请求体时把消息列表里
    /// **不在第一位**的 system 消息以 user 角色发送，并在内容前加一行声明
    /// （见 `openai::DEMOTED_SYSTEM_NOTICE`），供「系统消息必须位于开头」的
    /// 严格 chat template 后端（如按 Qwen 模板渲染的服务）使用。
    /// 只改发出去的形状；内存消息、落库、前端展示均不受影响。默认关。
    #[serde(default)]
    pub demote_non_leading_system: bool,
    /// 渠道自定义请求头（键值对）。用于 OpenCode Go 这类要求客户端指纹头的服务
    /// （如 `user-agent`、`x-opencode-session`），以及用户自建网关的自定义鉴权。
    ///
    /// **来源是密钥链**（account = `llm_channel_headers_{渠道 id}`），不落普通配置、
    /// 不进 WebView 明文回显——和 MCP 的 `SecretSlot::McpHeaders` 同一套理由：
    /// 这些头里经常带令牌。解析配置时由 `build_resolved` 读出来塞进来。
    #[serde(default)]
    pub extra_headers: std::collections::BTreeMap<String, String>,
}

fn default_provider() -> ProviderType {
    ProviderType::OpenAI
}

fn default_max_retries() -> u32 {
    1
}

fn default_retry_delay() -> f32 {
    5.0
}

fn default_retry_http_statuses() -> String {
    "408, 429, 500-599".into()
}

fn default_first_byte_timeout() -> u64 {
    60
}

fn default_retry_on_timeout() -> bool {
    true
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
            max_retries: 1,
            retry_delay_secs: 5.0,
            retry_http_statuses: "408, 429, 500-599".into(),
            first_byte_timeout_secs: 60,
            retry_on_timeout: true,
            vision: false,
            extra_body: None,
            demote_non_leading_system: false,
            extra_headers: Default::default(),
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

/// Token usage statistics returned by the LLM provider in its API response.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    /// Reasoning/thinking tokens (e.g. DeepSeek R1, OpenAI o-series)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reasoning_tokens: Option<u32>,
    /// Cache read tokens
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cached_read_tokens: Option<u32>,
}

impl TokenUsage {
    pub fn accumulate(&mut self, other: &TokenUsage) {
        self.prompt_tokens += other.prompt_tokens;
        self.completion_tokens += other.completion_tokens;
        self.total_tokens += other.total_tokens;
        if let Some(v) = other.reasoning_tokens {
            *self.reasoning_tokens.get_or_insert(0) += v;
        }
        if let Some(v) = other.cached_read_tokens {
            *self.cached_read_tokens.get_or_insert(0) += v;
        }
    }
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

    fn at(
        offset_secs: i32,
        y: i32,
        mo: u32,
        d: u32,
        h: u32,
        mi: u32,
    ) -> chrono::DateTime<chrono::FixedOffset> {
        use chrono::TimeZone;
        chrono::FixedOffset::east_opt(offset_secs)
            .unwrap()
            .with_ymd_and_hms(y, mo, d, h, mi, 30)
            .unwrap()
    }

    #[test]
    fn sent_at_tag_has_date_weekday_minute_and_offset() {
        // 2026-11-12 是周四；秒数不进标记。
        assert_eq!(
            format_sent_at_tag(at(8 * 3600, 2026, 11, 12, 14, 3)),
            "[2026-11-12 周四 14:03 UTC+8]"
        );
        assert_eq!(
            format_sent_at_tag(at(-(3 * 3600 + 1800), 2026, 11, 15, 9, 5)),
            "[2026-11-15 周日 09:05 UTC-3:30]"
        );
        assert_eq!(
            format_sent_at_tag(at(0, 2026, 11, 9, 0, 0)),
            "[2026-11-09 周一 00:00 UTC]"
        );
    }

    #[test]
    fn request_text_stamps_only_user_messages_with_sent_at() {
        use chrono::TimeZone;
        let when = chrono::Utc.with_ymd_and_hms(2026, 11, 12, 6, 3, 0).unwrap();
        let tag = local_sent_at_tag(when);

        let plain = LlmMessage::user("你好");
        assert_eq!(plain.request_text(), "你好", "没有 sent_at 不加标记");

        let mut stamped = LlmMessage::user("你好");
        stamped.sent_at = Some(when);
        assert_eq!(stamped.request_text(), format!("{tag}\n你好"));
        assert_eq!(
            stamped.content, "你好",
            "content 必须保持原文，标记只在请求里"
        );

        let mut image_only = LlmMessage::user("");
        image_only.sent_at = Some(when);
        assert_eq!(
            image_only.request_text(),
            tag,
            "空正文只发标记，不留多余换行"
        );

        let mut assistant = LlmMessage::assistant("好的");
        assistant.sent_at = Some(when);
        assert_eq!(assistant.request_text(), "好的", "非用户消息永远不加");
    }

    #[test]
    fn test_llm_config_serialization_excludes_api_key() {
        let config = LlmConfig {
            provider_type: ProviderType::OpenAI,
            api_key: "super-secret-key-12345".to_string(),
            model: "gpt-4".to_string(),
            base_url: Some("https://api.openai.com".to_string()),
            max_retries: 3,
            retry_delay_secs: 5.0,
            retry_http_statuses: "408, 429, 500-599".into(),
            first_byte_timeout_secs: 60,
            retry_on_timeout: true,
            vision: false,
            extra_body: None,
            demote_non_leading_system: false,
            extra_headers: Default::default(),
        };

        // Serialize to JSON
        let json = serde_json::to_string(&config).expect("Failed to serialize");

        // Verify API key is NOT in the JSON
        assert!(
            !json.contains("super-secret-key-12345"),
            "API key should not be serialized to JSON"
        );
        assert!(
            !json.contains("apiKey"),
            "apiKey field should not appear in JSON"
        );

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
            "temperature": 0.5
        }"#;

        let config: LlmConfig = serde_json::from_str(json).expect("Failed to deserialize");

        assert_eq!(config.provider_type, ProviderType::OpenAI);
        assert_eq!(config.model, "gpt-4");
        // API key should be empty when deserialized from file
        assert_eq!(config.api_key, "");
        // Retry fields get defaults when not present
        assert_eq!(config.max_retries, 1);
        assert!((config.retry_delay_secs - 5.0).abs() < f32::EPSILON);
        assert_eq!(config.retry_http_statuses, "408, 429, 500-599");
    }

    #[test]
    fn test_llm_config_default_no_hardcoded_secrets() {
        // Clear environment variables to test defaults
        std::env::remove_var("MARCEL_SSH_LLM_API_KEY");
        std::env::remove_var("MARCEL_SSH_LLM_BASE_URL");

        let config = LlmConfig::default();

        // Verify no hardcoded API key
        assert_eq!(
            config.api_key, "",
            "Default config should not have hardcoded API key"
        );

        // Verify no hardcoded internal IP addresses
        if let Some(ref base_url) = config.base_url {
            assert!(
                !base_url.contains("192.168."),
                "Default base_url should not contain hardcoded internal IP"
            );
            assert!(
                !base_url.contains("10."),
                "Default base_url should not contain hardcoded internal IP"
            );
            assert!(
                !base_url.contains("172.16."),
                "Default base_url should not contain hardcoded internal IP"
            );
        }

        // Model can have a safe default (not a secret)
        assert!(!config.model.is_empty(), "Model should have a value");
        assert!(!config.vision, "Default vision should be false");
    }

    #[test]
    fn apply_vision_policy_keeps_all_user_images_when_on() {
        let mut msgs: Vec<LlmMessage> = (0..7)
            .map(|i| {
                let mut m = LlmMessage::user(format!("u{i}"));
                m.image_paths = Some(vec![format!("c/m{i}_0.webp")]);
                m
            })
            .collect();
        // insert assistants between users so indices are sparse
        let mut full = Vec::new();
        for m in msgs.drain(..) {
            full.push(m);
            full.push(LlmMessage::assistant("ok"));
        }
        apply_vision_policy(&mut full, true);
        let users: Vec<_> = full.iter().filter(|m| m.role == LlmRole::User).collect();
        assert_eq!(users.len(), 7);
        for u in &users {
            assert!(
                u.image_paths.is_some(),
                "every image-bearing user keeps images when vision is on"
            );
        }
    }

    #[test]
    fn apply_vision_policy_strips_all_when_off() {
        let mut m = LlmMessage::user("see");
        m.image_paths = Some(vec!["c/a.webp".into()]);
        let mut msgs = vec![m];
        apply_vision_policy(&mut msgs, false);
        assert!(msgs[0].image_paths.is_none());
        assert!(msgs[0].content.contains(IMAGE_PLACEHOLDER));
    }

    #[test]
    fn test_llm_config_first_byte_timeout_default_when_missing() {
        let json = r#"{"providerType":"openai","model":"gpt-4"}"#;
        let cfg: LlmConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.first_byte_timeout_secs, 60);
        assert!(cfg.retry_on_timeout);
    }

    #[test]
    fn test_llm_config_extra_body_serialized_when_some() {
        let config = LlmConfig {
            provider_type: ProviderType::OpenAI,
            api_key: String::new(),
            model: "gpt-4".to_string(),
            base_url: None,
            max_retries: 1,
            retry_delay_secs: 5.0,
            retry_http_statuses: "408, 429, 500-599".into(),
            first_byte_timeout_secs: 60,
            retry_on_timeout: true,
            vision: false,
            extra_body: Some(serde_json::json!({ "thinking": { "type": "enabled" } })),
            demote_non_leading_system: false,
            extra_headers: Default::default(),
        };
        let json = serde_json::to_value(&config).expect("serialize");
        let extra = json
            .get("extraBody")
            .expect("extraBody should serialize when Some");
        assert_eq!(
            extra
                .get("thinking")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str()),
            Some("enabled")
        );
    }

    #[test]
    fn test_llm_config_extra_body_serialized_as_null_when_none() {
        // 不加 skip_serializing_if 是为了 sync 字段路径测试能读到默认值。
        // 验证：None 时序列化为 `extraBody: null`，前端按 null 处理（等同于未设置）。
        let config = LlmConfig {
            provider_type: ProviderType::OpenAI,
            api_key: String::new(),
            model: "gpt-4".to_string(),
            base_url: None,
            max_retries: 1,
            retry_delay_secs: 5.0,
            retry_http_statuses: "408, 429, 500-599".into(),
            first_byte_timeout_secs: 60,
            retry_on_timeout: true,
            vision: false,
            extra_body: None,
            demote_non_leading_system: false,
            extra_headers: Default::default(),
        };
        let json = serde_json::to_value(&config).expect("serialize");
        assert_eq!(
            json.get("extraBody").and_then(|v| v.as_null()),
            Some(()),
            "extraBody should be JSON null when None (sync path requires key present)"
        );
    }

    #[test]
    fn test_llm_config_extra_body_backward_compat() {
        // 旧 settings.json 没有 extraBody 字段 → 反序列化默认 None
        let json = r#"{
            "providerType": "openai",
            "model": "gpt-4",
            "temperature": 0.5
        }"#;
        let config: LlmConfig = serde_json::from_str(json).expect("deserialize");
        assert!(
            config.extra_body.is_none(),
            "missing extraBody should default to None"
        );
    }

    /// 旧的 `temperature` 键残留在 settings.json 里时不报错、也不复活：
    /// 字段已从结构体移除，反序列化静默忽略未知键，写盘后自然消失。
    #[test]
    fn legacy_temperature_key_is_ignored_not_resurrected() {
        let json = r#"{
            "providerType": "openai",
            "model": "gpt-4",
            "temperature": 0.7
        }"#;
        let config: LlmConfig = serde_json::from_str(json).expect("deserialize 旧配置不能失败");
        let re = serde_json::to_value(&config).expect("serialize");
        assert!(
            re.get("temperature").is_none(),
            "temperature 不应被重新序列化出来：{re}"
        );
        assert!(
            config.extra_body.is_none(),
            "旧 temperature 键不能被误当成 extra_body"
        );
    }
}
