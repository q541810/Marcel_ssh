//! `web_search` — search the internet via configurable providers.
//!
//! Modes (settings → experimentalSettings.webSearchMode):
//! - `browser` (default): local headless Chrome/Edge via CDP
//! - `api`: Brave / Tavily search HTTP APIs
//! - `html`: bare Bing HTML scrape
//!
//! Does NOT return full page content — use `http_get` for that.
//!
//! Two rules keep a failed search diagnosable, because both were previously
//! invisible:
//!
//! - **An empty result list is not automatically "no results".** A verification
//!   interstitial or an unrelated document is reported as an
//!   [`Interception`] and fails the tool, instead of silently claiming the query
//!   had no hits.
//! - **A failed browser attempt is retried once, then served by the HTML
//!   backend**, with the degradation stated in the summary and metadata so it is
//!   never mistaken for the requested path.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;
use tauri::Manager;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::web_result::{detect_challenge, FallbackNote};
use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::config::keychain;
use crate::config::settings::{WebSearchApiProvider, WebSearchEndpoint, WebSearchMode};
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

use types::{Interception, SearchOutcome, SearchResult};

pub(crate) const BROWSER_PROVIDER: &str = "browser";
pub(crate) const HTML_PROVIDER: &str = "html";

const MAX_RESULTS: usize = 8;
const MAX_OUTPUT_BYTES: usize = 16_000;
const SEARCH_TIP: &str =
    "\nTip: Use the `http_get` tool with any URL above to read the full page content.";

/// Hard cap on a single browser attempt.
///
/// The per-step timeouts inside `browser_cdp` bound a *healthy* session, but a
/// wedged Chromium could otherwise keep the agent waiting through every step in
/// sequence. Capping the attempt guarantees the retry and the fallback get a
/// turn in bounded time.
const BROWSER_ATTEMPT_BUDGET: Duration = Duration::from_secs(45);
/// Cap on the fallback attempt. The HTML backend already has a 15s HTTP timeout.
const HTML_ATTEMPT_BUDGET: Duration = Duration::from_secs(25);
const RETRY_BACKOFF: Duration = Duration::from_millis(300);

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
         本机浏览器方式失败时会自动重试一次，仍失败则降级为裸抓 HTML，降级情况会在结果中明确说明。 \
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

        let (mode, api_provider, endpoint) = resolve_search_config(ctx).await;

        match run_search(mode, api_provider, endpoint, &query, max_results).await {
            Ok(attempt) => Ok(format_outcome(&query, mode, attempt)),
            Err(message) => Ok(ToolOutput::fail(
                format!("web_search '{}'", query),
                format!("search failed (mode={:?}): {}", mode, message),
            )),
        }
    }
}

/// One search that produced an answer, plus how it was obtained.
#[derive(Debug)]
struct SearchAttempt {
    outcome: SearchOutcome,
    /// Set when the configured backend failed and another one answered.
    fallback: Option<FallbackNote>,
    /// What was tried, in order — the trail that makes a failure diagnosable.
    attempts: Vec<String>,
}

impl SearchAttempt {
    fn direct(outcome: SearchOutcome) -> Self {
        Self {
            outcome,
            fallback: None,
            attempts: Vec::new(),
        }
    }
}

async fn resolve_search_config(
    ctx: &ToolContext,
) -> (WebSearchMode, WebSearchApiProvider, WebSearchEndpoint) {
    // Mobile (Android) 无法启动本地 Chrome/Edge 走 CDP：Browser 模式必然失败，
    // 因此按用户设置解析后把 Browser 降级为裸 Bing HTML 抓取（html）模式；
    // Api 模式（Brave/Tavily 纯 HTTP）在手机上完全可用，直接生效。
    #[cfg(mobile)]
    {
        if let Some(state) = ctx.app_handle.try_state::<crate::AppState>() {
            let settings = state.settings.read().await;
            let exp = &settings.experimental_settings;
            let mode = match exp.web_search_mode {
                WebSearchMode::Browser => WebSearchMode::Html,
                mode => mode,
            };
            return (mode, exp.web_search_api_provider, exp.web_search_endpoint);
        }
        (
            WebSearchMode::Html,
            WebSearchApiProvider::default(),
            WebSearchEndpoint::default(),
        )
    }

    #[cfg(desktop)]
    {
        // Prefer live app settings when available.
        if let Some(state) = ctx.app_handle.try_state::<crate::AppState>() {
            let settings = state.settings.read().await;
            let exp = &settings.experimental_settings;
            return (
                exp.web_search_mode,
                exp.web_search_api_provider,
                exp.web_search_endpoint,
            );
        }
        (
            WebSearchMode::default(),
            WebSearchApiProvider::default(),
            WebSearchEndpoint::default(),
        )
    }
}

