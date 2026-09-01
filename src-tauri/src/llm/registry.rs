//! 多渠道多模型注册表（LLM Routing Core）。
//!
//! 架构定位：把原来「单渠道单模型」的 `LlmConfig` 提升为三层模型：
//!
//! - **渠道 (Channel)**：一个 OpenAI 兼容的服务接入点（OpenRouter / DeepSeek /
//!   硅基流动 / Ollama / OpenAI 官方等）。渠道持有 Base URL（必填）与 API Key
//!   （密钥链 per-channel 存储）。
//! - **模型 (ModelEntry)**：渠道下的一个具体模型。持有模型名、展示名、
//!   temperature、vision、上下文窗口（0 = 回落全局）、extra_body。
//! - **场景槽位 (ModelSlots)**：路由绑定——默认（主对话）、命令审核、
//!   上下文压缩摘要。槽位为空/失效时回落主模型。
//! - **网络与重试策略 (NetPolicy)**：全局共享，所有渠道与模型统一生效
//!   （重试次数、间隔、状态码条件、首字超时、超时自动重试）。
//!
//! `LlmConfig`（`llm/provider.rs`）保持为「解析后的单次请求可执行配置」，
//! `LlmManager` / `OpenAiProvider` 不感知渠道概念，避免重写整个请求链路。
//! 本模块负责：实体建模、解析（含 keychain 兜底）、保存前校验、旧配置迁移。
//!
//! 迁移策略（`migrate_legacy_settings`）：旧版单配置 `llmConfig` 在加载时
//! 无损转换为「默认渠道 + 单模型 + 槽位绑定」，API Key 从旧 keychain 条目
//! 搬入渠道条目；`modelApprovalModel` 字符串按模型名匹配迁移为审核槽位。
//! 迁移幂等：已存在渠道或字段已清空时不重复执行。

use serde::{Deserialize, Serialize};

use crate::config::keychain;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::llm::error::validate_retry_conditions;
use crate::llm::provider::{LlmConfig, ProviderType};

fn default_true() -> bool {
    true
}

fn default_temperature() -> f32 {
    0.1
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

/// 全局共享的网络与重试策略（所有渠道与模型统一生效）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NetPolicy {
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
    #[serde(default = "default_retry_delay")]
    pub retry_delay_secs: f32,
    #[serde(default = "default_retry_http_statuses")]
    pub retry_http_statuses: String,
    #[serde(default = "default_first_byte_timeout")]
    pub first_byte_timeout_secs: u64,
    #[serde(default = "default_retry_on_timeout")]
    pub retry_on_timeout: bool,
}

impl Default for NetPolicy {
    fn default() -> Self {
        Self {
            max_retries: default_max_retries(),
            retry_delay_secs: default_retry_delay(),
            retry_http_statuses: default_retry_http_statuses(),
            first_byte_timeout_secs: default_first_byte_timeout(),
            retry_on_timeout: default_retry_on_timeout(),
        }
    }
}

/// 一个 OpenAI 兼容的服务接入点（渠道）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelConfig {
    /// 稳定唯一 ID（uuid）。
    pub id: String,
    /// 展示名称，如「DeepSeek 官方」「硅基流动」。
    pub name: String,
    /// API Base URL，如 `https://api.deepseek.com/v1`。必填（拒绝空值）。
    pub base_url: String,
    /// API Key。**仅内存持有**，序列化被跳过（同 `LlmConfig.api_key`），
    /// 持久化走系统密钥链（account = `llm_channel_{id}`）。
    #[serde(skip_serializing, default)]
    pub api_key: String,
    /// 是否启用。禁用的渠道不可被任何槽位解析到。
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl Default for ChannelConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            enabled: true,
        }
    }
}

