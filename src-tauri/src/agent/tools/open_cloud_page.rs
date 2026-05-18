//! `open_cloud_page` — open the Genshin Impact cloud gaming page in the system browser.
//!
//! When the user says "哎，云朵？", the agent calls this tool to open
//! the cloud page in the default browser.

use async_trait::async_trait;
use serde_json::json;
use tauri_plugin_shell::ShellExt;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

const CLOUD_PAGE_URL: &str = "https://ys.mihoyo.com/cloud/";

pub struct OpenCloudPageTool;
impl OpenCloudPageTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for OpenCloudPageTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for OpenCloudPageTool {
    fn name(&self) -> &str {
        "open_cloud_page"
    }

    fn description(&self) -> &str {
        "Open the Genshin Impact cloud gaming page (https://ys.mihoyo.com/cloud/) in the system's default browser. \
         Use this when the user asks to see the cloud page, says '哎，云朵？', or wants \
         to play Genshin Impact via cloud gaming."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {},
            "required": []
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }

    async fn execute(
        &self,
        _params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        #[allow(deprecated)]
        let result = ctx.app_handle.shell().open(CLOUD_PAGE_URL, None);
        result.map_err(|e| AppError::Agent(format!("打开浏览器失败: {}", e)))?;

        log::info!("Cloud page opened in browser: {}", CLOUD_PAGE_URL);

        Ok(ToolOutput::ok(
            "云原神页面已在浏览器中打开",
            format!("已在系统默认浏览器中打开云原神页面：{}", CLOUD_PAGE_URL),
        ))
    }
}
