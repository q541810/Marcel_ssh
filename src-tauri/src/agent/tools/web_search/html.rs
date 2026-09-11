//! Bing HTML scrape provider (no browser, no API key).

use reqwest::Client;
use std::time::Duration;

use crate::agent::tools::browser_cdp::bing_search_url;
use crate::config::settings::WebSearchEndpoint;
use crate::error::AppError;

use super::types::SearchOutcome;
use super::{classify_empty_results, parse, HTML_PROVIDER};

const TIMEOUT_SECS: u64 = 15;

pub async fn search(
    endpoint: WebSearchEndpoint,
    query: &str,
    max_results: usize,
) -> Result<SearchOutcome, AppError> {
    let client = Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Agent(format!("failed to create HTTP client: {}", e)))?;

    let resp = client
        .get(bing_search_url(endpoint, query))
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        )
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .header("Upgrade-Insecure-Requests", "1")
        .header("Sec-Fetch-Dest", "document")
        .header("Sec-Fetch-Mode", "navigate")
        .header("Sec-Fetch-Site", "none")
        .header("Sec-Fetch-User", "?1")
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

    Ok(outcome_from_html(&html, max_results))
}

/// Shared HTML → SearchOutcome path used by the html mode (and unit tests).
pub fn outcome_from_html(html: &str, max_results: usize) -> SearchOutcome {
    let results = parse::parse_bing_results(html, max_results);
    let title = parse::extract_title(html);
    let interception = classify_empty_results(
        &results,
        html,
        title.as_deref(),
        parse::looks_like_results_page(html),
        || {
            format!(
                "title={:?} bytes={} (scraped without a browser)",
                title.as_deref().unwrap_or("(no title)"),
                html.len()
            )
        },
    );

    SearchOutcome {
        provider: HTML_PROVIDER,
        results,
        interception,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tools::web_search::types::Interception;
    use crate::config::settings::WebSearchEndpoint;

    #[test]
    fn search_url_uses_configured_endpoint() {
        assert_eq!(
            bing_search_url(WebSearchEndpoint::Cn, "绝区零 hello"),
            "https://cn.bing.com/search?q=%E7%BB%9D%E5%8C%BA%E9%9B%B6%20hello"
        );
        assert_eq!(
            bing_search_url(WebSearchEndpoint::Www, "tokio"),
            "https://www.bing.com/search?q=tokio"
        );
    }

    #[test]
    fn html_mode_parses_fixture_serp() {
        let html = r#"
        <html><body>
          <ol id="b_results">
          <li class="b_algo">
            <h2><a href="https://tokio.rs/">Tokio</a></h2>
            <div class="b_caption"><p>Async runtime</p></div>
          </li>
          </ol>
        </body></html>
        "#;
        let out = outcome_from_html(html, 8);
        assert_eq!(out.provider, "html");
        assert_eq!(out.results.len(), 1);
        assert_eq!(out.results[0].title, "Tokio");
        assert_eq!(out.results[0].url, "https://tokio.rs/");
        assert!(out.interception.is_none());
    }

    #[test]
    fn html_mode_reports_a_challenge_instead_of_silence() {
        let html = r#"<html><head><title>百度安全验证</title></head><body></body></html>"#;
        let out = outcome_from_html(html, 5);
        match out.interception {
            Some(Interception::Challenge { vendor }) => assert_eq!(vendor, "百度安全验证"),
            other => panic!("expected a challenge, got {:?}", other),
        }
    }

    #[test]
    fn html_mode_empty_results_is_not_an_interception_when_the_serp_rendered() {
        let out = outcome_from_html(r#"<html><body><ol id="b_results"></ol></body></html>"#, 5);
        assert_eq!(out.provider, "html");
        assert!(out.results.is_empty());
        assert!(
            out.interception.is_none(),
            "a rendered SERP with no hits is a real zero-result answer"
        );
    }

    #[test]
    fn html_mode_flags_a_document_that_is_not_a_results_page() {
        let out = outcome_from_html("<html><body>no hits</body></html>", 5);
        match out.interception {
            Some(Interception::NotAResultsPage { .. }) => {}
            other => panic!("expected not-a-results-page, got {:?}", other),
        }
    }
}