/// 渠道下的一个具体模型条目。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelEntry {
    /// 稳定唯一 ID（uuid）。
    pub id: String,
    /// 所属渠道 ID（外键 → `ChannelConfig.id`）。
    pub channel_id: String,
    /// 实际请求 API 时使用的模型名，如 `deepseek-ai/DeepSeek-V3`。
    pub model_name: String,
    /// 展示别名（可选）。空时 UI 用 `model_name` 展示。
    #[serde(default)]
    pub display_name: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    /// 是否支持图片输入（多模态）。
    #[serde(default)]
    pub vision: bool,
    /// 模型上下文窗口（tokens）。0 = 未设置，回落全局
    /// `agentModeSettings.contextWindow`（兼容旧数据语义）。
    #[serde(default)]
    pub context_window: u64,
    /// 该模型特有的请求体参数覆写（如 `thinking`、`top_p`）。与旧
    /// `LlmConfig.extra_body` 语义一致。
    #[serde(default)]
    pub extra_body: Option<serde_json::Value>,
}

impl Default for ModelEntry {
    fn default() -> Self {
        Self {
            id: String::new(),
            channel_id: String::new(),
            model_name: String::new(),
            display_name: String::new(),
            temperature: default_temperature(),
            vision: false,
            context_window: 0,
            extra_body: None,
        }
    }
}

/// 场景槽位：把「用途」绑定到具体模型。
///
/// 三个槽位均允许为空字符串：
/// - `default_model_id` 为空 → 解析时回落第一个模型（尽力可用）；
/// - 审核/摘要槽位为空 → 回落主模型（旧行为：审核复用主模型）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelSlots {
    /// 默认（主对话）模型。
    #[serde(default)]
    pub default_model_id: String,
    /// 命令审核模型（`enableModelCommandApproval` 开启时使用）。
    /// 空 = 跟随默认模型。
    #[serde(default)]
    pub model_approval_model_id: String,
    /// 上下文压缩摘要模型。空 = 跟随默认模型。
    #[serde(default)]
    pub summarizer_model_id: String,
}

/// 多渠道多模型注册表（AppSettings 内嵌，随设置持久化与同步）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LlmRegistry {
    #[serde(default)]
    pub channels: Vec<ChannelConfig>,
    #[serde(default)]
    pub models: Vec<ModelEntry>,
    #[serde(default)]
    pub slots: ModelSlots,
    /// 全局共享的网络与重试策略（所有渠道/模型统一生效）。
    #[serde(default)]
    pub net_policy: NetPolicy,
}

/// 解析完成的模型：可执行配置 + 路由元信息。
#[derive(Debug, Clone)]
pub struct ResolvedModel {
    /// 可直接交给 `LlmManager::new` 的可执行配置。
    pub config: LlmConfig,
    /// 有效上下文窗口：模型级覆写（>0）优先，否则 0（调用方回落全局设置）。
    pub context_window: u64,
    pub model_id: String,
    /// 展示标签（display_name 优先，否则 model_name）。
    pub display_label: String,
}

impl LlmRegistry {
    pub fn is_empty(&self) -> bool {
        self.channels.is_empty() && self.models.is_empty()
    }

    pub fn find_channel(&self, id: &str) -> Option<&ChannelConfig> {
        self.channels.iter().find(|c| c.id == id)
    }

    pub fn find_model(&self, id: &str) -> Option<&ModelEntry> {
        self.models.iter().find(|m| m.id == id)
    }

    pub fn model_label(&self, model: &ModelEntry) -> String {
        if model.display_name.trim().is_empty() {
            model.model_name.clone()
        } else {
            model.display_name.clone()
        }
    }

    /// 某渠道下的全部模型（保持注册顺序）。
    pub fn models_of_channel(&self, channel_id: &str) -> Vec<&ModelEntry> {
        self.models.iter().filter(|m| m.channel_id == channel_id).collect()
    }

    /// 主模型：槽位优先；槽位为空/失效时回落第一个模型（尽力可用）。
    /// 完全没有模型时返回 None。
    pub fn default_model(&self) -> Option<&ModelEntry> {
        if !self.slots.default_model_id.is_empty() {
            if let Some(m) = self.find_model(&self.slots.default_model_id) {
                return Some(m);
            }
            log::warn!(
                "默认模型槽位指向不存在的模型 ({})，回落第一个可用模型",
                self.slots.default_model_id
            );
        }
        self.models.first()
    }

