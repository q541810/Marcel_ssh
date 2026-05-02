//! `system_info` — gather OS / uptime / memory / disk / network info.
//!
//! Categories are independent and composable. `category='all'` returns a
//! labeled concatenation suitable for feeding straight back to the LLM.

use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

const MAX_OUTPUT_BYTES: usize = 10_000;

pub struct SystemInfoTool;
impl SystemInfoTool { pub fn new() -> Self { Self } }
impl Default for SystemInfoTool { fn default() -> Self { Self::new() } }

#[async_trait]
impl AgentTool for SystemInfoTool {
    fn name(&self) -> &str { "system_info" }

    fn description(&self) -> &str {
        "Get remote system information. Categories: 'os', 'memory', 'disk', \
         'network', 'cpu', 'uptime', 'all'."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "enum": ["os", "memory", "disk", "network", "cpu", "uptime", "all"],
                    "default": "all"
                }
            },
            "required": []
        })
    }

    fn risk_level(&self) -> RiskLevel { RiskLevel::ReadOnly }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let category = params.get("category").and_then(|v| v.as_str()).unwrap_or("all");

        let cmd = match category {
            "os"      => cmd_os(),
            "memory"  => cmd_mem(),
            "disk"    => cmd_disk(),
            "network" => cmd_net(),
            "cpu"     => cmd_cpu(),
            "uptime"  => cmd_uptime(),
            "all"     => cmd_all(),
            other => {
                return Ok(ToolOutput::fail(
                    "system_info",
                    format!("unknown category: '{}'", other),
                ));
            }
        };

        match ctx.exec(&cmd).await {
            Ok(output) => {
                let body = truncate_output(output, MAX_OUTPUT_BYTES);
                Ok(ToolOutput::ok(format!("system_info {}", category), body).with_metadata(
                    json!({ "category": category }),
                ))
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("system_info {}", category),
                format!("query failed: {}", e),
            )),
        }
    }
}

// ────────────────────── Category command builders ──────────────────────
//
// Every builder emits a self-contained shell snippet. They are chained in
// `cmd_all` with labeled separators. All queries swallow errors so that a
// missing tool on one category doesn't nuke the whole response.

fn cmd_os() -> String {
    "(uname -a; echo; (cat /etc/os-release 2>/dev/null || true))".into()
}

fn cmd_uptime() -> String {
    "(uptime; echo; who -b 2>/dev/null || true)".into()
}

fn cmd_mem() -> String {
    "(free -h 2>/dev/null || vm_stat 2>/dev/null || true)".into()
}

fn cmd_disk() -> String {
    "df -hT 2>/dev/null || df -h".into()
}

fn cmd_cpu() -> String {
    "(lscpu 2>/dev/null || (grep -E '^model name|^cpu cores|^processor' /proc/cpuinfo 2>/dev/null | head -n 20) || sysctl -n machdep.cpu.brand_string 2>/dev/null || true)".into()
}

fn cmd_net() -> String {
    "(ip -brief addr 2>/dev/null || ifconfig 2>/dev/null || true); \
     echo; (ip route 2>/dev/null || netstat -rn 2>/dev/null || true)".into()
}

fn cmd_all() -> String {
    format!(
        "echo '=== OS ===';       {os};       echo; \
         echo '=== Uptime ===';   {up};       echo; \
         echo '=== CPU ===';      {cpu};      echo; \
         echo '=== Memory ===';   {mem};      echo; \
         echo '=== Disk ===';     {disk};     echo; \
         echo '=== Network ==='; {net}",
        os = cmd_os(),
        up = cmd_uptime(),
        cpu = cmd_cpu(),
        mem = cmd_mem(),
        disk = cmd_disk(),
        net = cmd_net(),
    )
}
