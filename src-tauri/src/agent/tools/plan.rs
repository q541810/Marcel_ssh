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

/// Key in tool output metadata that signals a plan was edited (structure change).
pub const PLAN_EDITED_KEY: &str = "plan_edited";

// ───────────────────── create_plan ─────────────────────

pub struct CreatePlanTool;
impl CreatePlanTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for CreatePlanTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for CreatePlanTool {
    fn name(&self) -> &str {
        "create_plan"
    }

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

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let items_array = params
            .get("items")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                AppError::Agent("create_plan: missing or invalid 'items' parameter".into())
            })?;

        if items_array.is_empty() {
            return Ok(ToolOutput::fail(
                "create_plan",
                "计划不能为空，请至少提供一个步骤",
            ));
        }

        if items_array.len() > 20 {
            return Ok(ToolOutput::fail(
                "create_plan",
                "计划步骤过多（最多20步），请简化任务",
            ));
        }

        // Build plan items array for metadata.
        // id 用 1-based 数字字符串（"1", "2", ...），与用户在 PlanList UI 看到的
        // 编号一致，避免 LLM 看到 "item-0" 而用户看到 "1" 的歧义。
        let mut plan_items = Vec::with_capacity(items_array.len());
        for (i, item_val) in items_array.iter().enumerate() {
            let title = item_val
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名步骤");
            plan_items.push(json!({
                "id": format!("{}", i + 1),
                "title": title,
                "status": "pending",
                "error": null
            }));
        }

        let titles: Vec<&str> = plan_items
            .iter()
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
    pub fn new() -> Self {
        Self
    }
}
impl Default for UpdatePlanItemTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for UpdatePlanItemTool {
    fn name(&self) -> &str {
        "update_plan_item"
    }

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
                    "description": "The ID of the step to update (e.g. '1', '2', '3'). IDs are 1-based numbers matching the step number shown to the user."
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

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }

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

        let error = params
            .get("error")
            .and_then(|v| v.as_str())
            .map(String::from);

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

        Ok(
            ToolOutput::ok("update_plan_item", output).with_metadata(json!({
                PLAN_ITEM_UPDATED_KEY: true,
                "item_id": item_id,
                "status": status,
                "error": error
            })),
        )
    }
}

// ───────────────────── edit_plan ─────────────────────

pub struct EditPlanTool;
impl EditPlanTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for EditPlanTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for EditPlanTool {
    fn name(&self) -> &str {
        "edit_plan"
    }

    fn description(&self) -> &str {
        "Adjust the structure of the current plan (add / remove / rename items) \
         when the initial plan is found to be wrong after investigation. This is \
         a low-frequency fallback tool — for routine status updates, use \
         update_plan_item instead. Ops are applied in order; invalid ops are \
         skipped without aborting the batch."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "ops": {
                    "type": "array",
                    "description": "Batch of structural edits to apply in order",
                    "items": {
                        "type": "object",
                        "properties": {
                            "action": {
                                "type": "string",
                                "enum": ["add", "remove", "rename"],
                                "description": "Operation type"
                            },
                            "after_item_id": {
                                "type": "string",
                                "description": "Required for 'add': insert the new item immediately after this item id"
                            },
                            "title": {
                                "type": "string",
                                "description": "Required for 'add' and 'rename': new item title / new title"
                            },
                            "item_id": {
                                "type": "string",
                                "description": "Required for 'remove' and 'rename': target item id"
                            }
                        },
                        "required": ["action"]
                    }
                }
            },
            "required": ["ops"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let ops = params
            .get("ops")
            .and_then(|v| v.as_array())
            .ok_or_else(|| AppError::Agent("edit_plan: missing or invalid 'ops' parameter".into()))?;

        if ops.is_empty() {
            return Ok(ToolOutput::fail(
                "edit_plan",
                "ops 不能为空，请至少提供一个操作",
            ));
        }

        if ops.len() > 20 {
            return Ok(ToolOutput::fail(
                "edit_plan",
                "ops 过多（最多 20 个），请拆分调用",
            ));
        }

        // 参数校验：每个 op 的必填字段是否齐全
        for (i, op) in ops.iter().enumerate() {
            let action = op.get("action").and_then(|v| v.as_str()).unwrap_or("");
            match action {
                "add" => {
                    if op.get("after_item_id").and_then(|v| v.as_str()).is_none() {
                        return Ok(ToolOutput::fail(
                            "edit_plan",
                            format!("ops[{}]: 'add' 操作缺少必填字段 'after_item_id'", i),
                        ));
                    }
                    if op.get("title").and_then(|v| v.as_str()).is_none() {
                        return Ok(ToolOutput::fail(
                            "edit_plan",
                            format!("ops[{}]: 'add' 操作缺少必填字段 'title'", i),
                        ));
                    }
                }
                "remove" => {
                    if op.get("item_id").and_then(|v| v.as_str()).is_none() {
                        return Ok(ToolOutput::fail(
                            "edit_plan",
                            format!("ops[{}]: 'remove' 操作缺少必填字段 'item_id'", i),
                        ));
                    }
                }
                "rename" => {
                    if op.get("item_id").and_then(|v| v.as_str()).is_none() {
                        return Ok(ToolOutput::fail(
                            "edit_plan",
                            format!("ops[{}]: 'rename' 操作缺少必填字段 'item_id'", i),
                        ));
                    }
                    if op.get("title").and_then(|v| v.as_str()).is_none() {
                        return Ok(ToolOutput::fail(
                            "edit_plan",
                            format!("ops[{}]: 'rename' 操作缺少必填字段 'title'", i),
                        ));
                    }
                }
                other => {
                    return Ok(ToolOutput::fail(
                        "edit_plan",
                        format!("ops[{}]: 未知 action '{}'", i, other),
                    ));
                }
            }
        }

        let summary = format!("编辑计划 ({} 个操作)", ops.len());
        let output = format!("已应用 {} 个计划编辑操作", ops.len());

        Ok(ToolOutput::ok(summary, output).with_metadata(json!({
            PLAN_EDITED_KEY: true,
            "ops": ops
        })))
    }
}