    /// 解析主模型配置。
    pub fn resolve_default(&self) -> Result<ResolvedModel, AppError> {
        let model = self.default_model().ok_or_else(|| {
            AppError::Llm("尚未配置模型，请前往设置添加渠道与模型".into())
        })?;
        self.build_resolved(model)
    }

    /// 按模型 ID 解析配置。模型不存在/所属渠道异常时返回错误。
    pub fn resolve_model(&self, model_id: &str) -> Result<ResolvedModel, AppError> {
        let model = self.find_model(model_id).ok_or_else(|| {
            AppError::Llm(format!("模型不存在或已被删除：{}", model_id))
        })?;
        self.build_resolved(model)
    }

    /// 场景槽位解析：`slot_model_id` 为空或指向失效模型时回落主模型。
    /// 用于审核/摘要等辅助用途，失败也尽量不炸任务。
    pub fn resolve_slot(&self, slot_model_id: &str) -> Result<ResolvedModel, AppError> {
        let id = slot_model_id.trim();
        if id.is_empty() {
            return self.resolve_default();
        }
        match self.find_model(id) {
            Some(m) => self.build_resolved(m),
            None => {
                log::warn!(
                    "场景槽位指向不存在的模型 ({})，回落主模型",
                    id
                );
                self.resolve_default()
            }
        }
    }

    /// 子任务模型覆盖：按「模型 ID」或「模型名」匹配（父模型由 LLM 生成参数，
    /// 可能传名字）。匹配不到时回落主模型并告警，保持子任务可用。
    pub fn resolve_override(&self, id_or_name: &str) -> Result<ResolvedModel, AppError> {
        let found = self
            .find_model(id_or_name)
            .or_else(|| self.models.iter().find(|m| m.model_name == id_or_name));
        match found {
            Some(m) => self.build_resolved(m),
            None => {
                log::warn!(
                    "子任务模型覆盖未匹配到任何已配置模型 ({})，回落主模型",
                    id_or_name
                );
                self.resolve_default()
            }
        }
    }

    fn build_resolved(&self, model: &ModelEntry) -> Result<ResolvedModel, AppError> {
        let channel = self.find_channel(&model.channel_id).ok_or_else(|| {
            AppError::Llm(format!(
                "模型 \"{}\" 所属渠道不存在，请检查模型服务设置",
                self.model_label(model)
            ))
        })?;
        if !channel.enabled {
            return Err(AppError::Llm(format!(
                "渠道 \"{}\" 已禁用，无法使用其模型 \"{}\"",
                channel.name,
                self.model_label(model)
            )));
        }
        if channel.base_url.trim().is_empty() {
            return Err(AppError::Llm(format!(
                "渠道 \"{}\" 未配置 Base URL，请前往设置填写 OpenAI 兼容端点",
                channel.name
            )));
        }
        // API Key：内存（预热/迁移回填）优先，缺失时兜底读 keychain。
        let api_key = if !channel.api_key.is_empty() {
            channel.api_key.clone()
        } else {
            match keychain::get_llm_channel_key(&channel.id)? {
                Some(k) => k,
                None => {
                    return Err(AppError::Llm(format!(
                        "渠道 \"{}\" 尚未配置 API Key，请前往设置填写",
                        channel.name
                    )))
                }
            }
        };
        let config = LlmConfig {
            provider_type: ProviderType::OpenAI,
            api_key,
            model: model.model_name.clone(),
            base_url: Some(channel.base_url.trim().to_string()),
            temperature: model.temperature,
            // 网络与重试策略：全局共享（NetPolicy），所有渠道/模型统一生效
            max_retries: self.net_policy.max_retries,
            retry_delay_secs: self.net_policy.retry_delay_secs,
            retry_http_statuses: self.net_policy.retry_http_statuses.clone(),
            first_byte_timeout_secs: self.net_policy.first_byte_timeout_secs,
            retry_on_timeout: self.net_policy.retry_on_timeout,
            vision: model.vision,
            extra_body: model.extra_body.clone(),
        };
        Ok(ResolvedModel {
            config,
            context_window: model.context_window,
            model_id: model.id.clone(),
            display_label: self.model_label(model),
        })
    }

