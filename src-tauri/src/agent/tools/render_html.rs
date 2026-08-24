//! `render_html` — render an interactive HTML fragment inline in the conversation.

use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

const MAX_FRAGMENT_BYTES: usize = 1024 * 1024;

fn document_skeleton_tag(fragment: &str) -> Option<&'static str> {
    let lower = fragment.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] != b'<' {
            cursor += 1;
            continue;
        }
        let mut i = cursor + 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes.get(i) == Some(&b'!') {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if lower[i..].starts_with("doctype") {
                return Some("doctype");
            }
        }
        if bytes.get(i) == Some(&b'/') {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
            i += 1;
        }
        match &lower[start..i] {
            "html" => return Some("html"),
            "head" => return Some("head"),
            "body" => return Some("body"),
            "frameset" => return Some("frameset"),
            _ => cursor += 1,
        }
    }
    None
}

fn run(params: &serde_json::Value) -> ToolOutput {
    let title = params
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Visualization")
        .trim();
    let fragment = params
        .get("fragment")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mode = params
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("inline");

    if title.is_empty() {
        return ToolOutput::fail("render_html: 缺少 title", "Missing 'title' parameter");
    }
    if fragment.trim().is_empty() {
        return ToolOutput::fail(
            "render_html: 缺少 fragment",
            "Missing or empty 'fragment' parameter",
        );
    }
    if !matches!(mode, "inline" | "wide") {
        return ToolOutput::fail(
            "render_html: mode 无效",
            "Invalid 'mode': expected 'inline' or 'wide'",
        );
    }
    if fragment.len() > MAX_FRAGMENT_BYTES {
        return ToolOutput::fail(
            "render_html: fragment 过大",
            format!(
                "Fragment is {} bytes, exceeding the {} KB limit. Reduce inline data first.",
                fragment.len(),
                MAX_FRAGMENT_BYTES / 1024
            ),
        );
    }

    if let Some(tag) = document_skeleton_tag(fragment) {
        return ToolOutput::fail(
            "render_html: 只接受 HTML fragment",
            format!(
                "Fragment contains document skeleton tag '{tag}'. Pass body markup only; the host supplies the document, CSP, theme, and runtime."
            ),
        );
    }

    ToolOutput::ok(
        format!("已展示: {}", title),
        format!(
            "Rendered \"{}\" inline ({} bytes). The user can see and interact with it; do not repeat the markup in your reply.",
            title,
            fragment.len()
        ),
    )
    .with_metadata(json!({
        "kind": "renderHtml",
        "title": title,
        "fragment": fragment,
        "mode": mode,
        "sizeBytes": fragment.len(),
    }))
}

pub struct RenderHtmlTool;

impl RenderHtmlTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for RenderHtmlTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for RenderHtmlTool {
    fn name(&self) -> &str {
        "render_html"
    }

    fn description(&self) -> &str {
        "Show an interactive HTML visualization directly in the conversation. Proactively use it for charts, simulations, comparisons, parameter exploration, algorithm walkthroughs, dashboards, and UI mockups whenever visual presentation would improve understanding; the user need not explicitly ask for a visualization. `fragment` is literal inline body markup only (no document skeleton); optional `title` names it and `mode` is inline or wide. The page appears while you generate it. Before the first call, follow the enabled Visualize skill for the design system, motion contract, chart recipes, CSP limits, and response rules."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Concise title; defaults to Visualization"
                },
                "mode": {
                    "type": "string",
                    "enum": ["inline", "wide"],
                    "description": "Conversation width: inline (default) or wide for side-by-side comparisons"
                },
                "fragment": {
                    "type": "string",
                    "description": "Required inline HTML body fragment (markup, style, and script; no document skeleton)"
                }
            },
            "required": ["fragment"]
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
        Ok(run(&params))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_fragment_and_persists_presentation_metadata() {
        let out = run(&json!({
            "title": "CPU 对比",
            "fragment": "<section><h2>CPU</h2></section>",
            "mode": "wide"
        }));
        assert!(out.success);
        assert!(!out.output.contains("<section>"));
        let meta = out.metadata.expect("metadata");
        assert_eq!(meta["kind"], "renderHtml");
        assert_eq!(meta["fragment"], "<section><h2>CPU</h2></section>");
        assert_eq!(meta["mode"], "wide");
    }

    #[test]
    fn defaults_title_and_mode() {
        let out = run(&json!({ "fragment": "<p>x</p>" }));
        let meta = out.metadata.expect("metadata");
        assert_eq!(meta["title"], "Visualization");
        assert_eq!(meta["mode"], "inline");
    }

    #[test]
    fn rejects_empty_fragment() {
        assert!(!run(&json!({ "fragment": "   " })).success);
    }

    #[test]
    fn rejects_document_skeleton() {
        for fragment in [
            "<!DOCTYPE html><p>x</p>",
            "<HTML><body>x</body></HTML>",
            "<head><title>x</title></head>",
            "<section>x</section></body>",
            "<  /  BODY>",
        ] {
            assert!(!run(&json!({ "fragment": fragment })).success);
        }
    }

    #[test]
    fn rejects_invalid_mode() {
        assert!(!run(&json!({ "fragment": "<p>x</p>", "mode": "fullscreen" })).success);
    }

    #[test]
    fn rejects_oversized_fragment() {
        let big = "x".repeat(MAX_FRAGMENT_BYTES + 1);
        assert!(!run(&json!({ "fragment": big })).success);
    }
}