async fn run_search(
    mode: WebSearchMode,
    api_provider: WebSearchApiProvider,
    endpoint: WebSearchEndpoint,
    query: &str,
    max_results: usize,
) -> Result<SearchAttempt, String> {
    match mode {
        WebSearchMode::Browser => run_browser_search(endpoint, query, max_results).await,
        WebSearchMode::Html => html::search(endpoint, query, max_results)
            .await
            .map(SearchAttempt::direct)
            .map_err(|e| e.to_string()),
        WebSearchMode::Api => {
            let key = keychain::get_web_search_api_key()
                .map_err(|e| e.to_string())?
                .unwrap_or_default();
            api::search(api_provider, &key, query, max_results)
                .await
                .map(SearchAttempt::direct)
                .map_err(|e| e.to_string())
        }
    }
}

/// Browser search with one bounded retry, then an HTML fallback.
///
/// The order of preference is deliberate: the browser is the highest-quality
/// backend, so it gets a second chance after a transient infrastructure fault,
/// and only then does the cheap stateless scraper take over.
async fn run_browser_search(
    endpoint: WebSearchEndpoint,
    query: &str,
    max_results: usize,
) -> Result<SearchAttempt, String> {
    let mut attempts: Vec<String> = Vec::new();
    let mut last_failure: Option<String> = None;

    for attempt in 1..=2usize {
        let result = tokio::time::timeout(
            BROWSER_ATTEMPT_BUDGET,
            browser::search(endpoint, query, max_results),
        )
        .await;

        match result {
            Ok(Ok(outcome)) => {
                return Ok(SearchAttempt {
                    outcome,
                    fallback: None,
                    attempts,
                })
            }
            Ok(Err(failure)) => {
                attempts.push(format!(
                    "browser attempt {} failed ({}) : {}",
                    attempt,
                    failure.stage.label(),
                    failure.message
                ));
                let retryable = failure.retryable();
                last_failure = Some(failure.to_string());
                if !retryable {
                    // A navigation that failed did so for a reason; a different
                    // backend is a better use of the remaining time than a
                    // repeat of the same request.
                    break;
                }
            }
            Err(_elapsed) => {
                attempts.push(format!(
                    "browser attempt {} exceeded its {:.0}s budget",
                    attempt,
                    BROWSER_ATTEMPT_BUDGET.as_secs_f32()
                ));
                last_failure = Some("browser attempt exceeded its time budget".to_string());
                // The budget is already spent; retrying would only double it.
                break;
            }
        }

        if attempt == 1 {
            tokio::time::sleep(RETRY_BACKOFF).await;
        }
    }

    let reason = last_failure.unwrap_or_else(|| "browser search failed".to_string());

    match tokio::time::timeout(
        HTML_ATTEMPT_BUDGET,
        html::search(endpoint, query, max_results),
    )
    .await
    {
        Ok(Ok(outcome)) => {
            attempts.push("fell back to the html backend".to_string());
            Ok(SearchAttempt {
                outcome,
                fallback: Some(FallbackNote::new(BROWSER_PROVIDER, HTML_PROVIDER, reason)),
                attempts,
            })
        }
        Ok(Err(e)) => {
            attempts.push(format!("html fallback failed: {}", e));
            Err(join_attempts(&attempts))
        }
        Err(_) => {
            attempts.push(format!(
                "html fallback exceeded its {:.0}s budget",
                HTML_ATTEMPT_BUDGET.as_secs_f32()
            ));
            Err(join_attempts(&attempts))
        }
    }
}

fn join_attempts(attempts: &[String]) -> String {
    if attempts.is_empty() {
        "no backend produced a result".to_string()
    } else {
        attempts.join("; ")
    }
}