    /// 删除渠道（级联删除其模型；清理指向被删模型的槽位）。
    /// 返回被删除的模型 ID 列表，供调用方清理对应 keychain 条目。
    pub fn remove_channel(&mut self, channel_id: &str) -> Vec<String> {
        self.channels.retain(|c| c.id != channel_id);
        let removed_models: Vec<String> = self
            .models
            .iter()
            .filter(|m| m.channel_id == channel_id)
            .map(|m| m.id.clone())
            .collect();
        self.models.retain(|m| m.channel_id != channel_id);
        for id in &removed_models {
            self.clear_slot_references(id);
        }
        removed_models
    }

    /// 删除单个模型（清理指向它的槽位）。返回是否删除成功。
    pub fn remove_model(&mut self, model_id: &str) -> bool {
        let before = self.models.len();
        self.models.retain(|m| m.id != model_id);
        let removed = self.models.len() != before;
        if removed {
            self.clear_slot_references(model_id);
        }
        removed
    }

    fn clear_slot_references(&mut self, model_id: &str) {
        if self.slots.default_model_id == model_id {
            self.slots.default_model_id.clear();
        }
        if self.slots.model_approval_model_id == model_id {
            self.slots.model_approval_model_id.clear();
        }
        if self.slots.summarizer_model_id == model_id {
            self.slots.summarizer_model_id.clear();
        }
    }

    /// 保存前校验：渠道/模型字段合法、Base URL 必填且为 http(s)、引用完整、
    /// 槽位指向存在模型、全局网络策略参数合法。
    /// `config_save_settings` 在落盘前调用。
    pub fn validate(&self) -> Result<(), AppError> {
        for channel in &self.channels {
            if channel.id.trim().is_empty() {
                return Err(AppError::Config("渠道 ID 不能为空".into()));
            }
            if channel.name.trim().is_empty() {
                return Err(AppError::Config("渠道名称不能为空".into()));
            }
            let url = channel.base_url.trim();
            if url.is_empty() {
                return Err(AppError::Config(format!(
                    "渠道 \"{}\" 的 Base URL 不能为空，请填写 OpenAI 兼容端点",
                    channel.name
                )));
            }
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(AppError::Config(format!(
                    "渠道 \"{}\" 的 Base URL 须以 http:// 或 https:// 开头",
                    channel.name
                )));
            }
        }

        // 全局网络与重试策略校验
        if let Err(err) = validate_retry_conditions(&self.net_policy.retry_http_statuses) {
            return Err(AppError::Config(format!(
                "网络策略重试条件格式错误: {}",
                err
            )));
        }
        if self.net_policy.max_retries > 10 {
            return Err(AppError::Config(
                "网络策略最大重试次数须为 0-10 的整数".into(),
            ));
        }
        if !self.net_policy.retry_delay_secs.is_finite()
            || self.net_policy.retry_delay_secs < 1.0
            || self.net_policy.retry_delay_secs > 60.0
        {
            return Err(AppError::Config(
                "网络策略重试间隔须为 1-60 的有限数字".into(),
            ));
        }
        if self.net_policy.first_byte_timeout_secs < 20
            || self.net_policy.first_byte_timeout_secs > 250
        {
            return Err(AppError::Config(
                "网络策略首字超时须为 20-250 的整数".into(),
            ));
        }

