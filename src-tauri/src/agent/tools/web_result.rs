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
///
/// **A marker must be checked against real pages of the engine it names before it
/// is added here.** Bing ships both of its anti-bot mechanisms — `arkoselabs` and
/// `powchallenge` — inside *every* SERP, including ones returning eight results,
/// so neither can tell an intercepted page from a served one; both were removed
/// after being measured that way. A fingerprint present on the pages it is
/// supposed to clear is not evidence of anything. The remaining entries came back
/// 0/3 across three live queries, and a genuinely gated page is caught by
/// [`is_bot_block`]'s "the marker is the whole page" rule regardless.
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

/// The shared gate in front of [`detect_challenge`].
///
/// A challenge marker is only evidence when it *is* the page. Interstitials are
/// the marker and nothing else — measured across the shapes this list covers
/// (百度安全验证, Cloudflare, Bing's proof-of-work), the converted body runs 15–50
/// characters, while the shortest real article that merely discusses a captcha
/// converted to 67 and ordinary ones to thousands. Requiring the body to be short
/// sits comfortably between the two.
///
/// Skipping this gate is what made `http_get` condemn any page that so much as
/// mentions a captcha — a tutorial about them, a CDN's own block page, a form
/// with a challenge widget — while the real page text sat in the same response
/// and the whole fetch was counted as a failure.
///
/// `response` is the page as it arrived; markup is converted first, because "how
/// much is there to read" is a question about the page's text, not its angle
/// brackets, and a length taken over markup measures the scripts instead.
pub fn is_bot_block(response: &str, title: Option<&str>) -> Option<Challenge> {
    let text = readable_text(response);
    if !is_blank_content(&text) && text.chars().count() > INTERSTITIAL_TEXT_MAX {
        return None;
    }
    detect_challenge(response, title)
}

/// Ceiling on the converted body of a page whose text is a challenge notice.
///
/// Deliberately generous against the observed 15–50: a marker page may carry a
/// little explanatory text, and the cost of letting one through is a page shown
/// as what it is, whereas the cost of the ceiling being too tight is a genuine
/// block reported as ordinary content.
const INTERSTITIAL_TEXT_MAX: usize = 200;

/// The page's text, for the "is this page nothing but the marker" question.
///
/// Markup goes through the same conversion the tools use for output, so the gate
/// and the content the model receives are two views of one extraction rather than
/// two opinions. A response that is not markup is already text.
fn readable_text(response: &str) -> String {
    if looks_like_markup(response) {
        crate::agent::tools::http_get::html_to_markdown(response)
    } else {
        response.to_string()
    }
}