/// Decide whether an empty result list means "no hits" or "not a results page".
///
/// Parsed results always win. Otherwise the page is checked for a verification
/// interstitial, and only a page carrying a real results-page marker is accepted
/// as a genuine zero-hit answer — anything else is reported as an interception
/// rather than dressed up as "no results found".
pub(crate) fn classify_empty_results(
    results: &[SearchResult],
    html: &str,
    title: Option<&str>,
    looks_like_serp: bool,
    describe_page: impl FnOnce() -> String,
) -> Option<Interception> {
    if !results.is_empty() {
        return None;
    }
    if let Some(challenge) = detect_challenge(html, title) {
        return Some(Interception::Challenge {
            vendor: challenge.vendor,
        });
    }
    if looks_like_serp {
        return None;
    }
    Some(Interception::NotAResultsPage {
        detail: describe_page(),
    })
}

fn format_outcome(
    query: &str,
    requested_mode: WebSearchMode,
    attempt: SearchAttempt,
) -> ToolOutput {
    let SearchAttempt {
        outcome,
        fallback,
        attempts,
    } = attempt;
    let SearchOutcome {
        provider,
        results,
        interception,
    } = outcome;

    let fallback_suffix = fallback
        .as_ref()
        .map(FallbackNote::summary_suffix)
        .unwrap_or_default();
    let mut metadata = json!({
        "provider": provider,
        "requested_mode": mode_label(requested_mode),
        "queries": 1,
        "total_results": results.len(),
        "results": search_result_metadata(query, &results),
    });
    let map = metadata.as_object_mut().expect("object literal");

    if let Some(note) = &fallback {
        map.insert("fallback".to_string(), note.to_json());
    }
    if let Some(interception) = &interception {
        map.insert("interception".to_string(), interception.to_json());
    }
    if !attempts.is_empty() {
        map.insert("attempts".to_string(), json!(attempts));
    }

    // An interception is a failed search: reporting it as success is what made
    // a blocked query look like "no results found".
    if let Some(interception) = &interception {
        map.insert("success".to_string(), json!(0));
        map.insert("failed".to_string(), json!(1));
        let detail = interception.describe();
        let hint = match interception {
            Interception::Challenge { .. } => {
                "The search engine blocked this request. Retrying the same query usually \
                 does not help — switch Settings → 联网搜索方式 to the search API mode, or \
                 try again later."
            }
            Interception::NotAResultsPage { .. } => {
                "The request did not reach a Bing results page. Check the network or proxy \
                 settings, then retry; the search API mode is unaffected by this."
            }
        };
        return ToolOutput::fail(
            format!(
                "web_search '{}' blocked via {}{}",
                query, provider, fallback_suffix
            ),
            format!(
                "## Query: {}\n\n⚠ {}\n\n{}\n\nAttempts: {}",
                query,
                detail,
                hint,
                join_attempts(&attempts)
            ),
        )
        .with_metadata(metadata);
    }

    map.insert(
        "success".to_string(),
        json!(if results.is_empty() { 0 } else { 1 }),
    );
    map.insert("failed".to_string(), json!(0));

    if results.is_empty() {
        return ToolOutput::ok(
            format!(
                "web_search '{}' (0 results via {}){}",
                query, provider, fallback_suffix
            ),
            format!(
                "## Query: {}\n\nNo results found — the search engine returned a results \
                 page with no hits for this query.\n{}",
                query, SEARCH_TIP
            ),
        )
        .with_metadata(metadata);
    }

    let section = format_results_for_query(query, &results);
    let output = truncate_output(format!("{}{}", section, SEARCH_TIP), MAX_OUTPUT_BYTES);

    ToolOutput::ok(
        format!(
            "web_search '{}' ({} results via {}){}",
            query,
            results.len(),
            provider,
            fallback_suffix
        ),
        output,
    )
    .with_metadata(metadata)
}

