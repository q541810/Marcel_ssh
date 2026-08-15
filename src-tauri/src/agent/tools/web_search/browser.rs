//! Bing search via shared local headless browser CDP.

use crate::agent::tools::browser_cdp;
use crate::config::settings::WebSearchEndpoint;
use crate::error::AppError;

use super::parse::{looks_like_challenge_page, parse_bing_results};
use super::types::SearchOutcome;

pub async fn search(
    endpoint: WebSearchEndpoint,
    query: &str,
    max_results: usize,
) -> Result<SearchOutcome, AppError> {
    let html = browser_cdp::fetch_bing_search_html(endpoint, query).await?;
    outcome_from_browser_html(&html, max_results)
}

/// Shared browser HTML → SearchOutcome path (unit-testable without CDP).
pub fn outcome_from_browser_html(html: &str, max_results: usize) -> Result<SearchOutcome, AppError> {
    if looks_like_challenge_page(html) {
        return Err(AppError::Agent(
            "browser search hit a challenge/captcha page; try again later or use search API mode"
                .into(),
        ));
    }

    let results = parse_bing_results(html, max_results);
    Ok(SearchOutcome {
        provider: "browser",
        results,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::settings::WebSearchEndpoint;

    #[test]
    fn browser_mode_parses_fixture_as_provider_browser() {
        let html = r#"
        <html><body>
          <li class="b_algo">
            <h2><a href="https://example.com/rust">Rust Guide</a></h2>
            <div class="b_caption"><p>Learn Rust</p></div>
          </li>
        </body></html>
        "#;
        let out = outcome_from_browser_html(html, 5).expect("ok");
        assert_eq!(out.provider, "browser");
        assert_eq!(out.results.len(), 1);
        assert_eq!(out.results[0].title, "Rust Guide");
    }

    #[test]
    fn browser_mode_rejects_challenge() {
        let html = r#"<html><body>captcha PoWChallenge arkoselabs</body></html>"#;
        let err = outcome_from_browser_html(html, 5).expect_err("challenge");
        assert!(err.to_string().contains("challenge") || err.to_string().contains("captcha"));
    }

    #[test]
    fn browser_mode_empty_results() {
        let out = outcome_from_browser_html("<html></html>", 3).expect("ok");
        assert_eq!(out.provider, "browser");
        assert!(out.results.is_empty());
    }

    /// Optional live CDP smoke test — ignored by default (needs Chrome/Edge + network).
    #[tokio::test]
    #[ignore = "live browser + Bing; run with --ignored when available"]
    async fn browser_mode_live_search_smoke() {
        let out = search(WebSearchEndpoint::Cn, "tokio rust runtime", 3)
            .await
            .expect("browser search");
        assert_eq!(out.provider, "browser");
        let _ = out.results;
    }
}