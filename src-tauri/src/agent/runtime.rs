use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Agent operation mode — determines how much autonomy the agent has.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    /// Pure chat — AI only answers, never invokes tools or executes commands.
    Chat,
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
#[serde(rename_all = "lowercase")]
pub enum PlanItemStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Skipped,
}

/// A single step in the agent task plan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanItem {
    pub id: String,
    pub title: String,
    pub status: PlanItemStatus,
    pub error: Option<String>,
}

/// The agent task plan — a sequence of steps to fulfill a user request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTaskPlan {
    pub task_id: String,
    pub items: Vec<PlanItem>,
    pub current_index: usize,
}

/// Represents a single agent task — one user intent being fulfilled.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTask {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub mode: AgentMode,
    pub status: AgentStatus,
    pub has_plan: bool,
    pub created_at: DateTime<Utc>,
}

/// The agent runtime manages the execution of agent tasks.
pub struct AgentRuntime {
    pub task_id: String,
    pub session_id: String,
    pub status: AgentStatus,
}

impl AgentRuntime {
    pub fn new(task_id: String, session_id: String) -> Self {
        Self {
            task_id,
            session_id,
            status: AgentStatus::Idle,
        }
    }

    /// Start executing a task. In Phase 1 this will drive the LLM loop.
    pub fn start_task(&mut self) {
        self.status = AgentStatus::Planning;
        // Stub: real implementation will spawn a tokio task
        // that drives the plan-execute-observe loop.
    }

    /// Stop (cancel) the current task.
    pub fn stop_task(&mut self) {
        self.status = AgentStatus::Cancelled;
    }
}
