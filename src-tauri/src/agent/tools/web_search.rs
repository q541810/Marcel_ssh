//! `web_search` — search the internet via Bing.
//!
//! Fetches search results from Bing's result page,
//! parses result titles, snippets, and URLs. Does NOT return full page
//! content — use the `http_get` tool to retrieve detailed content from
//! any returned URL.
//!
//! Accepts exactly one `query` per call. Keeping each search isolated avoids
//! search-provider throttling and low-quality fallback results.

use async_trait::async_trait;
use reqwest::Client;
use scraper::{Html, Selector};
use serde_json::json;
use std::time::Duration;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

const MAX_RESULTS: usize = 8;
const MAX_OUTPUT_BYTES: usize = 16_000;
const TIMEOUT_SECS: u64 = 15;
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
        "使用 Bing 搜索互联网。每次调用只能传入一个 `query`。 \
         返回该查询的结果标题、简短片段和 URL。 \
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
                    "description": "Maximum number of results per query (default: 5, max: 10)",
                    "default": 5
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
        _ctx: &ToolContext,
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

        let single_query = params
            .get("query")
            .and_then(|v| v.as_str())
            .map(normalize_query)
            .filter(|q| !q.is_empty());

        let queries: Vec<String> = match single_query {
            Some(q) => vec![q],
            _ => {
                return Ok(ToolOutput::fail("web_search", "missing 'query' parameter"));
            }
        };

        if queries.is_empty() {
            return Ok(ToolOutput::fail("web_search", "no valid queries provided"));
        }

        // Keep this as a vector internally so the output formatter stays simple.
        let mut results = Vec::with_capacity(queries.len());
        for query in &queries {
            results.push(search_bing(query, max_results).await);
        }

        // Build combined output
        let mut sections = Vec::new();
        let mut total_results = 0;
        let mut success_count = 0;
        let mut fail_count = 0;
        let mut metadata_results = Vec::new();

        for (query, result) in queries.iter().zip(results.iter()) {
            match result {
                Ok(items) => {
                    total_results += items.len();
                    if !items.is_empty() {
                        success_count += 1;
                        sections.push(format_results_for_query(query.as_str(), items));
                        metadata_results.extend(search_result_metadata(query.as_str(), items));
                    } else {
                        fail_count += 1;
                        sections.push(format_empty_query_section(query.as_str()));
                    }
                }
                Err(e) => {
                    fail_count += 1;
                    if queries.len() > 1 {
                        sections.push(format_error_query_section(query.as_str(), e));
                    } else {
                        return Ok(ToolOutput::fail(
                            format!("web_search '{}'", query),
                            format!("search failed: {}", e),
                        ));
                    }
                }
            }
        }

        if sections.is_empty() {
            return Ok(ToolOutput::ok(
                "web_search (no results)".to_string(),
                "no search results found".to_string(),
            ));
        }

        let combined = sections.join("\n");
        let output = truncate_output(format!("{}{}", combined, SEARCH_TIP), MAX_OUTPUT_BYTES);

        let summary = if queries.len() == 1 {
            format!("web_search '{}' ({} results)", queries[0], total_results)
        } else {
            format!(
                "web_search ({} queries: {} ok, {} failed, {} total results)",
                queries.len(),
                success_count,
                fail_count,
                total_results
            )
        };

        Ok(ToolOutput::ok(summary, output).with_metadata(json!({
            "queries": queries.len(),
            "success": success_count,
            "failed": fail_count,
            "total_results": total_results,
            "results": metadata_results
        })))
    }
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

struct SearchResult {
    title: String,
    url: String,
    snippet: String,
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

fn format_empty_query_section(query: &str) -> String {
    format!("## Query: {}\n\nNo results found\n", query)
}

fn format_error_query_section(query: &str, error: &AppError) -> String {
    format!("## Query: {}\n\nError: {}\n", query, error)
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

const SEARCH_TIP: &str =
    "\nTip: Use the `http_get` tool with any URL above to read the full page content.";

async fn search_bing(query: &str, max_results: usize) -> Result<Vec<SearchResult>, AppError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Agent(format!("failed to create HTTP client: {}", e)))?;

    let url = format!(
        "https://www.bing.com/search?q={}",
        urlencoding::encode(query)
    );

    let resp = client
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .header("Upgrade-Insecure-Requests", "1")
        .header("Sec-Fetch-Dest", "document")
        .header("Sec-Fetch-Mode", "navigate")
        .header("Sec-Fetch-Site", "none")
        .header("Sec-Fetch-User", "?1")
        .header("Sec-CH-UA", "\"Not_A Brand\";v=\"8\", \"Chromium\";v=\"120\", \"Google Chrome\";v=\"120\"")
        .header("Sec-CH-UA-Mobile", "?0")
        .header("Sec-CH-UA-Platform", "\"Windows\"")
        .send()
        .await
        .map_err(|e| AppError::Agent(format!("HTTP request failed: {}", e)))?;

    let status = resp.status();

    if !status.is_success() {
        return Err(AppError::Agent(format!("HTTP error: {}", status)));
    }

    let html = resp
        .text()
        .await
        .map_err(|e| AppError::Agent(format!("failed to read response: {}", e)))?;

    let results = parse_results(&html, max_results);

    Ok(results)
}

fn parse_results(html: &str, max: usize) -> Vec<SearchResult> {
    let mut results = Vec::new();

    let document = Html::parse_document(html);
    let result_selector = Selector::parse("li.b_algo").expect("valid b_algo selector");
    let link_selector = Selector::parse("h2 a").expect("valid result link selector");
    let snippet_selector = Selector::parse(".b_caption p, p").expect("valid snippet selector");

    for result in document.select(&result_selector) {
        if results.len() >= max {
            break;
        }

        let Some(link) = result.select(&link_selector).next() else {
            continue;
        };
        let title = link.text().collect::<Vec<_>>().join(" ").trim().to_string();

        if title.is_empty() {
            continue;
        }

        let url = link.value().attr("href").map(str::to_string);
        let snippet = result
            .select(&snippet_selector)
            .next()
            .map(|node| node.text().collect::<Vec<_>>().join(" ").trim().to_string())
            .unwrap_or_default();

        // Bing URLs are direct — no redirect wrapper
        let final_url = if let Some(u) = url {
            if u.starts_with("http") {
                u
            } else if u.starts_with("//") {
                format!("https:{}", u)
            } else if u.starts_with("/") {
                format!("https://www.bing.com{}", u)
            } else {
                format!("https://{}", u)
            }
        } else {
            continue;
        };

        results.push(SearchResult {
            title,
            url: final_url,
            snippet,
        });
    }

    results
}

mod urlencoding {
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
    fn empty_query_section_is_grouped() {
        let output = format_empty_query_section("missing topic");

        assert!(output.contains("## Query: missing topic"), "{output}");
        assert!(output.contains("No results found"), "{output}");
    }

    #[test]
    fn error_query_section_is_grouped() {
        let error = AppError::Agent("network failed".to_string());
        let output = format_error_query_section("bad query", &error);

        assert!(output.contains("## Query: bad query"), "{output}");
        assert!(output.contains("network failed"), "{output}");
    }

    #[test]
    fn schema_exposes_only_single_query() {
        let schema = WebSearchTool::new().parameters_schema();

        assert!(schema["properties"].get("query").is_some());
        assert!(schema["properties"].get("queries").is_none());
        assert_eq!(schema["required"], json!(["query"]));
        assert_eq!(schema["additionalProperties"], false);
    }
}
