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
use reqwest::header::CONTENT_TYPE;
use reqwest::Client;
use scraper::{Html, Selector};
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

const MAX_OUTPUT_BYTES: usize = 24_000;
const TIMEOUT_SECS: u64 = 20;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OutputFormat {
    Markdown,
    Text,
}

struct FetchedPage {
    requested_url: String,
    final_url: String,
    status: u16,
    status_text: String,
    content_type: String,
    title: Option<String>,
    content: String,
    source_bytes: usize,
    markdown_bytes: usize,
    redirected: bool,
    http_error: bool,
}

struct PageChunk {
    content: String,
    offset: usize,
    chunk_size: usize,
    next_offset: Option<usize>,
    total_bytes: usize,
    truncated: bool,
}

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
         instead of calling this tool repeatedly. Returns readable Markdown by default, \
         preserving headings, lists, code blocks, tables, links, and basic HTTP metadata. \
         For long pages, use `offset` and `chunk_size` with a single `url` to continue reading."
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
                    "description": "Backward-compatible alias for chunk_size in bytes (default: 24000, max: 48000)",
                    "default": 24000
                },
                "chunk_size": {
                    "type": "integer",
                    "description": "Maximum returned content chunk size in bytes (default: 24000, max: 48000)",
                    "default": 24000
                },
                "offset": {
                    "type": "integer",
                    "description": "Byte offset into the converted Markdown/text content. Only supported with a single url.",
                    "default": 0
                },
                "format": {
                    "type": "string",
                    "enum": ["markdown", "text"],
                    "description": "Output format for HTML pages (default: markdown)",
                    "default": "markdown"
                },
                "include_metadata": {
                    "type": "boolean",
                    "description": "Include HTTP status, content type, final URL, title, and chunk info in the textual output (default: true)",
                    "default": true
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
        let chunk_size = params
            .get("chunk_size")
            .or_else(|| params.get("max_length"))
            .and_then(|v| v.as_u64())
            .unwrap_or(MAX_OUTPUT_BYTES as u64)
            .clamp(2000, 48000) as usize;
        let offset = params.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let include_metadata = params
            .get("include_metadata")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let format = parse_output_format(params.get("format").and_then(|v| v.as_str()));

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
            return Ok(ToolOutput::fail("http_get", "no valid URLs provided"));
        }

        if urls_to_fetch.len() > 1 && offset > 0 {
            return Ok(ToolOutput::fail(
                "http_get",
                "offset pagination is only supported with a single 'url', not 'urls'",
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

        // Batch mode treats chunk_size as a per-page limit. The final combined
        // output still has a safety cap to avoid flooding the model context.
        let combined_output_limit = chunk_size
            .saturating_mul(urls_to_fetch.len().max(1))
            .min(96_000);
        let fetches: Vec<_> = urls_to_fetch
            .iter()
            .map(|u| fetch_page(u, format))
            .collect();

        let results = join_all(fetches).await;

        // Build combined output
        let mut sections = Vec::new();
        let mut total_source_bytes = 0;
        let mut total_content_bytes = 0;
        let mut success_count = 0;
        let mut fail_count = 0;
        let mut pages_metadata = Vec::new();

        for (i, (url, result)) in urls_to_fetch.iter().zip(results.iter()).enumerate() {
            let domain = extract_domain(url);
            match result {
                Ok(page) => {
                    if page.http_error {
                        fail_count += 1;
                    } else {
                        success_count += 1;
                    }
                    total_source_bytes += page.source_bytes;
                    total_content_bytes += page.markdown_bytes;
                    let page_offset = if urls_to_fetch.len() == 1 { offset } else { 0 };
                    let page_chunk_size = chunk_size;
                    let chunk = make_chunk(&page.content, page_offset, page_chunk_size);
                    pages_metadata.push(page_metadata(page, &chunk));
                    if urls_to_fetch.len() > 1 {
                        sections.push(format!(
                            "## Page {}/{}: {}\n\n{}",
                            i + 1,
                            urls_to_fetch.len(),
                            domain,
                            format_page_output(page, &chunk, include_metadata)
                        ));
                    } else {
                        sections.push(format_page_output(page, &chunk, include_metadata));
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
        let output = truncate_output(combined, combined_output_limit);

        let hint = "\n\n---\nTip: This page may contain links. Use `http_get` again with any URL to get its full content.";
        let final_output = format!("{}{}", output, hint);

        let summary = if urls_to_fetch.len() == 1 {
            format!(
                "http_get {} ({})",
                extract_domain(urls_to_fetch[0]),
                format_bytes(total_content_bytes)
            )
        } else {
            format!(
                "http_get ({} pages: {} ok, {} failed, {} total)",
                urls_to_fetch.len(),
                success_count,
                fail_count,
                format_bytes(total_content_bytes)
            )
        };

        let metadata = json!({
            "urls_fetched": urls_to_fetch.len(),
            "success": success_count,
            "failed": fail_count,
            "source_bytes": total_source_bytes,
            "content_bytes": total_content_bytes,
            "format": match format {
                OutputFormat::Markdown => "markdown",
                OutputFormat::Text => "text",
            },
            "pages": pages_metadata
        });

        if success_count == 0 && fail_count > 0 {
            Ok(ToolOutput::fail(summary, final_output).with_metadata(metadata))
        } else {
            Ok(ToolOutput::ok(summary, final_output).with_metadata(metadata))
        }
    }
}

async fn fetch_page(url: &str, format: OutputFormat) -> Result<FetchedPage, AppError> {
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

    let status = resp.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let final_url = resp.url().to_string();
    let content_type = resp
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Agent(format!("failed to read response: {}", e)))?;
    let source_bytes = body.len();
    let title = extract_title(&body);

    let content = if is_html(&content_type, &body) {
        let readable_html = extract_readable_html(&body);
        match format {
            OutputFormat::Markdown => html_to_markdown(&readable_html),
            OutputFormat::Text => strip_html(&readable_html, usize::MAX),
        }
    } else {
        body
    };
    let content = cleanup_markdown(&content);
    let markdown_bytes = content.len();
    let redirected = normalize_url_for_compare(url) != normalize_url_for_compare(&final_url);
    let http_error = !status.is_success();

    Ok(FetchedPage {
        requested_url: url.to_string(),
        final_url,
        status: status.as_u16(),
        status_text,
        content_type,
        title,
        content,
        source_bytes,
        markdown_bytes,
        redirected,
        http_error,
    })
}

fn parse_output_format(format: Option<&str>) -> OutputFormat {
    match format
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("text") => OutputFormat::Text,
        _ => OutputFormat::Markdown,
    }
}

fn is_html(content_type: &str, body: &str) -> bool {
    let content_type = content_type.to_ascii_lowercase();
    content_type.contains("text/html")
        || body.contains("<html")
        || body.contains("<HTML")
        || body.contains("<!DOCTYPE")
        || body.contains("<!doctype")
}

fn html_to_markdown(html: &str) -> String {
    html2md::parse_html(html)
}

fn extract_readable_html(html: &str) -> String {
    let cleaned = strip_noise_html(html);
    let document = Html::parse_document(&cleaned);

    for selector in readable_selectors() {
        if let Ok(selector) = Selector::parse(selector) {
            if let Some(element) = document.select(&selector).find(|e| {
                let text = cleanup_whitespace(&e.text().collect::<Vec<_>>().join(" "));
                text.len() >= 40
            }) {
                return element.inner_html();
            }
        }
    }

    if let Ok(selector) = Selector::parse("body") {
        if let Some(body) = document.select(&selector).next() {
            return body.inner_html();
        }
    }

    cleaned
}

fn readable_selectors() -> &'static [&'static str] {
    &[
        "main",
        "article",
        "[role=main]",
        "#main",
        "#content",
        "body",
    ]
}

fn strip_noise_html(html: &str) -> String {
    let without_comments = strip_html_comments(html);
    let mut cleaned = without_comments;
    for tag in [
        "script", "style", "noscript", "template", "svg", "iframe", "canvas", "meta", "link",
    ] {
        cleaned = strip_html_tag(&cleaned, tag);
    }
    cleaned
}

fn strip_html_comments(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut pos = 0;
    while let Some(start_rel) = html[pos..].find("<!--") {
        let start = pos + start_rel;
        out.push_str(&html[pos..start]);
        if let Some(end_rel) = html[start + 4..].find("-->") {
            pos = start + 4 + end_rel + 3;
        } else {
            return out;
        }
    }
    out.push_str(&html[pos..]);
    out
}

fn strip_html_tag(html: &str, tag: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let open_prefix = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut out = String::with_capacity(html.len());
    let mut pos = 0;

    while let Some(start_rel) = lower[pos..].find(&open_prefix) {
        let start = pos + start_rel;
        let after_open = start + open_prefix.len();
        let next = lower.as_bytes().get(after_open).copied();
        if !matches!(
            next,
            Some(b'>') | Some(b'/') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')
        ) {
            out.push_str(&html[pos..after_open]);
            pos = after_open;
            continue;
        }

        out.push_str(&html[pos..start]);
        let Some(open_end_rel) = lower[start..].find('>') else {
            return out;
        };
        let open_end = start + open_end_rel + 1;

        if tag == "meta" || tag == "link" || lower[start..open_end].trim_end().ends_with("/>") {
            pos = open_end;
            continue;
        }

        if let Some(close_rel) = lower[open_end..].find(&close) {
            pos = open_end + close_rel + close.len();
        } else {
            pos = open_end;
        }
    }

    out.push_str(&html[pos..]);
    out
}

fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let after_open = lower[start..].find('>')? + start + 1;
    let end = lower[after_open..].find("</title>")? + after_open;
    let title = decode_html_entities(&html[after_open..end]);
    let title = cleanup_whitespace(&title);
    (!title.is_empty()).then_some(title)
}

fn make_chunk(content: &str, offset: usize, chunk_size: usize) -> PageChunk {
    if offset >= content.len() {
        return PageChunk {
            content: String::new(),
            offset,
            chunk_size,
            next_offset: None,
            total_bytes: content.len(),
            truncated: false,
        };
    }

    let start = previous_char_boundary(content, offset);
    let requested_end = start.saturating_add(chunk_size).min(content.len());
    let end = previous_char_boundary(content, requested_end);
    let truncated = end < content.len();

    PageChunk {
        content: content[start..end].to_string(),
        offset: start,
        chunk_size,
        next_offset: truncated.then_some(end),
        total_bytes: content.len(),
        truncated,
    }
}

fn previous_char_boundary(s: &str, mut index: usize) -> usize {
    index = index.min(s.len());
    while index > 0 && !s.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn format_page_output(page: &FetchedPage, chunk: &PageChunk, include_metadata: bool) -> String {
    let mut out = String::new();
    if include_metadata {
        out.push_str(&format!("URL: {}\n", page.requested_url));
        out.push_str(&format!("Final URL: {}\n", page.final_url));
        if page.redirected {
            out.push_str("Warning: requested URL redirected; content is from Final URL.\n");
        }
        if page.http_error {
            out.push_str(
                "Warning: HTTP status is not successful; showing returned error page content.\n",
            );
        }
        out.push_str(&format!("Status: {} {}\n", page.status, page.status_text));
        if !page.content_type.is_empty() {
            out.push_str(&format!("Content-Type: {}\n", page.content_type));
        }
        if let Some(title) = &page.title {
            out.push_str(&format!("Title: {}\n", title));
        }
        out.push_str(&format!(
            "Source-Length: {}\n",
            format_bytes(page.source_bytes)
        ));
        out.push_str(&format!(
            "Chunk: offset {}, {} bytes of {}\n\n---\n\n",
            chunk.offset, chunk.chunk_size, chunk.total_bytes
        ));
    }

    if chunk.content.is_empty() {
        out.push_str("[empty chunk: offset is at or beyond the converted content length]");
    } else {
        out.push_str(&chunk.content);
    }

    if let Some(next_offset) = chunk.next_offset {
        out.push_str(&format!(
            "\n\n---\n[chunk truncated: next offset {}; converted content {} bytes]",
            next_offset, chunk.total_bytes
        ));
    }

    out
}

fn page_metadata(page: &FetchedPage, chunk: &PageChunk) -> serde_json::Value {
    json!({
        "url": &page.requested_url,
        "final_url": &page.final_url,
        "status": page.status,
        "status_text": &page.status_text,
        "content_type": &page.content_type,
        "title": &page.title,
        "source_bytes": page.source_bytes,
        "markdown_bytes": page.markdown_bytes,
        "redirected": page.redirected,
        "http_error": page.http_error,
        "offset": chunk.offset,
        "chunk_size": chunk.chunk_size,
        "next_offset": chunk.next_offset,
        "truncated": chunk.truncated
    })
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

    let out = decode_html_entities(&out);

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

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
}

fn cleanup_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cleanup_markdown(markdown: &str) -> String {
    let mut result = String::with_capacity(markdown.len());
    let mut consecutive_blank_lines = 0;

    for line in markdown.lines() {
        if line.trim().is_empty() {
            consecutive_blank_lines += 1;
            if consecutive_blank_lines <= 2 {
                result.push('\n');
            }
            continue;
        }

        consecutive_blank_lines = 0;
        result.push_str(line.trim_end());
        result.push('\n');
    }

    result.trim().to_string()
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

fn normalize_url_for_compare(url: &str) -> String {
    url.trim().trim_end_matches('/').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_domain_works() {
        assert_eq!(extract_domain("https://example.com/page"), "example.com");
        assert_eq!(extract_domain("http://foo.bar/baz/qux"), "foo.bar");
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

    #[test]
    fn html_to_markdown_preserves_basic_structure() {
        let html = r#"
            <html><body>
                <h1>API Reference</h1>
                <h2>Fields</h2>
                <ul><li>id</li><li>name</li></ul>
                <pre><code>curl https://example.com</code></pre>
                <table><tr><th>Name</th><th>Type</th></tr><tr><td>id</td><td>string</td></tr></table>
            </body></html>
        "#;

        let markdown = cleanup_markdown(&html_to_markdown(html));

        assert!(markdown.contains("API Reference"), "{markdown}");
        assert!(markdown.contains("=========="), "{markdown}");
        assert!(markdown.contains("Fields"), "{markdown}");
        assert!(markdown.contains("----------"), "{markdown}");
        assert!(markdown.contains("id"), "{markdown}");
        assert!(markdown.contains("name"), "{markdown}");
        assert!(markdown.contains("curl https://example.com"), "{markdown}");
        assert!(markdown.contains("Name"), "{markdown}");
        assert!(markdown.contains("Type"), "{markdown}");
    }

    #[test]
    fn extract_title_decodes_entities_and_whitespace() {
        let html = "<html><head><title>Tom &amp; Jerry\n Docs</title></head></html>";
        assert_eq!(extract_title(html), Some("Tom & Jerry Docs".to_string()));
    }

    #[test]
    fn make_chunk_returns_next_offset() {
        let content = "abcdef";
        let chunk = make_chunk(content, 0, 3);

        assert_eq!(chunk.content, "abc");
        assert_eq!(chunk.next_offset, Some(3));
        assert!(chunk.truncated);
    }

    #[test]
    fn make_chunk_respects_non_ascii_boundaries() {
        let content = "αβγδε";
        let chunk = make_chunk(content, 1, 5);

        assert!(content.is_char_boundary(chunk.offset));
        assert!(chunk.content.is_char_boundary(chunk.content.len()));
    }

    #[test]
    fn format_page_output_includes_metadata_and_continuation() {
        let page = FetchedPage {
            requested_url: "https://example.com/docs".to_string(),
            final_url: "https://example.com/docs/".to_string(),
            status: 200,
            status_text: "OK".to_string(),
            content_type: "text/html; charset=utf-8".to_string(),
            title: Some("Docs".to_string()),
            content: "abcdef".to_string(),
            source_bytes: 100,
            markdown_bytes: 6,
            redirected: true,
            http_error: false,
        };
        let chunk = make_chunk(&page.content, 0, 3);
        let output = format_page_output(&page, &chunk, true);

        assert!(output.contains("Final URL: https://example.com/docs/"));
        assert!(output.contains("Status: 200 OK"));
        assert!(output.contains("Content-Type: text/html; charset=utf-8"));
        assert!(output.contains("Title: Docs"));
        assert!(output.contains("requested URL redirected"));
        assert!(output.contains("next offset 3"));
    }

    #[test]
    fn format_page_output_marks_http_error_but_keeps_content() {
        let page = FetchedPage {
            requested_url: "https://example.com/missing".to_string(),
            final_url: "https://example.com/missing".to_string(),
            status: 404,
            status_text: "Not Found".to_string(),
            content_type: "text/html".to_string(),
            title: Some("Not Found".to_string()),
            content: "# Not Found\n\nThe page is missing.".to_string(),
            source_bytes: 128,
            markdown_bytes: 32,
            redirected: false,
            http_error: true,
        };
        let chunk = make_chunk(&page.content, 0, 2000);
        let output = format_page_output(&page, &chunk, true);

        assert!(output.contains("Status: 404 Not Found"), "{output}");
        assert!(output.contains("HTTP status is not successful"), "{output}");
        assert!(output.contains("The page is missing."), "{output}");
    }

    #[test]
    fn extract_readable_html_removes_script_style_and_json_noise() {
        let html = r#"
            <html>
                <head>
                    <style>.hidden { display: none; }</style>
                    <script type="application/ld+json">{"name":"Noise"}</script>
                    <script>window.digitalData = { page: "noise" };</script>
                </head>
                <body>
                    <main>
                        <h1>Product Specs</h1>
                        <table><tr><th>Name</th><th>Value</th></tr><tr><td>Battery</td><td>10 days</td></tr></table>
                        <p>This readable product specification content is long enough to be selected.</p>
                    </main>
                </body>
            </html>
        "#;

        let readable = extract_readable_html(html);
        let markdown = cleanup_markdown(&html_to_markdown(&readable));

        assert!(markdown.contains("Product Specs"), "{markdown}");
        assert!(markdown.contains("Battery"), "{markdown}");
        assert!(markdown.contains("10 days"), "{markdown}");
        assert!(!markdown.contains("window.digitalData"), "{markdown}");
        assert!(!markdown.contains("display: none"), "{markdown}");
        assert!(!markdown.contains("Noise"), "{markdown}");
    }

    #[test]
    fn extract_readable_html_prefers_main_over_navigation() {
        let html = r#"
            <html><body>
                <nav><a>Home</a><a>Products</a><a>Support</a></nav>
                <main><h1>Real Article</h1><p>This is the actual page body with enough readable text for extraction.</p></main>
            </body></html>
        "#;

        let readable = extract_readable_html(html);

        assert!(readable.contains("Real Article"), "{readable}");
        assert!(!readable.contains("Support"), "{readable}");
    }

    #[test]
    fn extract_readable_html_keeps_full_body_when_no_main_exists() {
        let html = r#"
            <html><body>
                <div class="toc">Table of contents</div>
                <section id="middle-specs">Middle section that should not become the only returned content.</section>
                <section id="end">Final section should still be present in fallback body extraction.</section>
            </body></html>
        "#;

        let readable = extract_readable_html(html);

        assert!(readable.contains("Table of contents"), "{readable}");
        assert!(readable.contains("Middle section"), "{readable}");
        assert!(readable.contains("Final section"), "{readable}");
    }

    #[test]
    fn make_chunk_uses_requested_size_per_page() {
        let content = "a".repeat(25_000);
        let chunk = make_chunk(&content, 0, 20_000);

        assert_eq!(chunk.content.len(), 20_000);
        assert_eq!(chunk.next_offset, Some(20_000));
    }

    #[test]
    fn strip_html_tag_handles_self_closing_and_paired_tags() {
        let html = r#"<html><head><meta name="x"><link href="x"><script>bad()</script></head><body>Good</body></html>"#;
        let cleaned = strip_noise_html(html);

        assert!(cleaned.contains("Good"), "{cleaned}");
        assert!(!cleaned.contains("bad()"), "{cleaned}");
        assert!(!cleaned.contains("<meta"), "{cleaned}");
        assert!(!cleaned.contains("<link"), "{cleaned}");
    }
}
