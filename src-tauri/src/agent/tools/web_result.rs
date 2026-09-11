//! Shared result classification and provenance reporting for the two
//! network-facing agent tools (`web_search`, `http_get`).
//!
//! Both tools can end up holding a page that is *not* the page that was asked
//! for: a bot-verification interstitial, a document that rendered to no readable
//! text, or a completely different site. Reporting those as ordinary success —
//! a `200 OK` with an empty body, or "no results found" — is what made earlier
//! failures impossible to diagnose from the tool output, so the rules live here
//! and every call site uses the same ones.

/// Backend labels shared by `web_search` and `http_get`, so a provider string is
/// never spelled out twice.
pub const BROWSER_BACKEND: &str = "browser";
pub const HTML_BACKEND: &str = "html";

/// A bot-verification / anti-bot interstitial standing in for the real page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Challenge {
    /// User-facing name of the protection in play, so a failure can say *what*
    /// intercepted the request instead of a generic "failed".
    pub vendor: &'static str,
}

/// Signatures of common interstitials, matched case-insensitively against the
/// page HTML plus its title.
///
/// Order matters: the most specific marker wins, so `百度安全验证` is reported as
/// itself rather than as the generic `安全验证` it contains.
///
/// These are only ever consulted when a page produced *no* usable content (no
/// parsed results, or content that converted to nothing). A page that merely
/// discusses verification therefore cannot be misclassified as being one.
const CHALLENGE_MARKERS: &[(&str, &str)] = &[
    // Baidu — the exact interstitial seen in a real failure report.
    ("百度安全验证", "百度安全验证"),
    ("请完成安全验证", "安全验证"),
    ("安全验证", "安全验证"),
    ("滑动验证", "滑块验证"),
    ("拖动滑块", "滑块验证"),
    ("人机验证", "人机验证"),
    ("访问验证", "访问验证"),
    // Cloudflare
    ("cf-chl", "Cloudflare"),
    ("challenge-platform", "Cloudflare"),
    ("just a moment", "Cloudflare"),
    ("checking your browser before accessing", "Cloudflare"),
    ("attention required! | cloudflare", "Cloudflare"),
    ("ddos protection by cloudflare", "Cloudflare"),
    // Arkose Labs (used by Bing) and Bing's own proof-of-work gate.
    ("arkoselabs", "Arkose Labs"),
    ("powchallenge", "人机验证"),
    // Google
    ("unusual traffic", "Google 异常流量拦截"),
    ("/sorry/index", "Google 异常流量拦截"),
    // Generic captcha markers last: they are the least specific.
    ("captcha", "验证码"),
    ("验证码", "验证码"),
];

/// Classify a page as a bot-verification interstitial, if it is one.
pub fn detect_challenge(html: &str, title: Option<&str>) -> Option<Challenge> {
    let mut haystack = String::with_capacity(html.len() + 128);
    if let Some(title) = title {
        haystack.push_str(title);
        haystack.push('\n');
    }
    haystack.push_str(html);
    let haystack = haystack.to_ascii_lowercase();

    CHALLENGE_MARKERS
        .iter()
        .find(|(marker, _)| haystack.contains(&marker.to_ascii_lowercase()))
        .map(|(_, vendor)| Challenge { vendor })
}

/// Whether converted page content carries nothing a reader could use.
///
/// Markdown rendering of an empty document often leaves behind whitespace,
/// zero-width characters and horizontal rules, none of which is content.
pub fn is_blank_content(content: &str) -> bool {
    !content.chars().any(|c| {
        !c.is_whitespace()
            && !is_invisible_format_char(c)
            && !matches!(c, '-' | '#' | '*' | '_' | '|' | '`')
    })
}

fn is_invisible_format_char(ch: char) -> bool {
    matches!(
        ch,
        '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}'
    )
}

/// Which backend produced a result, for reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebBackend {
    /// Local headless Chrome/Edge over CDP.
    Browser,
    /// Bare HTTP GET.
    Html,
    /// Search-engine HTTP API.
    Api,
    /// More than one backend served the same batched request.
    Mixed,
}

