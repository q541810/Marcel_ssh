// 会话库的数据形状：错误、会话元数据、子对话条目、跨设备同步快照、聊天搜索结果。
// 消息行形状在 `messages.rs`，历史回读形状在 `history.rs`，用量形状在 `usage.rs`。
use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::messages::StoredMessage;
use super::usage::ConversationUsage;

#[derive(Debug, thiserror::Error)]
pub enum ConversationError {
    #[error("Failed to open database at '{path}': {source}")]
    OpenError {
        path: String,
        source: rusqlite::Error,
    },
    #[error("Failed to initialize database schema: {source}")]
    SchemaError { source: rusqlite::Error },
    #[error("Database operation failed: {message}")]
    OperationError {
        message: String,
        source: rusqlite::Error,
    },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub connection_id: String,
    pub title: String,
    pub created_at: chrono::DateTime<Utc>,
    pub updated_at: chrono::DateTime<Utc>,
    /// 子agent对话（subagent 工具创建）的父对话 id；主对话为 None。
    /// 用于：会话列表隐藏子对话、子对话内"返回主对话"、删除主对话级联删除。
    #[serde(default)]
    pub parent_conversation_id: Option<String>,
    /// 会话级模型选择：`llmRegistry` 中的模型条目 id。
    /// `None` = 跟随全局默认模型（未显式选择过 / 旧数据）。
    /// 启动任务时经 `agent_start_task` 的 `model_id` 传入，作为
    /// `AgentSpec.model_override` 解析；子 agent 默认继承父任务模型
    /// （候选清单配置后可被工具的 model 参数覆盖）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// 会话级思考强度（`reasoning_effort` 档位字符串，**内存 overlay**，
    /// 落盘由 `conversations.efforts_json` 承载（(model→effort) 映射，
    /// 启动时装载回内存 `session_efforts`））：`None` = 未设置，跟随模型
    /// 自身默认。此字段只表达「当前生效模型的档位」，持久化的是整张映射。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// 用户置顶：置顶的对话在列表里浮到最上方（日期分组之前），不受
    /// `updated_at` 影响。切换置顶**不动 `updated_at`**，否则取消置顶会把
    /// 对话的日期分组顺序搅乱（见 `set_conversation_pinned`）。
    #[serde(default)]
    pub pinned: bool,
    /// token 用量（落库在 `conversations.usage_json`，见 [`ConversationUsage`]）。
    ///
    /// 与 `reasoning_effort` 不同，这个字段**是**持久化数据（不是读时 overlay）；
    /// 只是整块为空（老会话 / 还没跑过）时不序列化，让前端能区分「没有数据」
    /// 与「用了 0 token」——前者显示 `—`，后者才是 0。
    #[serde(default, skip_serializing_if = "ConversationUsage::is_empty")]
    pub usage: ConversationUsage,
    /// **生效的上下文窗口**（tokens；`None` = 未配置）。
    ///
    /// 与其他字段都不同，这是**读时 overlay 派生值，不落库**（同
    /// `reasoning_effort`）：窗口由配置决定（模型级 `context_window` 优先，
    /// 否则全局 `agentModeSettings.contextWindow`），存下来会在用户改设置后
    /// 说谎——占用环的百分比会基于旧窗口算，而压缩阈值早已按新窗口执行。
    /// 由 `commands::agent_conversation` 的 overlay 函数在返回前填上。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

/// 子对话条目（主 agent 核对子代理过程时先看这个）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubConversationInfo {
    pub id: String,
    pub title: String,
    pub created_at: chrono::DateTime<Utc>,
    pub message_count: i64,
}

/// 会话完整快照（元数据 + 全部消息），用于跨设备同步。
/// 序列化后的 JSON 是 `conversations.{id}` key 对应的明文值。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationWithMessages {
    pub conversation: Conversation,
    pub messages: Vec<StoredMessage>,
}

/// 聊天历史全文搜索的单条会话聚合结果。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSearchResult {
    pub conversation_id: String,
    pub title: String,
    pub connection_id: String,
    pub matched_snippet: String,
    pub match_count: i64,
    /// 匹配消息 id，按时间升序，最多 200 条
    pub matched_message_ids: Vec<String>,
    pub updated_at: chrono::DateTime<Utc>,
}
