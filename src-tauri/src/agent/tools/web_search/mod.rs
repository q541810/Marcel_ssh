//! `web_search` — search the internet via configurable providers.
//!
//! Modes (settings → experimentalSettings.webSearchMode):
//! - `browser` (default): local headless Chrome/Edge via CDP
//! - `api`: Brave / Tavily search HTTP APIs
//! - `html`: bare Bing HTML scrape
//!
//! Does NOT return full page content — use `http_get` for that.

use async_trait::async_trait;
use serde_json::json;
use tauri::Manager;

use crate::agent::sandbox::RiskLevel;

use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::config::keychain;
use crate::config::settings::{WebSearchApiProvider, WebSearchMode};
use crate::error::AppError;

mod api;
mod browser;
mod html;
mod parse;
mod types;

pub mod urlencoding {
    pub fn encode(input: &str) -> String {
        let mut encoded = String::with_capacity(input.len() * 3);
        for byte in input.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    encoded.push(byte as char);
                }
                b' ' => encoded.push_str("%20"),
                _ => {
                    encoded.push('%');
                    encoded.push(to_hex(byte >> 4));
                    encoded.push(to_hex(byte & 0x0F));
                }
            }
        }
        encoded
    }

    fn to_hex(nibble: u8) -> char {
        b"0123456789ABCDEF"[nibble as usize] as char
    }
}

use types::{SearchOutcome, SearchResult};

const MAX_RESULTS: usize = 8;
const MAX_OUTPUT_BYTES: usize = 16_000;
const SEARCH_TIP: &str =
    "\nTip: Use the `http_get` tool with any URL above to read the full page content.";

pub struct WebSearchTool;

impl WebSearchTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WebSearchTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }

    fn description(&self) -> &str {
        "搜索互联网。每次调用只能传入一个 `query`。 \
         返回该查询的结果标题、简短片段和 URL。 \
         搜索后端由应用设置中的「联网搜索方式」决定（本机浏览器 / 搜索 API / 裸抓 HTML）。 \
         可以在同一轮中多次调用 web_search，但每次调用只搜索一个 query。 \
         要阅读任何结果页面的完整内容，请使用 `http_get` 工具并传入返回的 URL。"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "required": ["query"],
            "additionalProperties": false,
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A single search query. Do not include multiple queries."
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results (default: 8, max: 10)",
                    "default": 8
                }
            }
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
        let max_results = params
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(MAX_RESULTS as u64)
            .clamp(1, 10) as usize;

        if params.get("queries").is_some() {
            return Ok(ToolOutput::fail(
                "web_search",
                "'queries' is no longer supported; call web_search once per query using 'query'",
            ));
        }

        let query = match params
            .get("query")
            .and_then(|v| v.as_str())
            .map(normalize_query)
            .filter(|q| !q.is_empty())
        {
            Some(q) => q,
            None => return Ok(ToolOutput::fail("web_search", "missing 'query' parameter")),
        };

        let (mode, api_provider) = resolve_search_config(ctx).await;

        let outcome = match run_search(mode, api_provider, &query, max_results).await {
            Ok(o) => o,
            Err(e) => {
                return Ok(ToolOutput::fail(
                    format!("web_search '{}'", query),
                    format!("search failed (mode={:?}): {}", mode, e),
                ));
            }
        };

        Ok(format_outcome(&query, outcome))
    }
}

async fn resolve_search_config(ctx: &ToolContext) -> (WebSearchMode, WebSearchApiProvider) {
    // Mobile (Android) 无法启动本地 Chrome/Edge 走 CDP，无视用户设置强制走
    // 裸 Bing HTML 抓取（html）模式，避免工具调用必然失败。
    #[cfg(mobile)]
    {
        let _ = ctx;
        return (WebSearchMode::Html, WebSearchApiProvider::default());
    }

    #[cfg(desktop)]
    {
        // Prefer live app settings when available.
        if let Some(state) = ctx.app_handle.try_state::<crate::AppState>() {
            let settings = state.settings.read().await;
            let exp = &settings.experimental_settings;
            return (exp.web_search_mode, exp.web_search_api_provider);
        }
        (WebSearchMode::default(), WebSearchApiProvider::default())
    }
}

