//! Bing HTML scrape provider (no browser, no API key).

use reqwest::Client;
use std::time::Duration;

use crate::config::settings::WebSearchEndpoint;
use crate::error::AppError;

use super::parse::{looks_like_challenge_page, parse_bing_results};
use super::types::{SearchOutcome, SearchResult};
use super::urlencoding;

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

    let url = search_url(endpoint, query);

    let resp = client
        .get(&url)
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

    outcome_from_html(&html, max_results)
}

/// Build the Bing SERP URL for the configured endpoint.
pub fn search_url(endpoint: WebSearchEndpoint, query: &str) -> String {
    let host = match endpoint {
        WebSearchEndpoint::Cn => "https://cn.bing.com",
        WebSearchEndpoint::Www => "https://www.bing.com",
    };
    format!("{}/search?q={}", host, urlencoding::encode(query))
}

/// Shared HTML → SearchOutcome path used by the html mode (and unit tests).
pub fn outcome_from_html(html: &str, max_results: usize) -> Result<SearchOutcome, AppError> {
    if looks_like_challenge_page(html) {
        return Err(AppError::Agent(
            "Bing returned a challenge page to the HTML scraper; switch search mode to browser or API"
                .into(),
        ));
    }

    let results: Vec<SearchResult> = parse_bing_results(html, max_results);
    Ok(SearchOutcome {
        provider: "html",
        results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::settings::WebSearchEndpoint;

    #[test]
    fn search_url_uses_configured_endpoint() {
        let url = search_url(WebSearchEndpoint::Cn, "绝区零 hello");
        assert_eq!(
            url,
            "https://cn.bing.com/search?q=%E7%BB%9D%E5%8C%BA%E9%9B%B6%20hello"
        );

        let url = search_url(WebSearchEndpoint::Www, "tokio");
        assert_eq!(url, "https://www.bing.com/search?q=tokio");
    }

    #[test]
    fn html_mode_parses_fixture_serp() {
        let html = r#"
        <html><body>
          <li class="b_algo">
            <h2><a href="https://tokio.rs/">Tokio</a></h2>
            <div class="b_caption"><p>Async runtime</p></div>
          </li>
        </body></html>
        "#;
        let out = outcome_from_html(html, 8).expect("parse");
        assert_eq!(out.provider, "html");
        assert_eq!(out.results.len(), 1);
        assert_eq!(out.results[0].title, "Tokio");
        assert_eq!(out.results[0].url, "https://tokio.rs/");
    }

    #[test]
    fn html_mode_rejects_challenge_page() {
        let html = r#"<html><body><div class="captcha">PoWChallenge arkoselabs</div></body></html>"#;
        let err = outcome_from_html(html, 5).expect_err("challenge");
        assert!(err.to_string().contains("challenge"));
    }

    #[test]
    fn html_mode_empty_results_is_ok() {
        let out = outcome_from_html("<html><body>no hits</body></html>", 5).expect("ok");
        assert_eq!(out.provider, "html");
        assert!(out.results.is_empty());
    }
}