        let channel_ids: std::collections::HashSet<&str> =
            self.channels.iter().map(|c| c.id.as_str()).collect();
        for model in &self.models {
            if model.id.trim().is_empty() {
                return Err(AppError::Config("模型 ID 不能为空".into()));
            }
            if model.model_name.trim().is_empty() {
                return Err(AppError::Config(
                    "模型名称不能为空（每个模型须填写 API 模型名）".into(),
                ));
            }
            if !channel_ids.contains(model.channel_id.as_str()) {
                return Err(AppError::Config(format!(
                    "模型 \"{}\" 所属渠道不存在，请先创建渠道或修正归属",
                    model.model_name
                )));
            }
        }

        for (label, slot_id) in [
            ("默认模型", &self.slots.default_model_id),
            ("命令审核模型", &self.slots.model_approval_model_id),
            ("上下文压缩模型", &self.slots.summarizer_model_id),
        ] {
            if !slot_id.is_empty() && self.find_model(slot_id).is_none() {
                return Err(AppError::Config(format!(
                    "{}槽位指向不存在的模型，请重新选择",
                    label
                )));
            }
        }
        Ok(())
    }
}

/// 旧版单配置 → 多渠道多模型 迁移。
///
/// 幂等；返回是否发生了任何改动。调用方在改动为 true 时应持久化。
/// 覆盖两个旧字段：
/// 1. `AppSettings.llm_config`（旧单配置）→ 渠道 + 模型 + 槽位；
/// 2. `AgentModeSettings.model_approval_model`（旧审核模型名字符串）→ 审核槽位。
///
/// API Key 处理：迁移出的渠道若内存 key 为空，从旧 keychain 条目
/// `llm_api_key` 搬运到渠道条目 `llm_channel_{id}` 并回填内存。
/// 旧 keychain 条目**保留**（兼容旧版回滚与旧版同步通道，惰性无害）。
pub fn migrate_legacy_settings(settings: &mut AppSettings) -> bool {
    let mut changed = false;
    let mut migrated_llm = false;

    // 1. 旧 llmConfig → 注册表（仅当尚无任何渠道，避免覆盖已有配置）
    if let Some(legacy) = settings.llm_config.take() {
        if settings.llm_registry.channels.is_empty() {
            let channel_id = uuid::Uuid::new_v4().to_string();
            let model_id = uuid::Uuid::new_v4().to_string();
            // 旧配置可能没有 base_url（空 = 当时默认 OpenAI 官方端点）；
            // 新约束 Base URL 必填，迁移时补上等价默认值，保持旧数据可用。
            let base_url = legacy
                .base_url
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
            // 旧重试策略搬入全局共享策略（本分支渠道必为空，直接采用旧值）
            let net = &mut settings.llm_registry.net_policy;
            net.max_retries = legacy.max_retries;
            net.retry_delay_secs = legacy.retry_delay_secs;
            net.retry_http_statuses = legacy.retry_http_statuses.clone();
            net.first_byte_timeout_secs = legacy.first_byte_timeout_secs;
            net.retry_on_timeout = legacy.retry_on_timeout;
            let channel = ChannelConfig {
                id: channel_id.clone(),
                name: "默认渠道".into(),
                base_url,
                api_key: legacy.api_key.clone(),
                enabled: true,
            };
            let model = ModelEntry {
                id: model_id.clone(),
                channel_id: channel_id.clone(),
                model_name: legacy.model.clone(),
                display_name: String::new(),
                temperature: legacy.temperature,
                vision: legacy.vision,
                context_window: 0,
                extra_body: legacy.extra_body.clone(),
            };
            settings.llm_registry.slots.default_model_id = model_id.clone();
            settings.llm_registry.channels.push(channel);
            settings.llm_registry.models.push(model);
            migrated_llm = true;
            log::info!(
                "旧版 LLM 单配置已迁移为「默认渠道 + {}」",
                legacy.model
            );
        } else {
            log::warn!(
                "检测到旧版 llmConfig 但已存在渠道配置，忽略旧配置（保持现有渠道）"
            );
        }
        changed = true;
    }

    // 2. 旧审核模型名字符串 → 审核槽位（按模型名匹配，匹配不到回落主模型）
    if !settings.agent_mode_settings.model_approval_model.is_empty() {
        let name = settings.agent_mode_settings.model_approval_model.clone();
        settings.agent_mode_settings.model_approval_model.clear();
        changed = true;
        if settings.llm_registry.slots.model_approval_model_id.is_empty() {
            match settings
                .llm_registry
                .models
                .iter()
                .find(|m| m.model_name == name)
            {
                Some(m) => {
                    settings.llm_registry.slots.model_approval_model_id = m.id.clone();
                    log::info!("旧命令审核模型 \"{}\" 已迁移为审核槽位", name);
                }
                None => log::warn!(
                    "旧命令审核模型 \"{}\" 未匹配到任何已配置模型，已回落主模型",
                    name
                ),
            }
        }
    }

    // 3. 渠道 API Key 搬运：仅当刚迁移出旧配置且内存 key 为空
    if migrated_llm && !settings.llm_registry.channels.is_empty() {
        let channel_id = settings.llm_registry.channels[0].id.clone();
        if settings.llm_registry.channels[0].api_key.is_empty() {
            if let Ok(Some(key)) = keychain::get_llm_api_key() {
                if keychain::save_llm_channel_key(&channel_id, &key).is_ok() {
                    settings.llm_registry.channels[0].api_key = key;
                    log::info!("已从旧 keychain 条目迁移 API Key 到渠道 {}", channel_id);
                }
            }
        }
    }

    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_registry() -> LlmRegistry {
        let mut r = LlmRegistry::default();
        r.channels.push(ChannelConfig {
            id: "ch-1".into(),
            name: "DeepSeek".into(),
            base_url: "https://api.deepseek.com/v1".into(),
            api_key: "sk-test".into(),
            enabled: true,
        });
        r.models.push(ModelEntry {
            id: "m-1".into(),
            channel_id: "ch-1".into(),
            model_name: "deepseek-chat".into(),
            display_name: "DeepSeek Chat".into(),
            vision: false,
            context_window: 0,
            extra_body: None,
            ..Default::default()
        });
        r.models.push(ModelEntry {
            id: "m-2".into(),
            channel_id: "ch-1".into(),
            model_name: "deepseek-reasoner".into(),
            display_name: "".into(),
            vision: false,
            context_window: 64000,
            extra_body: None,
            ..Default::default()
        });
        r.slots.default_model_id = "m-1".into();
        r
    }

    #[test]
    fn resolve_default_uses_slot() {
        let r = sample_registry();
        let resolved = r.resolve_default().unwrap();
        assert_eq!(resolved.config.model, "deepseek-chat");
        assert_eq!(resolved.config.api_key, "sk-test");
        assert_eq!(
            resolved.config.base_url.as_deref(),
            Some("https://api.deepseek.com/v1")
        );
        assert_eq!(resolved.display_label, "DeepSeek Chat");
    }

    #[test]
    fn resolve_model_by_id() {
        let r = sample_registry();
        let resolved = r.resolve_model("m-2").unwrap();
        assert_eq!(resolved.config.model, "deepseek-reasoner");
        assert_eq!(resolved.context_window, 64000);
        assert_eq!(resolved.display_label, "deepseek-reasoner"); // 无展示名回落模型名
    }

    #[test]
    fn resolve_override_matches_id_or_name() {
        let r = sample_registry();
        let by_id = r.resolve_override("m-2").unwrap();
        let by_name = r.resolve_override("deepseek-reasoner").unwrap();
        assert_eq!(by_id.config.model, "deepseek-reasoner");
        assert_eq!(by_name.config.model, "deepseek-reasoner");
        // 未匹配回落主模型
        let fallback = r.resolve_override("no-such-model").unwrap();
        assert_eq!(fallback.config.model, "deepseek-chat");
    }

    #[test]
    fn resolve_slot_empty_or_missing_falls_back_to_default() {
        let r = sample_registry();
        let empty = r.resolve_slot("").unwrap();
        assert_eq!(empty.config.model, "deepseek-chat");
        let missing = r.resolve_slot("ghost-id").unwrap();
        assert_eq!(missing.config.model, "deepseek-chat");
        let set = r.resolve_slot("m-2").unwrap();
        assert_eq!(set.config.model, "deepseek-reasoner");
    }

    #[test]
    fn default_model_falls_back_to_first_when_slot_empty() {
        let mut r = sample_registry();
        r.slots.default_model_id = "".into();
        let resolved = r.resolve_default().unwrap();
        assert_eq!(resolved.config.model, "deepseek-chat");
    }

    #[test]
    fn resolve_default_errors_when_no_models() {
        let r = LlmRegistry::default();
        assert!(r.resolve_default().is_err());
    }

    #[test]
    fn disabled_channel_errors() {
        let mut r = sample_registry();
        r.channels[0].enabled = false;
        assert!(r.resolve_default().is_err());
    }

    #[test]
    fn empty_base_url_errors() {
        let mut r = sample_registry();
        r.channels[0].base_url = "  ".into();
        assert!(r.resolve_default().is_err());
        assert!(r.validate().is_err());
    }

    #[test]
    fn net_policy_is_global_across_channels() {
        let mut r = sample_registry();
        r.net_policy.max_retries = 3;
        r.net_policy.retry_delay_secs = 2.0;
        r.net_policy.retry_http_statuses = "429, 500-599".into();
        r.net_policy.first_byte_timeout_secs = 120;
        r.net_policy.retry_on_timeout = false;
        let resolved = r.resolve_default().unwrap();
        assert_eq!(resolved.config.max_retries, 3);
        assert_eq!(resolved.config.retry_delay_secs, 2.0);
        assert_eq!(resolved.config.retry_http_statuses, "429, 500-599");
        assert_eq!(resolved.config.first_byte_timeout_secs, 120);
        assert!(!resolved.config.retry_on_timeout);
    }

    #[test]
    fn validate_rejects_empty_net_policy_values() {
        let mut r = sample_registry();
        r.net_policy.retry_http_statuses = "abc".into();
        assert!(r.validate().is_err());
        r.net_policy.retry_http_statuses = "429".into();
        r.net_policy.max_retries = 99;
        assert!(r.validate().is_err());
        r.net_policy.max_retries = 1;
        r.net_policy.first_byte_timeout_secs = 10;
        assert!(r.validate().is_err());
    }

    #[test]
    fn remove_channel_cascades_models_and_clears_slots() {
        let mut r = sample_registry();
        r.slots.model_approval_model_id = "m-2".into();
        r.slots.summarizer_model_id = "m-1".into();
        let removed = r.remove_channel("ch-1");
        assert_eq!(removed.len(), 2);
        assert!(r.channels.is_empty());
        assert!(r.models.is_empty());
        assert!(r.slots.default_model_id.is_empty());
        assert!(r.slots.model_approval_model_id.is_empty());
        assert!(r.slots.summarizer_model_id.is_empty());
    }

    #[test]
    fn remove_model_clears_slots() {
        let mut r = sample_registry();
        r.slots.model_approval_model_id = "m-1".into();
        assert!(r.remove_model("m-1"));
        assert!(r.slots.default_model_id.is_empty());
        assert!(r.slots.model_approval_model_id.is_empty());
        assert!(!r.remove_model("m-1"));
    }

    #[test]
    fn validate_rejects_bad_channel_url() {
        let mut r = sample_registry();
        r.channels[0].base_url = "ftp://x".into();
        assert!(r.validate().is_err());
    }

    #[test]
    fn validate_rejects_dangling_model_channel() {
        let mut r = sample_registry();
        r.models[0].channel_id = "ghost".into();
        assert!(r.validate().is_err());
    }

    #[test]
    fn validate_rejects_dangling_slot() {
        let mut r = sample_registry();
        r.slots.summarizer_model_id = "ghost".into();
        assert!(r.validate().is_err());
    }

    #[test]
    fn validate_ok_on_sample() {
        let r = sample_registry();
        assert!(r.validate().is_ok());
    }

    #[test]
    fn migration_converts_legacy_config() {
        let mut settings = AppSettings::default();
        let legacy = settings.llm_config.as_mut().unwrap();
        legacy.model = "gpt-4o".into();
        legacy.base_url = Some("https://api.openai.com/v1".into());
        legacy.api_key = "sk-legacy".into();
        legacy.vision = true;
        legacy.max_retries = 3;
        legacy.retry_delay_secs = 2.0;
        legacy.retry_http_statuses = "429".into();
        legacy.first_byte_timeout_secs = 120;
        legacy.retry_on_timeout = false;

        let changed = migrate_legacy_settings(&mut settings);
        assert!(changed);
        assert!(settings.llm_config.is_none());
        assert_eq!(settings.llm_registry.channels.len(), 1);
        assert_eq!(settings.llm_registry.models.len(), 1);
        assert_eq!(
            settings.llm_registry.models[0].model_name, "gpt-4o"
        );
        assert!(settings.llm_registry.models[0].vision);
        assert_eq!(settings.llm_registry.channels[0].api_key, "sk-legacy");
        assert_eq!(
            settings.llm_registry.slots.default_model_id,
            settings.llm_registry.models[0].id
        );
        // 旧重试策略搬入全局共享策略
        assert_eq!(settings.llm_registry.net_policy.max_retries, 3);
        assert_eq!(settings.llm_registry.net_policy.retry_delay_secs, 2.0);
        assert_eq!(
            settings.llm_registry.net_policy.retry_http_statuses, "429"
        );
        assert_eq!(settings.llm_registry.net_policy.first_byte_timeout_secs, 120);
        assert!(!settings.llm_registry.net_policy.retry_on_timeout);

        // 幂等：再跑一次不再变化
        let before = settings.clone();
        let changed_again = migrate_legacy_settings(&mut settings);
        assert!(!changed_again);
        assert_eq!(settings, before);
    }

    #[test]
    fn migration_fills_openai_endpoint_for_empty_base_url() {
        let mut settings = AppSettings::default();
        let legacy = settings.llm_config.as_mut().unwrap();
        legacy.model = "gpt-4o".into();
        legacy.base_url = None;
        legacy.api_key = "sk".into();

        migrate_legacy_settings(&mut settings);
        assert_eq!(
            settings.llm_registry.channels[0].base_url,
            "https://api.openai.com/v1"
        );
        // 迁移后 validate 通过（Base URL 必填约束被满足）
        assert!(settings.llm_registry.validate().is_ok());
    }

    #[test]
    fn migration_matches_approval_model_by_name() {
        let mut settings = AppSettings::default();
        let legacy = settings.llm_config.as_mut().unwrap();
        legacy.model = "main-model".into();
        legacy.api_key = "sk".into();
        settings.agent_mode_settings.model_approval_model = "main-model".into();

        let changed = migrate_legacy_settings(&mut settings);
        assert!(changed);
        assert_eq!(
            settings.llm_registry.slots.model_approval_model_id,
            settings.llm_registry.models[0].id
        );
        assert!(settings.agent_mode_settings.model_approval_model.is_empty());
    }

    #[test]
    fn migration_keeps_existing_registry_untouched() {
        let mut settings = AppSettings::default();
        settings.llm_registry = sample_registry();
        let mut legacy = LlmConfig::default();
        legacy.model = "intruder".into();
        settings.llm_config = Some(legacy);

        migrate_legacy_settings(&mut settings);
        // 已有渠道时旧配置被丢弃，注册表保持原样
        assert_eq!(settings.llm_registry.models.len(), 2);
        assert_eq!(settings.llm_registry.models[0].model_name, "deepseek-chat");
        assert!(settings.llm_config.is_none());
    }
}