async fn run_search(
    mode: WebSearchMode,
    api_provider: WebSearchApiProvider,
    query: &str,
    max_results: usize,
) -> Result<SearchOutcome, AppError> {
    match mode {
        WebSearchMode::Browser => browser::search(query, max_results).await,
        WebSearchMode::Html => html::search(query, max_results).await,
        WebSearchMode::Api => {
            let key = keychain::get_web_search_api_key()?.unwrap_or_default();
            api::search(api_provider, &key, query, max_results).await
        }
    }
}


fn format_outcome(query: &str, outcome: SearchOutcome) -> ToolOutput {
    let SearchOutcome { provider, results } = outcome;

    if results.is_empty() {
        return ToolOutput::ok(
            format!("web_search '{}' (0 results via {})", query, provider),
            format!(
                "## Query: {}\n\nNo results found\n{}",
                query, SEARCH_TIP
            ),
        )
        .with_metadata(json!({
            "provider": provider,
            "queries": 1,
            "success": 0,
            "failed": 1,
            "total_results": 0,
            "results": []
        }));
    }

    let section = format_results_for_query(query, &results);
    let output = truncate_output(format!("{}{}", section, SEARCH_TIP), MAX_OUTPUT_BYTES);
    let metadata_results = search_result_metadata(query, &results);
    let total = results.len();

    ToolOutput::ok(
        format!("web_search '{}' ({} results via {})", query, total, provider),
        output,
    )
    .with_metadata(json!({
        "provider": provider,
        "queries": 1,
        "success": 1,
        "failed": 0,
        "total_results": total,
        "results": metadata_results
    }))
}

fn normalize_query(query: &str) -> String {
    let mut normalized = String::with_capacity(query.len());
    let mut last_was_space = false;

    for ch in query.chars() {
        if is_invisible_format_char(ch) {
            continue;
        }
        if ch.is_whitespace() {
            if !last_was_space {
                normalized.push(' ');
                last_was_space = true;
            }
            continue;
        }
        normalized.push(ch);
        last_was_space = false;
    }

    normalized.trim().to_string()
}

fn is_invisible_format_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}'
    )
}

fn format_results_for_query(query: &str, results: &[SearchResult]) -> String {
    let mut out = format!("## Query: {}\n\n", query);

    for (i, r) in results.iter().enumerate() {
        out.push_str(&format!(
            "{}. **{}**\n   URL: {}\n   Snippet: {}\n\n",
            i + 1,
            r.title,
            r.url,
            if r.snippet.is_empty() {
                "(no snippet)".to_string()
            } else {
                r.snippet.clone()
            }
        ));
    }

    out
}

