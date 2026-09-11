//! Bing search via the shared local headless browser CDP session.

use crate::agent::tools::browser_cdp;
use crate::agent::tools::browser_cdp::CdpFailure;
use crate::config::settings::WebSearchEndpoint;

use super::types::SearchOutcome;
use super::{classify_empty_results, parse, BROWSER_PROVIDER};

pub async fn search(
    endpoint: WebSearchEndpoint,
    query: &str,
    max_results: usize,
) -> Result<SearchOutcome, CdpFailure> {
    let serp = browser_cdp::fetch_bing_serp(endpoint, query).await?;
    Ok(outcome_from_serp(&serp, max_results))
}

/// Browser SERP → `SearchOutcome`. Pure, so the classification rules are
/// testable without a browser.
pub fn outcome_from_serp(serp: &browser_cdp::BingSerp, max_results: usize) -> SearchOutcome {
    let results = parse::parse_bing_results(&serp.html, max_results);
    // Either signal is enough to prove Bing served a results page: the result
    // container appearing in the DOM, or the SERP markers being present. A
    // genuine zero-hit page has markers but no result items, so requiring the
    // container alone would misreport it as "not a results page".
    let is_results_page = serp.found_result_container || parse::looks_like_results_page(&serp.html);
    let interception = classify_empty_results(
        &results,
        &serp.html,
        serp.facts.title.as_deref(),
        is_results_page,
        || describe_serp(serp),
    );

    SearchOutcome {
        provider: BROWSER_PROVIDER,
        results,
        interception,
    }
}

/// Human-readable description of the page the browser actually landed on, used
/// only when the page was not a results page.
fn describe_serp(serp: &browser_cdp::BingSerp) -> String {
    let status = match serp.facts.response_status {
        Some(code) => code.to_string(),
        None => "no HTTP response".to_string(),
    };
    let title = serp
        .facts
        .title
        .as_deref()
        .filter(|t| !t.is_empty())
        .unwrap_or("(no title)");
    format!(
        "href={} title={:?} status={} bytes={}",
        if serp.facts.href.is_empty() {
            "?"
        } else {
            &serp.facts.href
        },
        title,
        status,
        serp.html.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tools::browser_cdp::PageFacts;

    fn serp(html: &str, title: Option<&str>, found_container: bool) -> browser_cdp::BingSerp {
        browser_cdp::BingSerp {
            html: html.to_string(),
            facts: PageFacts {
                href: "https://cn.bing.com/search?q=x".to_string(),
                ready_state: "complete".to_string(),
                response_status: Some(200),
                title: title.map(str::to_string),
            },
            found_result_container: found_container,
        }
    }

    #[test]
    fn browser_mode_parses_fixture_as_provider_browser() {
        let html = r#"
        <html><body>
          <ol id="b_results">
          <li class="b_algo">
            <h2><a href="https://example.com/rust">Rust Guide</a></h2>
            <div class="b_caption"><p>Learn Rust</p></div>
          </li>
          </ol>
        </body></html>
        "#;
        let out = outcome_from_serp(&serp(html, Some("rust"), true), 5);
        assert_eq!(out.provider, "browser");
        assert_eq!(out.results.len(), 1);
        assert_eq!(out.results[0].title, "Rust Guide");
        assert!(out.interception.is_none());
    }

    /// A verification interstitial must never be reported as "no results".
    #[test]
    fn browser_mode_reports_a_challenge_instead_of_zero_results() {
        let html = r#"<html><head><title>百度安全验证</title></head><body></body></html>"#;
        let out = outcome_from_serp(&serp(html, Some("百度安全验证"), false), 5);
        assert!(out.results.is_empty());
        match out.interception {
            Some(super::super::types::Interception::Challenge { vendor }) => {
                assert_eq!(vendor, "百度安全验证")
            }
            other => panic!("expected a challenge, got {:?}", other),
        }
    }

    /// A genuine zero-hit SERP is still a valid answer, not an interception.
    #[test]
    fn browser_mode_keeps_a_genuine_no_results_page_as_zero_results() {
        let html = r#"<html><body><ol id="b_results"><li class="b_no">没有与此相关的结果</li></ol></body></html>"#;
        let out = outcome_from_serp(&serp(html, Some("zzzz"), false), 5);
        assert!(out.results.is_empty());
        assert!(
            out.interception.is_none(),
            "a real 'no results' page is not an interception: {:?}",
            out.interception
        );
    }

    /// A document that is neither results nor a challenge must be called out.
    #[test]
    fn browser_mode_flags_a_document_that_is_not_a_results_page() {
        let html =
            r#"<html><head><title>Something went wrong</title></head><body>error</body></html>"#;
        let out = outcome_from_serp(&serp(html, Some("Something went wrong"), false), 5);
        match out.interception {
            Some(super::super::types::Interception::NotAResultsPage { detail }) => {
                assert!(detail.contains("Something went wrong"), "{detail}");
            }
            other => panic!("expected not-a-results-page, got {:?}", other),
        }
    }

    #[test]
    fn browser_mode_empty_results() {
        let out = outcome_from_serp(&serp("<html></html>", None, false), 3);
        assert_eq!(out.provider, "browser");
        assert!(out.results.is_empty());
    }
}