fn mode_label(mode: WebSearchMode) -> &'static str {
    match mode {
        WebSearchMode::Browser => BROWSER_PROVIDER,
        WebSearchMode::Html => HTML_PROVIDER,
        WebSearchMode::Api => "api",
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
    use crate::config::settings::WebSearchEndpoint;

    fn result(title: &str) -> SearchResult {
        SearchResult {
            title: title.to_string(),
            url: "https://example.com/".to_string(),
            snippet: "s".to_string(),
        }
    }

    fn attempt(outcome: SearchOutcome) -> SearchAttempt {
        SearchAttempt::direct(outcome)
    }

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
            WebSearchMode::Browser,
            attempt(SearchOutcome {
                provider: BROWSER_PROVIDER,
                results: vec![result("T")],
                interception: None,
            }),
        );
        assert!(out.success);
        assert!(out.summary.contains("browser"));
        let meta = out.metadata.unwrap();
        assert_eq!(meta["provider"], "browser");
        assert_eq!(meta["requested_mode"], "browser");
        assert_eq!(meta["total_results"], 1);
        assert!(meta.get("fallback").is_none());
    }

    /// A genuine zero-hit SERP still reads as a successful search.
    #[test]
    fn format_outcome_reports_a_real_zero_result_search_as_success() {
        let out = format_outcome(
            "empty",
            WebSearchMode::Html,
            attempt(SearchOutcome {
                provider: HTML_PROVIDER,
                results: vec![],
                interception: None,
            }),
        );
        assert!(out.success);
        assert!(out.summary.contains("0 results"));
        assert!(out.summary.contains("html"));
        let meta = out.metadata.unwrap();
        assert_eq!(meta["provider"], "html");
        assert_eq!(meta["total_results"], 0);
        assert_eq!(meta["success"], 0);
        assert_eq!(meta["failed"], 0);
    }

    /// The regression that started this: a blocked search must not read as
    /// "No results found".
    #[test]
    fn format_outcome_fails_and_explains_an_intercepted_search() {
        let out = format_outcome(
            "绝区零",
            WebSearchMode::Browser,
            attempt(SearchOutcome {
                provider: BROWSER_PROVIDER,
                results: vec![],
                interception: Some(Interception::Challenge {
                    vendor: "百度安全验证",
                }),
            }),
        );

        assert!(
            !out.success,
            "an interception must not be reported as success"
        );
        assert!(out.summary.contains("blocked"), "{}", out.summary);
        assert!(out.output.contains("百度安全验证"), "{}", out.output);
        assert!(
            !out.output.contains("No results found"),
            "a blocked search must not claim the query had no hits: {}",
            out.output
        );
        assert!(
            out.output.contains("联网搜索方式"),
            "the hint must point at the actual setting: {}",
            out.output
        );
        let meta = out.metadata.unwrap();
        assert_eq!(meta["interception"]["kind"], "challenge");
        assert_eq!(meta["interception"]["vendor"], "百度安全验证");
        assert_eq!(meta["failed"], 1);
    }

    #[test]
    fn format_outcome_reports_a_not_a_results_page_interception() {
        let out = format_outcome(
            "x",
            WebSearchMode::Html,
            attempt(SearchOutcome {
                provider: HTML_PROVIDER,
                results: vec![],
                interception: Some(Interception::NotAResultsPage {
                    detail: "title=\"Oops\" bytes=12".to_string(),
                }),
            }),
        );
        assert!(!out.success);
        assert!(out.output.contains("not a results page"), "{}", out.output);
        let meta = out.metadata.unwrap();
        assert_eq!(meta["interception"]["kind"], "not-a-results-page");
    }

    /// A degraded result must announce itself, in both the summary and metadata.
    #[test]
    fn format_outcome_states_a_fallback_loudly() {
        let out = format_outcome(
            "q",
            WebSearchMode::Browser,
            SearchAttempt {
                outcome: SearchOutcome {
                    provider: HTML_PROVIDER,
                    results: vec![result("T")],
                    interception: None,
                },
                fallback: Some(FallbackNote::new(
                    BROWSER_PROVIDER,
                    HTML_PROVIDER,
                    "browser boot: CDP endpoint did not become ready within 12s",
                )),
                attempts: vec!["browser attempt 1 failed (boot): timed out".to_string()],
            },
        );

        assert!(out.success, "a degraded-but-served search still succeeds");
        assert!(out.summary.contains("fell back to html"), "{}", out.summary);
        assert!(out.summary.contains("browser failed"), "{}", out.summary);
        let meta = out.metadata.unwrap();
        assert_eq!(meta["provider"], "html");
        assert_eq!(meta["requested_mode"], "browser");
        assert_eq!(meta["fallback"]["from"], "browser");
        assert_eq!(meta["fallback"]["to"], "html");
        assert!(meta["fallback"]["reason"]
            .as_str()
            .unwrap()
            .contains("boot"));
        assert_eq!(meta["attempts"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn classify_empty_accepts_a_real_serp_with_no_hits() {
        let html =
            r#"<html><body><ol id="b_results"><li class="b_no">没有结果</li></ol></body></html>"#;
        assert!(classify_empty_results(&[], html, Some("zzz"), true, || "d".into()).is_none());
    }

    #[test]
    fn classify_empty_prefers_results_over_markers() {
        let html = r#"<html><body>captcha</body></html>"#;
        assert!(
            classify_empty_results(&[result("T")], html, None, false, || "d".into()).is_none(),
            "parsed results must win over a stray marker"
        );
    }

    #[test]
    fn missing_query_fails_cleanly() {
        // execute needs AppHandle; validate parameter path via schema + normalize only.
        assert!(normalize_query("   ").is_empty());
        assert!(normalize_query("\u{200B}\u{200C}").is_empty());
    }

    #[test]
    fn web_search_mode_dispatch_labels() {
        assert_eq!(
            format!("{:?}", WebSearchMode::Browser).to_ascii_lowercase(),
            "browser"
        );
        assert_eq!(
            format!("{:?}", WebSearchMode::Html).to_ascii_lowercase(),
            "html"
        );
        assert_eq!(
            format!("{:?}", WebSearchMode::Api).to_ascii_lowercase(),
            "api"
        );
    }

    #[test]
    fn every_web_search_mode_produces_distinct_provider_label() {
        let fixture = r#"
        <html><body>
          <ol id="b_results">
          <li class="b_algo">
            <h2><a href="https://example.com/x">X</a></h2>
            <div class="b_caption"><p>snippet</p></div>
          </li>
          </ol>
        </body></html>
        "#;

        let html_outcome = html::outcome_from_html(fixture, 5);
        assert_eq!(html_outcome.provider, "html");
        assert_eq!(html_outcome.results.len(), 1);

        let serp = crate::agent::tools::browser_cdp::BingSerp {
            html: fixture.to_string(),
            facts: crate::agent::tools::browser_cdp::PageFacts {
                href: "https://cn.bing.com/search?q=x".into(),
                ready_state: "complete".into(),
                response_status: Some(200),
                title: Some("x".into()),
            },
            found_result_container: true,
        };
        let browser_outcome = browser::outcome_from_serp(&serp, 5);
        assert_eq!(browser_outcome.provider, "browser");
        assert_eq!(browser_outcome.results.len(), 1);

        // API modes: mapping layer produces api:brave / api:tavily labels.
        for provider in ["browser", "html", "api:brave", "api:tavily"] {
            let out = format_outcome(
                "q",
                WebSearchMode::Api,
                attempt(SearchOutcome {
                    provider,
                    results: vec![result("T")],
                    interception: None,
                }),
            );
            assert!(out.success, "{provider}");
            assert!(
                out.summary.contains(provider),
                "{provider}: {}",
                out.summary
            );
            assert_eq!(out.metadata.as_ref().unwrap()["provider"], provider);
        }
    }

    /// Providers must stay distinguishable so a degraded result is never
    /// mistaken for the requested mode.
    #[test]
    fn requested_mode_is_recorded_separately_from_the_serving_provider() {
        let out = format_outcome(
            "q",
            WebSearchMode::Api,
            attempt(SearchOutcome {
                provider: HTML_PROVIDER,
                results: vec![result("T")],
                interception: None,
            }),
        );
        let meta = out.metadata.unwrap();
        assert_eq!(meta["requested_mode"], "api");
        assert_eq!(meta["provider"], "html");
    }

    #[tokio::test]
    #[ignore = "依赖本机 keychain 为空；本机已存 Key 时会发真实网络请求。空 Key 报错行为由 api.rs 的 api_brave_mode_requires_key / api_tavily_mode_requires_key 确定性覆盖"]
    async fn run_search_api_mode_fails_without_key() {
        let err = run_search(
            WebSearchMode::Api,
            WebSearchApiProvider::Brave,
            WebSearchEndpoint::Cn,
            "q",
            3,
        )
        .await
        .expect_err("no key");
        let msg = err.to_ascii_lowercase();
        assert!(msg.contains("key"), "{msg}");
    }
}