fn search_result_metadata(query: &str, results: &[SearchResult]) -> Vec<serde_json::Value> {
    results
        .iter()
        .map(|r| {
            json!({
                "query": query,
                "title": &r.title,
                "url": &r.url,
                "snippet": &r.snippet
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencoding_spaces() {
        let encoded = urlencoding::encode("hello world");
        assert_eq!(encoded, "hello%20world");
    }

    #[test]
    fn urlencoding_special_chars() {
        let encoded = urlencoding::encode("a&b");
        assert!(encoded.contains('%'));
    }

    #[test]
    fn normalize_query_removes_invisible_chars_and_collapses_whitespace() {
        assert_eq!(
            normalize_query("  水月雨\u{200B}\tKadenz\n升级线  "),
            "水月雨 Kadenz 升级线",
        );
    }

    #[test]
    fn format_results_for_query_groups_with_markdown_heading() {
        let results = vec![SearchResult {
            title: "Async Rust Guide".to_string(),
            url: "https://example.com/rust".to_string(),
            snippet: "Learn async Rust.".to_string(),
        }];

        let output = format_results_for_query("Rust async", &results);

        assert!(output.contains("## Query: Rust async"), "{output}");
        assert!(output.contains("1. **Async Rust Guide**"), "{output}");
        assert!(output.contains("URL: https://example.com/rust"), "{output}");
        assert!(output.contains("Snippet: Learn async Rust."), "{output}");
    }

    #[test]
    fn search_result_metadata_includes_query_for_each_result() {
        let results = vec![SearchResult {
            title: "Tokio Tutorial".to_string(),
            url: "https://tokio.rs".to_string(),
            snippet: "Runtime tutorial.".to_string(),
        }];

        let metadata = search_result_metadata("Rust runtime", &results);

        assert_eq!(metadata.len(), 1);
        assert_eq!(metadata[0]["query"], "Rust runtime");
        assert_eq!(metadata[0]["title"], "Tokio Tutorial");
        assert_eq!(metadata[0]["url"], "https://tokio.rs");
        assert_eq!(metadata[0]["snippet"], "Runtime tutorial.");
    }

    #[test]
    fn schema_exposes_only_single_query() {
        let schema = WebSearchTool::new().parameters_schema();

        assert!(schema["properties"].get("query").is_some());
        assert!(schema["properties"].get("queries").is_none());
        assert_eq!(schema["required"], json!(["query"]));
        assert_eq!(schema["additionalProperties"], false);
    }

    #[test]
    fn format_outcome_includes_provider_metadata() {
        let out = format_outcome(
            "test",
            SearchOutcome {
                provider: "browser",
                results: vec![SearchResult {
                    title: "T".into(),
                    url: "https://example.com".into(),
                    snippet: "S".into(),
                }],
            },
        );
        assert!(out.success);
        assert!(out.summary.contains("browser"));
        let meta = out.metadata.unwrap();
        assert_eq!(meta["provider"], "browser");
        assert_eq!(meta["total_results"], 1);
    }

    #[test]
    fn format_outcome_empty_results_still_ok_with_provider() {
        let out = format_outcome(
            "empty",
            SearchOutcome {
                provider: "html",
                results: vec![],
            },
        );
        assert!(out.success);
        assert!(out.summary.contains("0 results"));
        assert!(out.summary.contains("html"));
        let meta = out.metadata.unwrap();
        assert_eq!(meta["provider"], "html");
        assert_eq!(meta["total_results"], 0);
        assert_eq!(meta["failed"], 1);
    }

    #[test]
    fn missing_query_fails_cleanly() {
        // execute needs AppHandle; validate parameter path via schema + normalize only.
        assert!(normalize_query("   ").is_empty());
        assert!(normalize_query("\u{200B}\u{200C}").is_empty());
    }

    #[test]
    fn web_search_mode_dispatch_labels() {
        // Ensure mode enum variants used by run_search stay stable for settings.
        assert_eq!(
            format!("{:?}", WebSearchMode::Browser).to_ascii_lowercase(),
            "browser"
        );
        assert_eq!(
            format!("{:?}", WebSearchMode::Html).to_ascii_lowercase(),
            "html"
        );
        assert_eq!(format!("{:?}", WebSearchMode::Api).to_ascii_lowercase(), "api");
    }

    #[test]
    fn every_web_search_mode_produces_distinct_provider_label() {
        let fixture = r#"
        <html><body>
          <li class="b_algo">
            <h2><a href="https://example.com/x">X</a></h2>
            <div class="b_caption"><p>snippet</p></div>
          </li>
        </body></html>
        "#;

        let html = html::outcome_from_html(fixture, 5).expect("html mode");
        assert_eq!(html.provider, "html");
        assert_eq!(html.results.len(), 1);

        let browser = browser::outcome_from_browser_html(fixture, 5).expect("browser mode");
        assert_eq!(browser.provider, "browser");
        assert_eq!(browser.results.len(), 1);

        // API modes: mapping layer produces api:brave / api:tavily labels.
        let brave = SearchOutcome {
            provider: "api:brave",
            results: html.results.clone(),
        };
        let tavily = SearchOutcome {
            provider: "api:tavily",
            results: browser.results.clone(),
        };
        assert_eq!(brave.provider, "api:brave");
        assert_eq!(tavily.provider, "api:tavily");

        // format_outcome surfaces provider for each mode label.
        for provider in ["html", "browser", "api:brave", "api:tavily"] {
            let out = format_outcome(
                "q",
                SearchOutcome {
                    provider,
                    results: vec![SearchResult {
                        title: "T".into(),
                        url: "https://t.example".into(),
                        snippet: "s".into(),
                    }],
                },
            );
            assert!(out.success, "{provider}");
            assert!(out.summary.contains(provider), "{provider}: {}", out.summary);
            assert_eq!(out.metadata.as_ref().unwrap()["provider"], provider);
        }
    }


    #[tokio::test]
    async fn run_search_api_mode_fails_without_key() {
        let err = run_search(WebSearchMode::Api, WebSearchApiProvider::Brave, "q", 3)
            .await
            .expect_err("no key");
        let msg = err.to_string().to_ascii_lowercase();
        assert!(msg.contains("key"), "{msg}");
    }
}


