use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Agent operation mode — determines how much autonomy the agent has.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    /// Plan mode — AI may invoke a limited set of read-oriented tools
    /// (read_file, list_directory, search_files, system_info, connection_info,
    /// execute_command, ask_user, web_search, http_get, skills) to research
    /// and plan. No write/edit/create tools. Plugin and MCP tools are not
    /// registered. Command execution is gated by allow/deny lists.
    Plan,
    /// AI may invoke tools; command execution is gated by allow/deny lists
    /// configured in `AgentSettings`.
    Agent,
    /// Fully autonomous — AI executes all tool calls without confirmation.
    Auto,
}

/// Current status of the agent runtime.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AgentStatus {
    Idle,
    Planning,
    Executing,
    WaitingApproval,
    Completed,
    Failed,
    Cancelled,
}

/// Status of an individual item in the agent task plan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PlanItemStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Skipped,
}

/// A single step in the agent task plan.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub title: String,
    pub status: PlanItemStatus,
    pub error: Option<String>,
}

/// The agent task plan — a sequence of steps to fulfill a user request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskPlan {
    pub task_id: String,
    pub items: Vec<PlanItem>,
    pub current_index: usize,
    /// 下一个新增 item 的序号，用于生成 `item-{seq}` id。
    /// 删除 item 时不复用旧 id，避免 id 漂移导致 LLM 混淆。
    pub next_item_seq: usize,
    /// 反思提醒是否已触发过一次。
    /// 第一次把所有 item 标记为终态时，会回滚状态并提醒 LLM 反思。
    /// LLM 再次调用 update_plan_item 把最后一个 item 标记为终态时，不再拦截。
    pub reflection_reminded: bool,
}

/// Represents a single agent task — one user intent being fulfilled.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTask {
    pub id: String,
    pub session_id: String,
    pub conversation_id: String,
    pub prompt: String,
    pub mode: AgentMode,
    pub status: AgentStatus,
    pub has_plan: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
