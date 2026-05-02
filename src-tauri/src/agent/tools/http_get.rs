//! `http_get` — fetch the full content of one or more web pages via HTTP GET.
//!
//! Supports batch fetching: pass a single `url` or an array of `urls`.
//! When multiple URLs are provided, they are fetched concurrently (up to 5
//! at a time), and results are concatenated in order.
//!
//! Typical workflow:
//!   1. Call `web_search` to find relevant URLs
//!   2. Call `http_get` with multiple URLs at once to read them all

use async_trait::async_trait;
use futures::future::join_all;
use reqwest::Client;
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

const MAX_OUTPUT_BYTES: usize = 24_000;
const TIMEOUT_SECS: u64 = 20;

pub struct HttpGetTool;
impl HttpGetTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for HttpGetTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for HttpGetTool {
    fn name(&self) -> &str {
        "http_get"
    }

    fn description(&self) -> &str {
        "Fetch the full content of one or more web pages via HTTP GET. \
         Pass a single `url` OR an array of `urls` to fetch multiple pages concurrently \
         (much faster than fetching one at a time). \
         Use this to read detailed content from URLs returned by the `web_search` tool. \
         IMPORTANT: When you need to read multiple pages, ALWAYS use the `urls` array \
         instead of calling this tool repeatedly. Returns text content (HTML stripped, links preserved)."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "A single URL to fetch (use this OR urls, not both)"
                },
                "urls": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "An array of URLs to fetch concurrently (up to 5 at a time)"
                },
                "max_length": {
                    "type": "integer",
                    "description": "Maximum total response length in bytes (default: 24000, max: 48000)",
                    "default": 24000
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
        let max_length = params
            .get("max_length")
            .and_then(|v| v.as_u64())
            .unwrap_or(MAX_OUTPUT_BYTES as u64)
            .clamp(2000, 48000) as usize;

        // Determine if single or batch mode
        let single_url = params.get("url").and_then(|v| v.as_str()).map(str::trim);
        let url_array = params.get("urls").and_then(|v| v.as_array());

        let urls_to_fetch: Vec<&str> = match (single_url, url_array) {
            (Some(url), _) if !url.is_empty() => vec![url],
            (_, Some(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str().map(str::trim))
                .filter(|u| !u.is_empty())
                .collect(),
            _ => {
                return Ok(ToolOutput::fail(
                    "http_get",
                    "missing 'url' or 'urls' parameter",
                ));
            }
        };

        if urls_to_fetch.is_empty() {
            return Ok(ToolOutput::fail(
                "http_get",
                "no valid URLs provided",
            ));
        }

        // Validate all URLs
        for url in &urls_to_fetch {
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Ok(ToolOutput::fail(
                    "http_get",
                    format!("invalid URL '{}': must start with http:// or https://", url),
                ));
            }
        }

        // Fetch all URLs concurrently
        let per_page_limit = max_length.saturating_div(urls_to_fetch.len().max(1));
        let fetches: Vec<_> = urls_to_fetch
            .iter()
            .map(|u| fetch_page(u, per_page_limit))
            .collect();

        let results = join_all(fetches).await;

        // Build combined output
        let mut sections = Vec::new();
        let mut total_bytes = 0;
        let mut success_count = 0;
        let mut fail_count = 0;

        for (i, (url, result)) in urls_to_fetch.iter().zip(results.iter()).enumerate() {
            let domain = extract_domain(url);
            match result {
                Ok(content) => {
                    success_count += 1;
                    total_bytes += content.len();
                    if urls_to_fetch.len() > 1 {
                        sections.push(format!(
                            "=== Page {}/{}: {} ===\n{}",
                            i + 1,
                            urls_to_fetch.len(),
                            domain,
                            content
                        ));
                    } else {
                        sections.push(content.clone());
                    }
                }
                Err(e) => {
                    fail_count += 1;
                    if urls_to_fetch.len() > 1 {
                        sections.push(format!(
                            "=== Page {}/{}: {} ===\nError: {}",
                            i + 1,
                            urls_to_fetch.len(),
                            domain,
                            e
                        ));
                    } else {
                        return Ok(ToolOutput::fail(
                            format!("http_get {}", domain),
                            format!("fetch failed: {}", e),
                        ));
                    }
                }
            }
        }

        let combined = sections.join("\n\n");
        let output = truncate_output(combined, MAX_OUTPUT_BYTES.min(max_length));

        let hint = "\n\n---\nTip: This page may contain links. Use `http_get` again with any URL to get its full content.";
        let final_output = format!("{}{}", output, hint);

        let summary = if urls_to_fetch.len() == 1 {
            format!(
                "http_get {} ({})",
                extract_domain(urls_to_fetch[0]),
                format_bytes(total_bytes)
            )
        } else {
            format!(
                "http_get ({} pages: {} ok, {} failed, {} total)",
                urls_to_fetch.len(),
                success_count,
                fail_count,
                format_bytes(total_bytes)
            )
        };

        Ok(ToolOutput::ok(summary, final_output)
            .with_metadata(json!({
                "urls_fetched": urls_to_fetch.len(),
                "success": success_count,
                "failed": fail_count,
                "bytes": total_bytes
            })))
    }
}

