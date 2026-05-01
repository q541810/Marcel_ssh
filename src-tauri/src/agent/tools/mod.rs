pub mod execute_cmd;
pub mod file_ops;
pub mod search;
pub mod system;

use std::collections::HashMap;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::agent::context::SessionContext;
use crate::agent::sandbox::RiskLevel;
use crate::error::AppError;

/// Output from a tool execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutput {
    pub success: bool,
    pub output: String,
    pub metadata: Option<serde_json::Value>,
}

/// Summary information about a registered tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub risk_level: RiskLevel,
}

/// Trait that all agent tools must implement.
#[async_trait]
pub trait AgentTool: Send + Sync {
    /// Unique name used by the LLM to reference this tool.
    fn name(&self) -> &str;

    /// Human-readable description of what the tool does.
    fn description(&self) -> &str;

    /// JSON Schema describing the tool's parameters.
    fn parameters_schema(&self) -> serde_json::Value;

    /// Execute the tool with the given parameters and session context.
    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &SessionContext,
    ) -> Result<ToolOutput, AppError>;

    /// The risk level associated with this tool's operations.
    fn risk_level(&self) -> RiskLevel;
}

/// Registry that holds all available agent tools.
pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn AgentTool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// Register a new tool.
    pub fn register(&mut self, tool: Box<dyn AgentTool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    /// Get a tool by name.
    pub fn get(&self, name: &str) -> Option<&dyn AgentTool> {
        self.tools.get(name).map(|t| t.as_ref())
    }

    /// List summary info for all registered tools.
    pub fn list_tools(&self) -> Vec<ToolInfo> {
        self.tools
            .values()
            .map(|t| ToolInfo {
                name: t.name().to_string(),
                description: t.description().to_string(),
                risk_level: t.risk_level(),
            })
            .collect()
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}
