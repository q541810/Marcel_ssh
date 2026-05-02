//! `web_search` — search the internet via Bing.
//!
//! Fetches search results from Bing's result page,
//! parses result titles, snippets, and URLs. Does NOT return full page
//! content — use the `http_get` tool to retrieve detailed content from
//! any returned URL.
//!
//! Supports batch search: pass a single `query` or an array of `queries`
//! to search for multiple things concurrently (up to 5 at a time).

use async_trait::async_trait;
use futures::future::join_all;
use reqwest::Client;
use serde_json::json;

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
        "Search the internet using Bing. Pass a single `query` for one search, or pass \
         an array of `queries` to run MULTIPLE searches concurrently (much faster). \
         Returns result titles, short snippets, and URLs for each query. \
         IMPORTANT: When researching a topic, ALWAYS use the `queries` array to search \
         multiple angles at once instead of calling this tool repeatedly. \
         To read the full content of any result page, use the `http_get` tool with the returned URL."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A single search query (use this OR queries, not both)"
                },
                "queries": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "An array of search queries to run concurrently (up to 5 at a time)"
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

        let single_query = params
            .get("query")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|q| !q.is_empty());
        let query_array = params.get("queries").and_then(|v| v.as_array());

        let queries: Vec<&str> = match (single_query, query_array) {
            (Some(q), _) => vec![q],
            (_, Some(arr)) => arr
                .iter()
                .filter_map(|v| v.as_str().map(str::trim))
                .filter(|q| !q.is_empty())
                .collect(),
            _ => {
                return Ok(ToolOutput::fail(
                    "web_search",
                    "missing 'query' or 'queries' parameter",
                ));
            }
        };

        if queries.is_empty() {
            return Ok(ToolOutput::fail("web_search", "no valid queries provided"));
        }

        // Execute all searches concurrently
        let searches: Vec<_> = queries
            .iter()
            .map(|q| search_bing(q, max_results))
            .collect();
        let results = join_all(searches).await;

        // Build combined output
        let mut sections = Vec::new();
        let mut total_results = 0;
        let mut success_count = 0;
        let mut fail_count = 0;

        for (query, result) in queries.iter().zip(results.iter()) {
            match result {
                Ok(items) => {
                    total_results += items.len();
                    if !items.is_empty() {
                        success_count += 1;
                        if queries.len() > 1 {
                            sections.push(format_search_section(query, items));
                        } else {
                            sections.push(format_results(query, items));
                        }
                    } else {
                        fail_count += 1;
                        if queries.len() > 1 {
                            sections.push(format!(
                                "Query: \"{}\"\nNo results found\n",
                                query
                            ));
                        }
                    }
                }
                Err(e) => {
                    fail_count += 1;
                    if queries.len() > 1 {
                        sections.push(format!(
                            "Query: \"{}\"\nError: {}\n",
                            query, e
                        ));
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

        Ok(ToolOutput::ok(summary, output)
            .with_metadata(json!({
                "queries": queries.len(),
                "success": success_count,
                "failed": fail_count,
                "total_results": total_results
            })))
    }
}

struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

fn format_search_section(query: &str, results: &[SearchResult]) -> String {
    let mut out = format!("=== Search: \"{}\" ({} results) ===\n\n", query, results.len());

    for (i, r) in results.iter().enumerate() {
        out.push_str(&format!(
            "  {}. {}\n     {}\n     URL: {}\n\n",
            i + 1,
            r.title,
            if r.snippet.is_empty() {
                "(no snippet)".to_string()
            } else {
                r.snippet.clone()
            },
            r.url,
        ));
    }

    out
}

const SEARCH_TIP: &str = "\nTip: Use the `http_get` tool with any URL above to read the full page content.";

fn format_results(query: &str, results: &[SearchResult]) -> String {
    let mut out = format!("Search results for: \"{}\"\n{}\n\n", query, "=".repeat(50));

    for (i, r) in results.iter().enumerate() {
        out.push_str(&format!(
            "{}. {}\n   {}\n   URL: {}\n\n",
            i + 1,
            r.title,
            if r.snippet.is_empty() {
                "(no snippet)".to_string()
            } else {
                r.snippet.clone()
            },
            r.url,
        ));
    }

    out
}

async fn search_bing(
    query: &str,
    max_results: usize,
) -> Result<Vec<SearchResult>, AppError> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
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
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| AppError::Agent(format!("HTTP request failed: {}", e)))?;

    if !resp.status().is_success() {
        return Err(AppError::Agent(format!(
            "HTTP error: {}",
            resp.status()
        )));
    }

    let html = resp
        .text()
        .await
        .map_err(|e| AppError::Agent(format!("failed to read response: {}", e)))?;

    Ok(parse_results(&html, max_results))
}

