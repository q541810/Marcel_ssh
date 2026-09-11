//! Shared Bing SERP HTML parsing.

use scraper::{Html, Selector};

use super::types::SearchResult;

/// Containers that prove Bing actually served a results page. `b_results` wraps
/// the result list; `b_no` is Bing's explicit "no results" block. Seeing either
/// means an empty parse is a genuine zero-hit answer rather than a wrong page.
const RESULTS_PAGE_MARKERS: &[&str] = &["b_results", "b_no", "b_context"];

pub fn parse_bing_results(html: &str, max: usize) -> Vec<SearchResult> {
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

        let final_url = if let Some(u) = url {
            if u.starts_with("http") {
                u
            } else if u.starts_with("//") {
                format!("https:{}", u)
            } else if u.starts_with('/') {
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

/// Whether the HTML carries a marker proving it is a real Bing results page.
pub fn looks_like_results_page(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    RESULTS_PAGE_MARKERS.iter().any(|m| lower.contains(m))
}

/// Document title, for classifying an unexpected page in diagnostics.
pub fn extract_title(html: &str) -> Option<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("title").ok()?;
    let element = document.select(&selector).next()?;
    let text: String = element.text().collect::<Vec<_>>().join(" ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_empty_html_returns_no_results() {
        assert!(parse_bing_results("<html></html>", 5).is_empty());
    }

    #[test]
    fn parse_sample_b_algo() {
        let html = r#"
        <html><body>
          <li class="b_algo">
            <h2><a href="https://example.com/a">Alpha Title</a></h2>
            <div class="b_caption"><p>Alpha snippet here</p></div>
          </li>
          <li class="b_algo">
            <h2><a href="//example.com/b">Beta Title</a></h2>
            <div class="b_caption"><p>Beta snippet</p></div>
          </li>
        </body></html>
        "#;
        let results = parse_bing_results(html, 8);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].title, "Alpha Title");
        assert_eq!(results[0].url, "https://example.com/a");
        assert_eq!(results[0].snippet, "Alpha snippet here");
        assert_eq!(results[1].url, "https://example.com/b");
    }

    #[test]
    fn parse_respects_max_results() {
        let mut items = String::new();
        for i in 0..5 {
            items.push_str(&format!(
                r#"<li class="b_algo"><h2><a href="https://example.com/{i}">T{i}</a></h2><div class="b_caption"><p>S{i}</p></div></li>"#
            ));
        }
        let html = format!("<html><body>{items}</body></html>");
        let results = parse_bing_results(&html, 3);
        assert_eq!(results.len(), 3);
        assert_eq!(results[2].title, "T2");
    }

    #[test]
    fn results_page_markers_distinguish_a_serp_from_an_interstitial() {
        assert!(looks_like_results_page(
            r#"<html><body><ol id="b_results"></ol></body></html>"#
        ));
        assert!(looks_like_results_page(
            r#"<html><body><li class="b_no">没有与此相关的结果</li></body></html>"#
        ));
        assert!(!looks_like_results_page(
            r#"<html><head><title>百度安全验证</title></head><body></body></html>"#
        ));
    }

    #[test]
    fn title_extraction_collapses_whitespace() {
        assert_eq!(
            extract_title("<html><head><title>  tokio\n rust  </title></head></html>").as_deref(),
            Some("tokio rust")
        );
        assert_eq!(extract_title("<html><body>none</body></html>"), None);
    }
}