impl WebBackend {
    pub fn label(self) -> &'static str {
        match self {
            Self::Browser => BROWSER_BACKEND,
            Self::Html => HTML_BACKEND,
            Self::Api => "api",
            Self::Mixed => "mixed",
        }
    }
}

/// Records that the configured backend failed and another one served the
/// request, so a degraded result is never mistaken for the requested path.
#[derive(Debug, Clone)]
pub struct FallbackNote {
    pub from: &'static str,
    pub to: &'static str,
    /// Why the requested backend failed.
    pub reason: String,
}

impl FallbackNote {
    pub fn new(from: &'static str, to: &'static str, reason: impl Into<String>) -> Self {
        Self {
            from,
            to,
            reason: reason.into(),
        }
    }

    /// Short, model- and user-facing one-liner.
    pub fn summary_suffix(&self) -> String {
        format!(
            " [{} failed, fell back to {}: {}]",
            self.from, self.to, self.reason
        )
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "from": self.from,
            "to": self.to,
            "reason": self.reason,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_baidu_interstitial_that_was_actually_reported() {
        let html = r#"<html><head><title>百度安全验证</title></head>
            <body><div id="waf">请完成安全验证</div></body></html>"#;
        let challenge = detect_challenge(html, Some("百度安全验证")).expect("challenge");
        assert_eq!(
            challenge.vendor, "百度安全验证",
            "the most specific marker must win"
        );
    }

    #[test]
    fn detects_cloudflare_and_arkose_interstitials() {
        let cloudflare =
            r#"<html><body><div class="cf-chl-opt">Just a moment...</div></body></html>"#;
        assert_eq!(
            detect_challenge(cloudflare, Some("Just a moment...")),
            Some(Challenge {
                vendor: "Cloudflare"
            })
        );

        let arkose =
            r#"<html><body><script src="https://arkoselabs.com/v2/x"></script></body></html>"#;
        assert_eq!(
            detect_challenge(arkose, None),
            Some(Challenge {
                vendor: "Arkose Labs"
            })
        );
    }

    #[test]
    fn a_real_results_page_is_not_a_challenge() {
        let html = r#"
        <html><head><title>tokio rust - 搜索</title></head><body>
          <ol id="b_results">
            <li class="b_algo"><h2><a href="https://tokio.rs/">Tokio</a></h2></li>
          </ol>
        </body></html>
        "#;
        assert_eq!(detect_challenge(html, Some("tokio rust - 搜索")), None);
    }

    #[test]
    fn the_title_alone_is_enough() {
        assert_eq!(
            detect_challenge("<html><body></body></html>", Some("百度安全验证")),
            Some(Challenge {
                vendor: "百度安全验证"
            })
        );
    }

    #[test]
    fn blank_content_covers_markdown_noise() {
        assert!(is_blank_content(""));
        assert!(is_blank_content("   \n\t \u{200B} "));
        assert!(is_blank_content("---\n\n---"));
        assert!(!is_blank_content("hello"));
        assert!(!is_blank_content("百度安全验证"));
    }

    #[test]
    fn fallback_note_reports_both_directions() {
        let note = FallbackNote::new("browser", "html", "browser boot: timed out");
        assert!(note.summary_suffix().contains("browser"));
        assert!(note.summary_suffix().contains("html"));
        assert!(note.summary_suffix().contains("timed out"));
        assert_eq!(note.to_json()["from"], "browser");
        assert_eq!(note.to_json()["to"], "html");
    }

    #[test]
    fn backend_labels_are_stable() {
        assert_eq!(WebBackend::Browser.label(), BROWSER_BACKEND);
        assert_eq!(WebBackend::Html.label(), HTML_BACKEND);
        assert_eq!(WebBackend::Api.label(), "api");
        assert_eq!(WebBackend::Mixed.label(), "mixed");
    }
}
