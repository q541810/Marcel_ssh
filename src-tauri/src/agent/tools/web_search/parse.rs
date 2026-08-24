//! Shared Bing SERP HTML parsing.

use scraper::{Html, Selector};

use super::types::SearchResult;

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

pub fn looks_like_challenge_page(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    (lower.contains("captcha") || lower.contains("powchallenge") || lower.contains("arkoselabs"))
        && !lower.contains("li class=\"b_algo\"")
        && !lower.contains("class=\"b_algo\"")
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
    fn looks_like_challenge_without_results() {
        let html =
            r#"<html><body><div class="captcha">PoWChallenge arkoselabs</div></body></html>"#;
        assert!(looks_like_challenge_page(html));
    }

    #[test]
    fn real_results_not_flagged_as_challenge() {
        let html = r#"
        <html><body>
          <script>PoWChallenge</script>
          <li class="b_algo"><h2><a href="https://example.com">Ok</a></h2></li>
        </body></html>
        "#;
        assert!(!looks_like_challenge_page(html));
    }
}