fn parse_results(html: &str, max: usize) -> Vec<SearchResult> {
    let mut results = Vec::new();

    // Bing results are in <li class="b_algo"> elements
    // Each has an <h2><a href="..."> for the title/URL and a <div class="b_caption"><p> for the snippet
    let parts: Vec<&str> = html.split("b_algo").collect();

    for part in parts.iter().skip(1) {
        if results.len() >= max {
            break;
        }

        // Extract h2 > a for title and URL
        let h2_start = match part.find("<h2") {
            Some(i) => i,
            None => continue,
        };
        let h2_end = match part[h2_start..].find("</h2>") {
            Some(i) => h2_start + i,
            None => continue,
        };
        let h2_block = &part[h2_start..h2_end];

        // Find the <a> tag inside h2
        let a_start = match h2_block.find("<a ") {
            Some(i) => i,
            None => continue,
        };
        let a_end = match h2_block[a_start..].find("</a>") {
            Some(i) => a_start + i,
            None => continue,
        };
        let a_block = &h2_block[a_start..a_end];

        // Extract href from the <a> tag
        let url = extract_href(a_block);

        // Extract title text (between > and </a>)
        let title = match a_block.find('>') {
            Some(idx) => {
                let text = &a_block[idx + 1..];
                clean_html(text)
            }
            None => continue,
        };

        if title.is_empty() {
            continue;
        }

        // Extract snippet from b_caption <p>
        let snippet = if let Some(caption_start) = part.find("b_caption") {
            if let Some(p_start) = part[caption_start..].find("<p") {
                let abs_p_start = caption_start + p_start;
                if let Some(close_gt) = part[abs_p_start..].find('>') {
                    let content_start = abs_p_start + close_gt + 1;
                    if let Some(p_end) = part[content_start..].find("</p>") {
                        let snippet_text = &part[content_start..content_start + p_end];
                        clean_html(snippet_text)
                    } else {
                        String::new()
                    }
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        };

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

/// Extract href value from an <a ...> tag
fn extract_href(tag: &str) -> Option<String> {
    let href_prefix = "href=\"";
    let idx = tag.find(href_prefix)?;
    let value_start = idx + href_prefix.len();
    let rest = &tag[value_start..];
    let value_end = rest.find('"')?;
    Some(rest[..value_end].to_string())
}

/// Strip HTML tags and decode common entities
fn clean_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        if c == '<' {
            in_tag = true;
        } else if c == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(c);
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .trim()
        .to_string()
}

mod urlencoding {
    pub fn encode(input: &str) -> String {
        let mut encoded = String::with_capacity(input.len() * 3);
        for byte in input.bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    encoded.push(byte as char);
                }
                b' ' => encoded.push('+'),
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
        assert_eq!(encoded, "hello+world");
    }

    #[test]
    fn urlencoding_special_chars() {
        let encoded = urlencoding::encode("a&b");
        assert!(encoded.contains('%'));
    }

    #[test]
    fn clean_html_strips_tags() {
        assert_eq!(clean_html("<b>bold</b>"), "bold");
        assert_eq!(clean_html("<a href='x'>link</a>"), "link");
    }

    #[test]
    fn clean_html_decodes_entities() {
        assert_eq!(clean_html("Tom &amp; Jerry"), "Tom & Jerry");
        assert_eq!(clean_html("foo&nbsp;bar"), "foo bar");
    }

    #[test]
    fn extract_href_finds_link() {
        let tag = r#"<a href="https://example.com" class="foo">"#;
        assert_eq!(
            extract_href(tag),
            Some("https://example.com".to_string())
        );
    }
}
