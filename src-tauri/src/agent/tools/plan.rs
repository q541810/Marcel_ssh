//! `create_plan` 和 `update_plan_item` — Agent 自主规划 todolist 工具。
//!
//! `create_plan`: LLM 调用此工具生成结构化的步骤计划。工具返回 JSON 格式的计划数据，
//! 由 `run_agent_loop` 负责创建 `AgentTaskPlan` 并存入 AppState、推送事件。
//!
//! `update_plan_item`: LLM 调用此工具更新单个步骤的状态。工具返回 JSON 格式的状态更新数据，
//! 由 `run_agent_loop` 负责更新 AppState 中的计划、推送事件。

use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

/// Key in tool output metadata that signals a plan was created.
pub const PLAN_CREATED_KEY: &str = "plan_created";

/// Key in tool output metadata that signals a plan item was updated.
pub const PLAN_ITEM_UPDATED_KEY: &str = "plan_item_updated";

// ───────────────────── create_plan ─────────────────────

pub struct CreatePlanTool;
impl CreatePlanTool {
    pub fn new() -> Self { Self }
}
impl Default for CreatePlanTool {
    fn default() -> Self { Self::new() }
}

#[async_trait]
impl AgentTool for CreatePlanTool {
    fn name(&self) -> &str { "create_plan" }

    fn description(&self) -> &str {
        "Create a structured step-by-step plan for a complex task. Call this \
         FIRST when the user's request involves multiple steps (e.g. 'deploy a \
         web app', 'set up a server'). The plan will be shown to the user as a \
         todolist for tracking progress."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {
                                "type": "string",
                                "description": "Short, action-oriented description of this step (e.g. 'Check server environment', 'Install dependencies')"
                            }
                        },
                        "required": ["title"]
                    },
                    "description": "List of plan steps, ordered by execution sequence"
                }
            },
            "required": ["items"]
        })
    }

    fn risk_level(&self) -> RiskLevel { RiskLevel::ReadOnly }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let items_array = params
            .get("items")
            .and_then(|v| v.as_array())
            .ok_or_else(|| AppError::Agent("create_plan: missing or invalid 'items' parameter".into()))?;

        if items_array.is_empty() {
            return Ok(ToolOutput::fail("create_plan", "计划不能为空，请至少提供一个步骤"));
        }

        if items_array.len() > 20 {
            return Ok(ToolOutput::fail("create_plan", "计划步骤过多（最多20步），请简化任务"));
        }

        // Build plan items array for metadata
        let mut plan_items = Vec::with_capacity(items_array.len());
        for (i, item_val) in items_array.iter().enumerate() {
            let title = item_val
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名步骤");
            plan_items.push(json!({
                "id": format!("item-{}", i),
                "title": title,
                "status": "pending",
                "error": null
            }));
        }

        let titles: Vec<&str> = plan_items.iter()
            .filter_map(|it| it.get("title").and_then(|v| v.as_str()))
            .collect();

        let summary = format!("创建计划 ({} 步)", items_array.len());
        let output = format!(
            "计划已创建:\n{}\n\n开始逐步执行。",
            titles
                .iter()
                .enumerate()
                .map(|(i, t)| format!("{}. {}", i + 1, t))
                .collect::<Vec<_>>()
                .join("\n")
        );

        Ok(ToolOutput::ok(summary, output).with_metadata(json!({
            PLAN_CREATED_KEY: true,
            "items": plan_items
        })))
    }
}

// ───────────────────── update_plan_item ─────────────────────

pub struct UpdatePlanItemTool;
impl UpdatePlanItemTool {
    pub fn new() -> Self { Self }
}
impl Default for UpdatePlanItemTool {
    fn default() -> Self { Self::new() }
}

#[async_trait]
impl AgentTool for UpdatePlanItemTool {
    fn name(&self) -> &str { "update_plan_item" }

    fn description(&self) -> &str {
        "Update the status of a single step in the current plan. Call this \
         after completing, failing, or deciding to skip a step. Valid statuses: \
         'completed', 'failed', 'skipped', 'in_progress'."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "item_id": {
                    "type": "string",
                    "description": "The ID of the step to update (e.g. 'item-0', 'item-1')"
                },
                "status": {
                    "type": "string",
                    "enum": ["completed", "failed", "skipped", "in_progress"],
                    "description": "New status for this step"
                },
                "error": {
                    "type": "string",
                    "description": "Error message (required when status is 'failed')"
                }
            },
            "required": ["item_id", "status"]
        })
    }

    fn risk_level(&self) -> RiskLevel { RiskLevel::ReadOnly }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let item_id = params
            .get("item_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("update_plan_item: missing 'item_id'".into()))?
            .to_string();

        let status = params
            .get("status")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("update_plan_item: missing 'status'".into()))?
            .to_string();

        let error = params.get("error").and_then(|v| v.as_str()).map(String::from);

        let label = match status.as_str() {
            "completed" => "已完成",
            "failed" => "已失败",
            "skipped" => "已跳过",
            "in_progress" => "进行中",
            other => {
                return Ok(ToolOutput::fail(
                    "update_plan_item",
                    format!("无效的状态值: {}", other),
                ));
            }
        };

        let output = format!("步骤 {} {}", item_id, label);

        Ok(ToolOutput::ok("update_plan_item", output).with_metadata(json!({
            PLAN_ITEM_UPDATED_KEY: true,
            "item_id": item_id,
            "status": status,
            "error": error
        })))
    }
}