async fn fetch_page(url: &str, max_length: usize) -> Result<String, AppError> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| AppError::Agent(format!("failed to create HTTP client: {}", e)))?;

    let resp = client
        .get(url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        )
        .send()
        .await
        .map_err(|e| AppError::Agent(format!("HTTP request failed: {}", e)))?;

    if !resp.status().is_success() {
        return Err(AppError::Agent(format!(
            "HTTP error: {} ({})",
            resp.status(),
            resp.status().canonical_reason().unwrap_or("")
        )));
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Agent(format!("failed to read response: {}", e)))?;

    // If it looks like HTML, strip tags and decode entities
    if content_type.contains("text/html") || body.contains("<html") || body.contains("<!DOCTYPE") {
        Ok(strip_html(&body, max_length))
    } else {
        // Plain text, JSON, etc. — return as-is (truncated)
        if body.len() > max_length {
            Ok(format!(
                "{}\n\n[truncated to {} bytes; original {} bytes]",
                &body[..max_length],
                max_length,
                body.len()
            ))
        } else {
            Ok(body)
        }
    }
}

/// Strip HTML tags and decode entities, preserving structure with newlines
fn strip_html(html: &str, max_len: usize) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut last_was_newline = false;

    let mut chars = html.chars().peekable();

    while let Some(c) = chars.next() {
        if out.len() >= max_len {
            break;
        }

        if c == '<' {
            in_tag = true;
            let rest: String = chars.clone().take(20).collect();
            if rest.starts_with('/')
                && (rest.contains("p>")
                    || rest.contains("div>")
                    || rest.contains("h1>")
                    || rest.contains("h2>")
                    || rest.contains("h3>")
                    || rest.contains("h4>")
                    || rest.contains("li>")
                    || rest.contains("br>"))
                && !last_was_newline
            {
                out.push('\n');
                last_was_newline = true;
            }
            continue;
        }

        if c == '>' {
            in_tag = false;
            continue;
        }

        if !in_tag {
            if c == '\n' || c == '\r' {
                if !last_was_newline {
                    out.push('\n');
                    last_was_newline = true;
                }
            } else {
                if last_was_newline && c == ' ' {
                    continue;
                }
                out.push(c);
                last_was_newline = false;
            }
        }
    }

    // Decode common entities
    let out = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–");

    // Clean up excessive newlines
    let out = {
        let mut result = String::with_capacity(out.len());
        let mut consecutive_newlines = 0;
        for c in out.chars() {
            if c == '\n' {
                consecutive_newlines += 1;
                if consecutive_newlines <= 2 {
                    result.push(c);
                }
            } else {
                consecutive_newlines = 0;
                result.push(c);
            }
        }
        result
    };

    out.trim().to_string()
}

fn extract_domain(url: &str) -> String {
    url.trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or(url)
        .to_string()
}

fn format_bytes(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_domain_works() {
        assert_eq!(extract_domain("https://example.com/page"), "example.com");
        assert_eq!(
            extract_domain("http://foo.bar/baz/qux"),
            "foo.bar"
        );
    }

    #[test]
    fn format_bytes_formats() {
        assert!(format_bytes(500).contains("B"));
        assert!(format_bytes(2048).contains("KB"));
    }

    #[test]
    fn strip_html_removes_tags() {
        let html = "<html><body><p>Hello</p><div>World</div></body></html>";
        let text = strip_html(html, 1000);
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
        assert!(!text.contains("<"));
    }

    #[test]
    fn strip_html_decodes_entities() {
        let html = "Tom &amp; Jerry &quot;rock&quot;";
        assert!(strip_html(html, 1000).contains("Tom & Jerry"));
    }

    #[test]
    fn strip_html_respects_max_len() {
        let html = "<p>".repeat(10000);
        let text = strip_html(&html, 100);
        assert!(text.len() <= 100);
    }
}
