//! `search_files` — recursively search file contents on the remote server.
//!
//! Backed by `grep -rnI` (recursive, line numbers, skip binary). The pattern
//! is treated as a fixed string by default to avoid LLM-induced regex
//! injection; pass `regex=true` to opt into ERE.

use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{shell_escape, truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

const MAX_OUTPUT_BYTES: usize = 12_000;
const DEFAULT_MAX_MATCHES: u64 = 200;

pub struct SearchFilesTool;
impl SearchFilesTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for SearchFilesTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for SearchFilesTool {
    fn name(&self) -> &str {
        "search_files"
    }

    fn description(&self) -> &str {
        "Recursively search for a pattern in files under a directory (grep -rnI). \
         By default the pattern is a fixed string; pass `regex=true` for extended regex. \
         Binary files are skipped. Results are capped at 200 matches by default."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern":   { "type": "string", "description": "Text or regex to search for" },
                "directory": { "type": "string", "description": "Directory to search (default: '.')" },
                "regex":     { "type": "boolean", "description": "Treat pattern as ERE regex (default: false)", "default": false },
                "max_matches": { "type": "integer", "description": "Maximum total matches (default: 200)", "default": 200 }
            },
            "required": ["pattern"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let pattern = params
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'pattern' parameter".into()))?;
        if pattern.is_empty() {
            return Ok(ToolOutput::fail("search_files", "empty pattern"));
        }
        let directory = params
            .get("directory")
            .and_then(|v| v.as_str())
            .unwrap_or(".");
        let regex = params
            .get("regex")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let max_matches = params
            .get("max_matches")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_MAX_MATCHES)
            .clamp(1, 5_000);

        // -F fixed-string, -E extended regex; -r recursive; -n line numbers;
        // -I skip binary files; -s suppress permission-error noise.
        let mode_flag = if regex { "-E" } else { "-F" };
        let cmd = format!(
            "grep -rnIs {mode} -m {limit} -e {pat} {dir} 2>/dev/null | head -n {limit}",
            mode = mode_flag,
            limit = max_matches,
            pat = shell_escape(pattern),
            dir = shell_escape(directory),
        );

        match ctx.exec(&cmd).await {
            Ok(output) => {
                let count = output.lines().filter(|l| !l.is_empty()).count();
                if count == 0 {
                    return Ok(ToolOutput::ok(
                        format!("search '{}' (no matches)", pattern),
                        "no matches found",
                    )
                    .with_metadata(json!({ "matches": 0 })));
                }
                let body = truncate_output(output, MAX_OUTPUT_BYTES);
                Ok(ToolOutput::ok(
                    format!(
                        "search '{}' ({} match{})",
                        pattern,
                        count,
                        if count == 1 { "" } else { "es" }
                    ),
                    body,
                )
                .with_metadata(json!({
                    "matches": count,
                    "regex": regex,
                    "directory": directory,
                })))
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("search '{}'", pattern),
                format!("search failed: {}", e),
            )),
        }
    }
}