/// Whether a response is a document rather than plain text or data.
fn looks_like_markup(response: &str) -> bool {
    let lower = response.to_ascii_lowercase();
    lower.contains("<html")
        || lower.contains("<!doctype")
        || lower.contains("<body")
        || lower.contains("<div")
        || lower.contains("<head")
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
    fn detects_cloudflare_and_google_interstitials() {
        let cloudflare =
            r#"<html><body><div class="cf-chl-opt">Just a moment...</div></body></html>"#;
        assert_eq!(
            detect_challenge(cloudflare, Some("Just a moment...")),
            Some(Challenge {
                vendor: "Cloudflare"
            })
        );

        let google =
            r#"<html><body><h1>Our systems have detected unusual traffic</h1></body></html>"#;
        assert_eq!(
            detect_challenge(google, None),
            Some(Challenge {
                vendor: "Google 异常流量拦截"
            })
        );
    }

    /// Both of Bing's anti-bot mechanisms ride along on *every* SERP, so neither
    /// can fingerprint an intercepted page. Measured 2026-09-21 against three live
    /// cn.bing.com queries: `arkoselabs` 0/3 as a bare word but present as the
    /// script URL, `powchallenge` 3/3 — it names a JS bundle
    /// (`A:rms:answers:GlobalsScript:PoWChallengeSolver`) that every result page
    /// loads. Using either one matched real results pages instead of catching
    /// blocks, and both were removed from the marker table.
    #[test]
    fn bings_always_present_antibot_bundles_are_not_interceptions() {
        let serp = r#"<html><head><title>tokio rust - 搜索</title>
            <script src="https://client-api.arkoselabs.com/v2/xxx/api.js"></script>
            <script>var rms={'A:rms:answers:GlobalsScript:PoWChallengeSolver':'/rp/x.js'};</script>
            </head><body><ol id="b_results"><li class="b_algo">
            <h2><a href="https://tokio.rs/">Tokio</a></h2></li></ol></body></html>"#;

        // The marker table matches case-insensitively, so the control has to look
        // the same way — otherwise it would "prove" absence of a marker that is
        // sitting right there in a different case.
        let haystack = serp.to_ascii_lowercase();
        assert!(
            haystack.contains("arkoselabs"),
            "fixture must carry the Arkose marker"
        );
        assert!(
            haystack.contains("powchallenge"),
            "fixture must carry the PoW marker"
        );
        assert_eq!(
            detect_challenge(serp, Some("tokio rust - 搜索")),
            None,
            "markers present on every Bing response are not evidence of a challenge"
        );
    }

    /// The gate itself, on both sides of the boundary.
    ///
    /// Each rejecting case is paired with a control proving the marker genuinely
    /// is in the haystack — otherwise the assertion would pass on a fixture that
    /// simply never contained one, and the gate would look load-bearing when it
    /// is not.
    #[test]
    fn a_marker_only_counts_when_it_is_the_page() {
        // Interstitials: the marker is all there is. Measured bodies run 15–50
        // characters; these are the real shapes this list exists for.
        for (name, html) in [
            (
                "百度安全验证",
                r#"<html><head><title>百度安全验证</title></head><body><div id="waf">请完成安全验证</div></body></html>"#,
            ),
            (
                "Cloudflare",
                r#"<html><head><title>Just a moment...</title></head><body><div class="cf-chl-opt">Just a moment...</div></body></html>"#,
            ),
            (
                "Google 异常流量拦截",
                r#"<html><head><title>Sorry...</title></head><body><div><h1>Our systems have detected unusual traffic from your computer network.</h1></div></body></html>"#,
            ),
        ] {
            let vendor = is_bot_block(html, None).map(|c| c.vendor);
            assert!(
                vendor.is_some(),
                "{name}: a real interstitial must be named"
            );
            println!("{name} -> {vendor:?}");
        }

        // The regression: a page that genuinely discusses the marker has its own
        // body, and must be returned as content. Which marker it happens to hit
        // is not the point — that one is hit at all is the control, so this case
        // cannot pass merely because the fixture contained no marker.
        let article = "<html><head><title>如何解决验证码</title></head><body><main>\
            <h1>滑块验证码的绕过思路</h1>\
            <p>这篇讲的是自行架站的防护配置，正文很长，属于正常内容页面而不是拦截页。\
            文中会多次提到验证码、Cloudflare 以及人机验证这些词，因为讨论的就是它们。</p>\
            <p>再补一段，确保转换后的正文明显超过一句验证提示的长度：拦截页整页只有那句话，\
            而一篇文章总有若干段落，长度差着两个数量级，这正是判别依据。</p>\
            <p>第三段用来把正文长度推到足够高，避免样本本身太短而让用例失去意义。</p>\
            </main></body></html>";
        let matched = detect_challenge(article, Some("如何解决验证码")).map(|c| c.vendor);
        assert!(
            matched.is_some(),
            "control: this document must really contain a marker"
        );
        assert_eq!(
            is_bot_block(article, Some("如何解决验证码")),
            None,
            "a page with its own content is not a block page, even though it \
             matched {:?}",
            matched
        );

        // A page with no marker at all is never a block, whatever its length.
        assert_eq!(
            is_bot_block("<html><body><main><p>ok</p></main></body></html>", None),
            None
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
