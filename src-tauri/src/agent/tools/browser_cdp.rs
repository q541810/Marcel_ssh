//! Shared local headless Chrome/Edge CDP helpers for web_search / http_get.
//!
//! Minimal WebSocket client over plain TCP (CDP is always ws://127.0.0.1).
//!
//! Invariants this module exists to preserve, each of which an earlier revision
//! violated and which together produced intermittent "web fetch failed" reports:
//!
//! 1. **A navigation is not complete when `Page.navigate` is acknowledged.**
//!    The browser is launched on `about:blank`, whose `document.readyState` is
//!    already `"complete"`. A readiness probe issued right after `Page.navigate`
//!    can therefore observe the *stale* document and report success before the
//!    new one exists. [`CdpPage::navigate_and_wait`] also requires that
//!    `location.href` has left the blank document, which makes the wait
//!    deterministic instead of racy.
//!
//! 2. **One CDP request has exactly one deadline.** Reads are bounded by the
//!    enclosing call budget, never by a shorter inner timeout: an inner timeout
//!    that fires first makes the outer budget dead code and reports a generic
//!    failure instead of naming the request that stalled. A call that does
//!    exhaust its budget leaves the stream mid-frame, so the session is marked
//!    [`CdpPage::is_poisoned`] and must not be reused.
//!
//! 3. **Failures carry their stage.** [`CdpFailure`] records which phase broke,
//!    so `web_search` / `http_get` can decide policy from structure rather than
//!    by pattern-matching an error string.
//!
//! Every browser process this module starts is short-lived and uses a throwaway
//! profile directory under the OS temp dir.

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{timeout, timeout_at, Instant};

use crate::error::AppError;

#[cfg(test)]
mod testkit;

/// How long to wait for the CDP endpoint to appear after launching a browser.
const BROWSER_BOOT_TIMEOUT: Duration = Duration::from_secs(12);
/// Idle time after the document becomes usable, so late DOM writes land.
const SETTLE_AFTER_READY: Duration = Duration::from_millis(500);
/// Cadence of the navigation readiness probe.
const NAV_POLL_INTERVAL: Duration = Duration::from_millis(120);
/// How long to wait for the Bing SERP result container to appear.
const SERP_SELECTOR_WAIT: Duration = Duration::from_secs(18);
/// Upper bound on browser restarts while serving one batch of URLs.
const MAX_SESSION_RESTARTS: usize = 2;

/// Which phase of a browser session failed.
///
/// Callers derive policy from this instead of parsing an error string: an
/// infrastructure fault is worth another attempt and is a good candidate for a
/// different backend, whereas a site that refused to load will refuse again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CdpStage {
    /// Locating or launching the browser binary.
    Launch,
    /// Waiting for the CDP endpoint to answer.
    Boot,
    /// TCP connect plus websocket upgrade.
    Connect,
    /// Driving or awaiting a navigation.
    Navigate,
    /// Reading a frame or awaiting a response.
    Read,
    /// Writing a frame.
    Write,
    /// A session that had to be retired part-way through a batch.
    Session,
}

impl CdpStage {
    pub fn label(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Boot => "boot",
            Self::Connect => "connect",
            Self::Navigate => "navigate",
            Self::Read => "read",
            Self::Write => "write",
            Self::Session => "session",
        }
    }

    /// Infrastructure phases can be transiently broken, so repeating the same
    /// mechanism once may well succeed.
    ///
    /// [`CdpStage::Navigate`] is deliberately excluded: a navigation only fails
    /// for a reason (DNS, refused, stalled host), and re-running it just burns
    /// the budget — a different backend is the more useful next step.
    pub fn retryable(self) -> bool {
        matches!(
            self,
            Self::Launch | Self::Boot | Self::Connect | Self::Read | Self::Write | Self::Session
        )
    }
}

/// A browser-session failure with the phase that produced it.
#[derive(Debug, Clone)]
pub struct CdpFailure {
    pub stage: CdpStage,
    pub message: String,
}

impl CdpFailure {
    pub fn retryable(&self) -> bool {
        self.stage.retryable()
    }

    /// True when every phase is worth retrying on a different mechanism.
    /// Callers may apply a stricter policy (e.g. time budget) on top.
    pub fn fallback_eligible(&self) -> bool {
        true
    }
}

impl std::fmt::Display for CdpFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "browser {}: {}", self.stage.label(), self.message)
    }
}

impl From<CdpFailure> for AppError {
    fn from(failure: CdpFailure) -> Self {
        AppError::Agent(failure.to_string())
    }
}

fn fail(stage: CdpStage, message: impl std::fmt::Display) -> CdpFailure {
    CdpFailure {
        stage,
        message: message.to_string(),
    }
}

/// Wall-clock budgets for one short-lived browser session.
///
/// Defaults reproduce the long-standing numbers; tests shrink them so timeout
/// behaviour is provable in milliseconds instead of tens of seconds.
#[derive(Debug, Clone, Copy)]
pub(crate) struct CdpTimeouts {
    /// TCP connect to the CDP page endpoint.
    pub connect: Duration,
    /// Websocket upgrade handshake.
    pub handshake: Duration,
    /// One CDP request/response round trip. Authoritative for all reads it drives.
    pub call: Duration,
    /// How long a navigation may take before the document must be usable.
    pub nav: Duration,
}

impl Default for CdpTimeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(8),
            handshake: Duration::from_secs(5),
            call: Duration::from_secs(20),
            nav: Duration::from_secs(30),
        }
    }
}

/// One `Runtime.evaluate` returning everything needed to describe the current
/// document, so href/readyState/status/title always come from the same instant.
///
/// `responseStatus` is the real main-document status code (Chromium ≥109) and is
/// reported as `null` when the navigation produced no HTTP response at all —
/// the honest answer for a blocked or unreachable host, which must never be
/// silently rendered as `200`.
const PAGE_FACTS_EXPR: &str = r#"JSON.stringify((function () {
  var nav = performance.getEntriesByType('navigation')[0];
  var status = (nav && typeof nav.responseStatus === 'number') ? nav.responseStatus : 0;
  return {
    href: location.href,
    readyState: document.readyState,
    responseStatus: status > 0 ? status : null,
    title: document.title || ''
  };
})())"#;

/// Observables of the current document.
#[derive(Debug, Clone)]
pub struct PageFacts {
    pub href: String,
    pub ready_state: String,
    /// `None` = no HTTP status could be obtained for the main document.
    pub response_status: Option<u16>,
    pub title: Option<String>,
}

impl PageFacts {
    fn blank() -> Self {
        Self {
            href: String::new(),
            ready_state: String::new(),
            response_status: None,
            title: None,
        }
    }

    fn from_json(value: &Value) -> Self {
        let title = value
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string);
        Self {
            href: value
                .get("href")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            ready_state: value
                .get("readyState")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            response_status: value
                .get("responseStatus")
                .and_then(|v| v.as_u64())
                .filter(|code| *code > 0 && *code <= u16::MAX as u64)
                .map(|code| code as u16),
            title,
        }
    }
}

/// A real navigation has committed only once the blank document is gone.
fn is_new_document(href: &str) -> bool {
    !href.is_empty() && href != "about:blank"
}

fn is_usable_ready_state(ready_state: &str) -> bool {
    ready_state == "interactive" || ready_state == "complete"
}

/// A loaded page plus its observable HTTP status.
#[derive(Debug, Clone)]
pub struct BrowserPage {
    pub requested_url: String,
    pub final_url: String,
    pub title: Option<String>,
    pub html: String,
    /// `None` when the page never produced an HTTP response (blocked, refused,
    /// DNS failure, or an error interstitial). Callers must not invent a code.
    pub status: Option<u16>,
}

/// A Bing SERP as the browser actually rendered it.
#[derive(Debug, Clone)]
pub struct BingSerp {
    pub html: String,
    pub facts: PageFacts,
    /// Whether a result container (`li.b_algo`) ever appeared in the DOM. When
    /// `false`, an empty result list means "this was not a results page", not
    /// "this query has no results" — a distinction the tool must report.
    pub found_result_container: bool,
}

struct BrowserSession {
    child: Child,
    port: u16,
    user_data_dir: PathBuf,
}

impl Drop for BrowserSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.user_data_dir);
    }
}

fn missing_browser() -> CdpFailure {
    fail(
        CdpStage::Launch,
        "no local Chrome/Edge found; install Chrome or Edge, or switch the web mode to HTML/API",
    )
}

/// Fetch one URL's rendered HTML via a short-lived headless browser.
pub async fn fetch_html(url: &str) -> Result<BrowserPage, CdpFailure> {
    let browser = find_browser_binary().ok_or_else(missing_browser)?;
    let session = spawn_browser(&browser)?;
    let page_ws = open_page_ws(session.port).await?;
    let mut page = CdpPage::connect(&page_ws).await?;
    let result = load_page(&mut page, url).await;
    drop(page);
    drop(session);
    result
}

/// Fetch multiple URLs sequentially, reusing one browser process per batch.
///
/// A page whose CDP call exhausts its deadline leaves the stream mid-frame, so
/// the session becomes unusable; the remaining URLs continue in a fresh browser
/// (bounded by [`MAX_SESSION_RESTARTS`]) instead of inheriting the corruption.
pub async fn fetch_html_many(urls: &[String]) -> Vec<Result<BrowserPage, CdpFailure>> {
    if urls.is_empty() {
        return Vec::new();
    }

    let browser = match find_browser_binary() {
        Some(binary) => binary,
        None => return fail_all(urls.len(), &missing_browser()),
    };

    let mut out: Vec<Result<BrowserPage, CdpFailure>> = Vec::with_capacity(urls.len());
    let mut index = 0usize;
    let mut restarts = 0usize;

    while index < urls.len() {
        let session = match spawn_browser(&browser) {
            Ok(session) => session,
            Err(e) => {
                out.extend(fail_all(urls.len() - index, &e));
                break;
            }
        };

        let opened = open_page_ws(session.port).await;
        let mut active = match opened {
            Ok(ws) => match CdpPage::connect(&ws).await {
                Ok(page) => Some(page),
                Err(e) => {
                    out.push(Err(e));
                    index += 1;
                    None
                }
            },
            Err(e) => {
                out.push(Err(e));
                index += 1;
                None
            }
        };

        if let Some(page) = active.as_mut() {
            while index < urls.len() {
                let result = load_page(page, &urls[index]).await;
                let poisoned = page.is_poisoned();
                out.push(result);
                index += 1;
                if poisoned {
                    break;
                }
            }
        }

        drop(active);
        drop(session);

        if index < urls.len() {
            restarts += 1;
            if restarts > MAX_SESSION_RESTARTS {
                let gave_up = fail(
                    CdpStage::Session,
                    format!(
                        "gave up after {} restarts; {} URL(s) were not fetched",
                        restarts,
                        urls.len() - index
                    ),
                );
                out.extend(fail_all(urls.len() - index, &gave_up));
                break;
            }
        }
    }

    out
}

fn fail_all(count: usize, failure: &CdpFailure) -> Vec<Result<BrowserPage, CdpFailure>> {
    (0..count).map(|_| Err(failure.clone())).collect()
}

/// Load one URL in an already-open session.
async fn load_page(page: &mut CdpPage, url: &str) -> Result<BrowserPage, CdpFailure> {
    let nav_facts = page.navigate_and_wait(url).await?;
    tokio::time::sleep(SETTLE_AFTER_READY).await;

    // A late redirect can move the document after the readiness gate; refresh
    // the facts when possible, but never turn a transient probe failure into a
    // page failure unless the session is actually gone.
    let facts = match page.read_page_facts().await {
        Ok(facts) => facts,
        Err(e) => {
            if page.is_poisoned() {
                return Err(e);
            }
            nav_facts
        }
    };

    let html = page.get_outer_html().await?;
    Ok(BrowserPage {
        requested_url: url.to_string(),
        final_url: facts.href,
        title: facts.title,
        html,
        status: facts.response_status,
    })
}

/// Build the Bing SERP URL for a configured endpoint.
pub(crate) fn bing_search_url(
    endpoint: crate::config::settings::WebSearchEndpoint,
    query: &str,
) -> String {
    use crate::agent::tools::web_search::urlencoding;

    let host = match endpoint {
        crate::config::settings::WebSearchEndpoint::Cn => "https://cn.bing.com",
        crate::config::settings::WebSearchEndpoint::Www => "https://www.bing.com",
    };
    format!("{}/search?q={}", host, urlencoding::encode(query))
}

/// Search Bing's SERP via the browser (used by `web_search` browser mode).
pub async fn fetch_bing_serp(
    endpoint: crate::config::settings::WebSearchEndpoint,
    query: &str,
) -> Result<BingSerp, CdpFailure> {
    let url = bing_search_url(endpoint, query);
    let browser = find_browser_binary().ok_or_else(missing_browser)?;
    let session = spawn_browser(&browser)?;
    let page_ws = open_page_ws(session.port).await?;
    let mut page = CdpPage::connect(&page_ws).await?;

    let result = async {
        let mut facts = page.navigate_and_wait(&url).await?;
        let found_result_container = page
            .wait_for_selector("li.b_algo", SERP_SELECTOR_WAIT)
            .await?;
        if let Ok(refreshed) = page.read_page_facts().await {
            facts = refreshed;
        }
        let html = page.get_outer_html().await?;
        Ok(BingSerp {
            html,
            facts,
            found_result_container,
        })
    }
    .await;

    drop(page);
    drop(session);
    result
}

fn find_browser_binary() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let pf = std::env::var_os("ProgramFiles").map(PathBuf::from);
        let pf86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);

        for base in [pf, pf86, local].into_iter().flatten() {
            candidates.push(base.join(r"Google\Chrome\Application\chrome.exe"));
            candidates.push(base.join(r"Microsoft\Edge\Application\msedge.exe"));
            candidates.push(base.join(r"Chromium\Application\chrome.exe"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ));
        candidates.push(PathBuf::from(
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ));
        candidates.push(PathBuf::from(
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ));
    }

    #[cfg(target_os = "linux")]
    {
        for name in [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "microsoft-edge",
            "microsoft-edge-stable",
        ] {
            if let Ok(path) = which_bin(name) {
                candidates.push(path);
            }
        }
    }

    candidates.into_iter().find(|p| p.is_file())
}

#[cfg(target_os = "linux")]
fn which_bin(name: &str) -> Result<PathBuf, ()> {
    let output = Command::new("which").arg(name).output().map_err(|_| ())?;
    if !output.status.success() {
        return Err(());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        Err(())
    } else {
        Ok(PathBuf::from(path))
    }
}

fn pick_free_port() -> Result<u16, CdpFailure> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| {
        fail(
            CdpStage::Launch,
            format!("failed to allocate debug port: {}", e),
        )
    })?;
    let port = listener
        .local_addr()
        .map_err(|e| {
            fail(
                CdpStage::Launch,
                format!("failed to read debug port: {}", e),
            )
        })?
        .port();
    drop(listener);
    Ok(port)
}

fn spawn_browser(binary: &PathBuf) -> Result<BrowserSession, CdpFailure> {
    let port = pick_free_port()?;
    let user_data_dir =
        std::env::temp_dir().join(format!("marcel-browser-{}-{}", std::process::id(), port));
    std::fs::create_dir_all(&user_data_dir).map_err(|e| {
        fail(
            CdpStage::Launch,
            format!("failed to create browser profile dir: {}", e),
        )
    })?;

    let child = Command::new(binary)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-component-extensions-with-background-pages",
            "--disable-background-networking",
            "--disable-sync",
            "--disable-translate",
            "--disable-default-apps",
            "--disable-popup-blocking",
            "--metrics-recording-only",
            "--mute-audio",
            "--hide-scrollbars",
            "--window-size=1280,900",
            &format!("--remote-debugging-port={}", port),
            &format!("--user-data-dir={}", user_data_dir.display()),
            "about:blank",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| fail(CdpStage::Launch, format!("failed to start browser: {}", e)))?;

    Ok(BrowserSession {
        child,
        port,
        user_data_dir,
    })
}

async fn open_page_ws(port: u16) -> Result<String, CdpFailure> {
    let list_url = format!("http://127.0.0.1:{}/json/list", port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| fail(CdpStage::Boot, format!("HTTP client error: {}", e)))?;

    let deadline = tokio::time::Instant::now() + BROWSER_BOOT_TIMEOUT;
    loop {
        if tokio::time::Instant::now() > deadline {
            return Err(fail(
                CdpStage::Boot,
                format!(
                    "CDP endpoint did not become ready within {:.0}s",
                    BROWSER_BOOT_TIMEOUT.as_secs_f32()
                ),
            ));
        }

        match client.get(&list_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let pages: Value = resp
                    .json()
                    .await
                    .map_err(|e| fail(CdpStage::Boot, format!("invalid CDP list JSON: {}", e)))?;
                if let Some(ws) = pick_page_ws_url(&pages) {
                    return Ok(ws);
                }
            }
            _ => {}
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn pick_page_ws_url(pages: &Value) -> Option<String> {
    let arr = pages.as_array()?;
    let mut blank: Option<String> = None;
    let mut httpish: Option<String> = None;
    let mut other: Option<String> = None;

    for page in arr {
        let ty = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ty != "page" {
            continue;
        }
        let url = page.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let Some(ws) = page
            .get("webSocketDebuggerUrl")
            .and_then(|v| v.as_str())
            .map(str::to_string)
        else {
            continue;
        };

        if url == "about:blank" {
            blank = Some(ws);
        } else if url.starts_with("http://") || url.starts_with("https://") {
            if httpish.is_none() {
                httpish = Some(ws);
            }
        } else if !url.starts_with("chrome-extension://")
            && !url.starts_with("edge://")
            && !url.starts_with("chrome://")
            && !url.starts_with("devtools://")
            && other.is_none()
        {
            other = Some(ws);
        }
    }

    blank.or(httpish).or(other)
}

/// Why a read did not produce a frame.
enum ReadFailure {
    /// The enclosing call budget elapsed (possibly mid-frame).
    Deadline,
    /// The peer closed the websocket or the socket.
    PeerClosed,
    /// A complete frame arrived but could not be understood.
    Protocol(String),
    /// The socket itself failed.
    Io(String),
}

struct CdpPage {
    stream: TcpStream,
    next_id: u64,
    read_buf: Vec<u8>,
    timeouts: CdpTimeouts,
    /// Set when a read failure left the stream mid-frame, so the session can no
    /// longer be trusted for further requests.
    poisoned: bool,
}

impl CdpPage {
    async fn connect(ws_url: &str) -> Result<Self, CdpFailure> {
        Self::connect_with(ws_url, CdpTimeouts::default()).await
    }

    async fn connect_with(ws_url: &str, timeouts: CdpTimeouts) -> Result<Self, CdpFailure> {
        let without_scheme = ws_url.strip_prefix("ws://").ok_or_else(|| {
            fail(
                CdpStage::Connect,
                format!("unsupported CDP URL (need ws://): {}", ws_url),
            )
        })?;
        let (host_port, path) = without_scheme
            .split_once('/')
            .map(|(h, p)| (h, format!("/{}", p)))
            .unwrap_or((without_scheme, "/".to_string()));

        let mut stream = timeout(timeouts.connect, TcpStream::connect(host_port))
            .await
            .map_err(|_| {
                fail(
                    CdpStage::Connect,
                    format!("TCP connect to {} timed out", host_port),
                )
            })?
            .map_err(|e| fail(CdpStage::Connect, format!("TCP connect failed: {}", e)))?;

        let key = {
            let mut bytes = [0u8; 16];
            for (i, b) in bytes.iter_mut().enumerate() {
                *b = ((std::process::id() as u8)
                    .wrapping_add(i as u8)
                    .wrapping_mul(17))
                    ^ 0x5A;
            }
            base64::engine::general_purpose::STANDARD.encode(bytes)
        };

        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        stream
            .write_all(req.as_bytes())
            .await
            .map_err(|e| fail(CdpStage::Connect, format!("handshake write failed: {}", e)))?;

        let handshake_deadline = Instant::now() + timeouts.handshake;
        let mut header_buf = Vec::with_capacity(1024);
        let mut tmp = [0u8; 256];
        loop {
            let read = timeout_at(handshake_deadline, stream.read(&mut tmp)).await;
            let n = match read {
                Err(_) => return Err(fail(CdpStage::Connect, "handshake read timed out")),
                Ok(Err(e)) => {
                    return Err(fail(
                        CdpStage::Connect,
                        format!("handshake read failed: {}", e),
                    ))
                }
                Ok(Ok(n)) => n,
            };
            if n == 0 {
                return Err(fail(CdpStage::Connect, "handshake closed early"));
            }
            header_buf.extend_from_slice(&tmp[..n]);
            if header_buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
            if header_buf.len() > 16_384 {
                return Err(fail(CdpStage::Connect, "handshake headers too large"));
            }
        }

        let header_text = String::from_utf8_lossy(&header_buf);
        if !header_text.starts_with("HTTP/1.1 101") && !header_text.contains(" 101 ") {
            return Err(fail(
                CdpStage::Connect,
                format!(
                    "websocket upgrade failed: {}",
                    header_text.lines().next().unwrap_or("?")
                ),
            ));
        }

        let split = header_buf
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map(|i| i + 4)
            .unwrap_or(header_buf.len());
        let leftover = header_buf[split..].to_vec();

        let mut page = Self {
            stream,
            next_id: 1,
            read_buf: leftover,
            timeouts,
            poisoned: false,
        };
        page.call("Page.enable", json!({})).await?;
        page.call("Runtime.enable", json!({})).await?;
        let _ = page.call("DOM.enable", json!({})).await;
        Ok(page)
    }

    /// Whether a previous read failure left this session mid-frame.
    fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    fn ensure_usable(&self) -> Result<(), CdpFailure> {
        if self.poisoned {
            return Err(fail(
                CdpStage::Session,
                "CDP session is unusable after a previous read failure; a new browser is required",
            ));
        }
        Ok(())
    }

    /// Navigate and wait until the *new* document is usable.
    ///
    /// `Page.navigate` only acknowledges that navigation started; because the
    /// browser sits on `about:blank` (whose `readyState` is already
    /// `"complete"`), a plain readiness probe would race and could read the
    /// stale document. Requiring a non-blank `location.href` removes the race.
    async fn navigate_and_wait(&mut self, url: &str) -> Result<PageFacts, CdpFailure> {
        let ack = self.call("Page.navigate", json!({ "url": url })).await?;
        if let Some(error_text) = ack.get("errorText").and_then(|v| v.as_str()) {
            if !error_text.is_empty() {
                return Err(fail(
                    CdpStage::Navigate,
                    format!("{} rejected the navigation: {}", url, error_text),
                ));
            }
        }

        let deadline = Instant::now() + self.timeouts.nav;
        let mut last = PageFacts::blank();
        loop {
            if Instant::now() >= deadline {
                return Err(fail(
                    CdpStage::Navigate,
                    format!(
                        "{} did not become usable within {:.0}s (last state: href={} readyState={} status={})",
                        url,
                        self.timeouts.nav.as_secs_f32(),
                        if last.href.is_empty() { "?" } else { &last.href },
                        if last.ready_state.is_empty() {
                            "?"
                        } else {
                            &last.ready_state
                        },
                        match last.response_status {
                            Some(code) => code.to_string(),
                            None => "no-response".to_string(),
                        }
                    ),
                ));
            }

            match self.read_page_facts().await {
                Ok(facts) => {
                    if is_new_document(&facts.href) && is_usable_ready_state(&facts.ready_state) {
                        return Ok(facts);
                    }
                    last = facts;
                }
                // During a navigation the execution context is torn down and
                // recreated, so those errors just mean "keep polling". A dead
                // session is different and must not be hidden.
                Err(_transient) => {
                    self.ensure_usable()?;
                }
            }

            tokio::time::sleep(NAV_POLL_INTERVAL).await;
        }
    }

    async fn read_page_facts(&mut self) -> Result<PageFacts, CdpFailure> {
        let raw = self.evaluate_json(PAGE_FACTS_EXPR).await?;
        let text = match raw {
            Value::String(s) => s,
            other => other.to_string(),
        };
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|e| fail(CdpStage::Read, format!("could not parse page facts: {}", e)))?;
        Ok(PageFacts::from_json(&parsed))
    }

    /// Wait for a selector to appear. Returning `false` is a normal outcome: the
    /// caller decides whether that means "no results" or "wrong page".
    async fn wait_for_selector(
        &mut self,
        selector: &str,
        max_wait: Duration,
    ) -> Result<bool, CdpFailure> {
        let deadline = Instant::now() + max_wait;
        let expr = format!(
            "document.querySelector({}) ? 'yes' : 'no'",
            serde_json::to_string(selector).unwrap_or_else(|_| "\"body\"".into())
        );
        loop {
            match self.evaluate_string(&expr).await {
                Ok(val) if val == "yes" => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    return Ok(true);
                }
                Ok(_) => {}
                Err(_transient) => {
                    self.ensure_usable()?;
                }
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    async fn get_outer_html(&mut self) -> Result<String, CdpFailure> {
        self.ensure_usable()?;

        if let Ok(doc) = self.call("DOM.getDocument", json!({ "depth": 0 })).await {
            if let Some(node_id) = doc.pointer("/root/nodeId").and_then(|v| v.as_i64()) {
                if let Ok(html) = self
                    .call("DOM.getOuterHTML", json!({ "nodeId": node_id }))
                    .await
                {
                    if let Some(s) = html.get("outerHTML").and_then(|v| v.as_str()) {
                        if !s.is_empty() {
                            return Ok(s.to_string());
                        }
                    }
                }
            }
        }

        // The DOM domain can legitimately be unavailable; fall back to JS, but
        // surface a dead session rather than pretending the page is empty.
        match self
            .evaluate_string("document.documentElement.outerHTML")
            .await
        {
            Ok(html) => Ok(html),
            Err(e) => {
                self.ensure_usable()?;
                Err(e)
            }
        }
    }

    async fn evaluate_string(&mut self, expression: &str) -> Result<String, CdpFailure> {
        let value = self.evaluate_json(expression).await?;
        match value {
            Value::String(s) => Ok(s),
            Value::Null => Ok(String::new()),
            other => Ok(other.to_string()),
        }
    }

    async fn evaluate_json(&mut self, expression: &str) -> Result<Value, CdpFailure> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )
            .await?;

        if let Some(exc) = result.pointer("/exceptionDetails") {
            return Err(fail(CdpStage::Read, format!("page JS error: {}", exc)));
        }

        Ok(result
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null))
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, CdpFailure> {
        self.ensure_usable()?;

        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        self.write_text_frame(&msg.to_string()).await?;

        // One deadline governs the whole round trip. An inner read timeout would
        // preempt it and report a generic failure instead of naming `method`.
        let deadline = Instant::now() + self.timeouts.call;
        loop {
            let text = match self.read_text_frame(deadline).await {
                Ok(text) => text,
                Err(ReadFailure::Deadline) => {
                    self.poisoned = true;
                    return Err(fail(
                        CdpStage::Read,
                        format!(
                            "CDP response timed out for {} after {:.0}s",
                            method,
                            self.timeouts.call.as_secs_f32()
                        ),
                    ));
                }
                Err(ReadFailure::PeerClosed) => {
                    self.poisoned = true;
                    return Err(fail(
                        CdpStage::Read,
                        format!("CDP websocket closed by peer while waiting for {}", method),
                    ));
                }
                Err(ReadFailure::Protocol(message)) => {
                    return Err(fail(CdpStage::Read, message));
                }
                Err(ReadFailure::Io(message)) => {
                    self.poisoned = true;
                    return Err(fail(
                        CdpStage::Read,
                        format!("CDP read failed for {}: {}", method, message),
                    ));
                }
            };

            let v: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                // Interleaved events and partial noise are expected on a busy
                // page; keep reading until our own response shows up.
                Err(_) => continue,
            };

            if v.get("id").and_then(|x| x.as_u64()) != Some(id) {
                continue;
            }

            if let Some(err) = v.get("error") {
                return Err(fail(
                    CdpStage::Read,
                    format!("CDP {} error: {}", method, err),
                ));
            }

            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn write_text_frame(&mut self, text: &str) -> Result<(), CdpFailure> {
        self.write_frame(0x1, text.as_bytes()).await
    }

    /// Write a masked client frame (RFC6455 requires client→server masking).
    async fn write_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), CdpFailure> {
        let mut frame = Vec::with_capacity(payload.len() + 14);
        frame.push(0x80 | opcode);
        if payload.len() < 126 {
            frame.push(0x80 | (payload.len() as u8));
        } else if payload.len() <= 65_535 {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
        const MASK: [u8; 4] = [0x12, 0x34, 0x56, 0x78];
        frame.extend_from_slice(&MASK);
        for (i, byte) in payload.iter().enumerate() {
            frame.push(byte ^ MASK[i % 4]);
        }

        let written = self.stream.write_all(&frame).await;
        if written.is_err() {
            self.poisoned = true;
        }
        written.map_err(|e| fail(CdpStage::Write, format!("CDP send failed: {}", e)))
    }

    /// Read one text frame, giving up only when `deadline` elapses.
    async fn read_text_frame(&mut self, deadline: Instant) -> Result<String, ReadFailure> {
        loop {
            while self.read_buf.len() < 2 {
                self.fill_buf(deadline).await?;
            }
            let b0 = self.read_buf[0];
            let b1 = self.read_buf[1];
            let opcode = b0 & 0x0F;
            let masked = (b1 & 0x80) != 0;
            let mut len = (b1 & 0x7F) as usize;
            let mut offset = 2usize;

            if len == 126 {
                while self.read_buf.len() < offset + 2 {
                    self.fill_buf(deadline).await?;
                }
                len =
                    u16::from_be_bytes([self.read_buf[offset], self.read_buf[offset + 1]]) as usize;
                offset += 2;
            } else if len == 127 {
                while self.read_buf.len() < offset + 8 {
                    self.fill_buf(deadline).await?;
                }
                let mut bytes = [0u8; 8];
                bytes.copy_from_slice(&self.read_buf[offset..offset + 8]);
                len = u64::from_be_bytes(bytes) as usize;
                offset += 8;
            }

            let mask_len = if masked { 4 } else { 0 };
            let total = offset + mask_len + len;
            while self.read_buf.len() < total {
                self.fill_buf(deadline).await?;
            }

            let mut payload = self.read_buf[offset + mask_len..total].to_vec();
            if masked {
                let mask = &self.read_buf[offset..offset + 4];
                for (i, b) in payload.iter_mut().enumerate() {
                    *b ^= mask[i % 4];
                }
            }
            self.read_buf.drain(..total);

            match opcode {
                0x1 => {
                    return String::from_utf8(payload).map_err(|e| {
                        ReadFailure::Protocol(format!("invalid UTF-8 in CDP frame: {}", e))
                    });
                }
                0x8 => return Err(ReadFailure::PeerClosed),
                0x9 => {
                    // A ping must be answered promptly or the peer may give up.
                    let _ = self.write_frame(0xA, &payload).await;
                }
                0xA => {}
                _ => {}
            }
        }
    }

    async fn fill_buf(&mut self, deadline: Instant) -> Result<(), ReadFailure> {
        let mut tmp = [0u8; 8192];
        let read = timeout_at(deadline, self.stream.read(&mut tmp)).await;
        match read {
            Err(_) => Err(ReadFailure::Deadline),
            Ok(Err(e)) => Err(ReadFailure::Io(e.to_string())),
            Ok(Ok(0)) => Err(ReadFailure::PeerClosed),
            Ok(Ok(n)) => {
                self.read_buf.extend_from_slice(&tmp[..n]);
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::{FakeCdp, Reply};
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// Timeouts small enough to prove timeout behaviour in milliseconds.
    fn fast() -> CdpTimeouts {
        CdpTimeouts {
            connect: Duration::from_millis(500),
            handshake: Duration::from_millis(500),
            call: Duration::from_millis(700),
            nav: Duration::from_millis(1200),
        }
    }

    /// Wrap a `Runtime.evaluate` payload the way CDP does.
    fn eval_ok(value: Value) -> Reply {
        Reply::Ok(json!({ "result": { "value": value } }))
    }

    /// The string `PAGE_FACTS_EXPR` would produce for these observables.
    fn facts(href: &str, ready_state: &str, status: Option<u16>) -> Value {
        Value::String(
            json!({
                "href": href,
                "readyState": ready_state,
                "responseStatus": status,
                "title": "Fixture Title",
            })
            .to_string(),
        )
    }

    fn is_facts_probe(params: &Value) -> bool {
        params
            .get("expression")
            .and_then(|v| v.as_str())
            .is_some_and(|e| e.contains("readyState"))
    }

    #[test]
    fn pick_page_prefers_about_blank_over_internal() {
        let pages = json!([
            {
                "type": "page",
                "url": "edge://sync-confirmation-dialog/",
                "webSocketDebuggerUrl": "ws://127.0.0.1:1/devtools/page/internal"
            },
            {
                "type": "page",
                "url": "about:blank",
                "webSocketDebuggerUrl": "ws://127.0.0.1:1/devtools/page/blank"
            }
        ]);
        assert_eq!(
            pick_page_ws_url(&pages).as_deref(),
            Some("ws://127.0.0.1:1/devtools/page/blank")
        );
    }

    #[test]
    fn pick_page_skips_extensions() {
        let pages = json!([
            {
                "type": "background_page",
                "url": "chrome-extension://abc/bg.html",
                "webSocketDebuggerUrl": "ws://127.0.0.1:1/devtools/page/ext"
            },
            {
                "type": "page",
                "url": "https://cn.bing.com/search?q=x",
                "webSocketDebuggerUrl": "ws://127.0.0.1:1/devtools/page/bing"
            }
        ]);
        assert_eq!(
            pick_page_ws_url(&pages).as_deref(),
            Some("ws://127.0.0.1:1/devtools/page/bing")
        );
    }

    #[test]
    fn new_document_rejects_the_blank_start_page() {
        assert!(!is_new_document("about:blank"));
        assert!(!is_new_document(""));
        assert!(is_new_document("https://example.com/"));
    }

    #[test]
    fn ready_state_gate_accepts_only_loaded_documents() {
        assert!(!is_usable_ready_state("loading"));
        assert!(!is_usable_ready_state(""));
        assert!(is_usable_ready_state("interactive"));
        assert!(is_usable_ready_state("complete"));
    }

    #[test]
    fn bing_search_url_encodes_the_query() {
        assert_eq!(
            bing_search_url(
                crate::config::settings::WebSearchEndpoint::Cn,
                "绝区零 hello"
            ),
            "https://cn.bing.com/search?q=%E7%BB%9D%E5%8C%BA%E9%9B%B6%20hello"
        );
        assert_eq!(
            bing_search_url(crate::config::settings::WebSearchEndpoint::Www, "tokio"),
            "https://www.bing.com/search?q=tokio"
        );
    }

    /// Infrastructure phases are transient and worth one more attempt; a failed
    /// navigation is not, because it failed for a reason.
    #[test]
    fn infrastructure_stages_are_retryable_but_navigation_is_not() {
        for stage in [
            CdpStage::Launch,
            CdpStage::Boot,
            CdpStage::Connect,
            CdpStage::Read,
            CdpStage::Write,
            CdpStage::Session,
        ] {
            assert!(stage.retryable(), "{:?} should be retryable", stage);
        }
        assert!(!CdpStage::Navigate.retryable());
    }

    /// Failures must name their stage, so policy never depends on string parsing.
    #[test]
    fn failures_render_with_their_stage_and_convert_to_app_error() {
        let failure = fail(CdpStage::Boot, "endpoint never answered");
        assert_eq!(failure.stage, CdpStage::Boot);
        assert!(failure.fallback_eligible());
        assert_eq!(failure.to_string(), "browser boot: endpoint never answered");

        let app: AppError = failure.into();
        assert_eq!(
            app.to_string(),
            "Agent error: browser boot: endpoint never answered"
        );
    }

    #[test]
    fn page_facts_never_invent_a_status_code() {
        let none = PageFacts::from_json(&json!({
            "href": "https://blocked.example/",
            "readyState": "complete",
            "responseStatus": null,
            "title": "  百度安全验证  "
        }));
        assert_eq!(none.response_status, None);
        assert_eq!(none.title.as_deref(), Some("百度安全验证"));

        let zero = PageFacts::from_json(&json!({
            "href": "https://blocked.example/",
            "readyState": "complete",
            "responseStatus": 0
        }));
        assert_eq!(zero.response_status, None, "0 is not a status code");

        let ok = PageFacts::from_json(&json!({
            "href": "https://example.com/",
            "readyState": "complete",
            "responseStatus": 200,
            "title": ""
        }));
        assert_eq!(ok.response_status, Some(200));
        assert_eq!(ok.title, None, "a blank title must not become Some(\"\")");
    }

    /// The core regression: the browser starts on `about:blank`, whose
    /// `readyState` is already `"complete"`. The old probe accepted that stale
    /// document and returned before the real page existed.
    #[tokio::test]
    async fn navigation_never_accepts_the_stale_blank_document() {
        let probes = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&probes);
        let fake = FakeCdp::start(Arc::new(move |method, params, _| match method {
            "Page.navigate" => Reply::Ok(json!({"frameId": "F", "loaderId": "L"})),
            "Runtime.evaluate" if is_facts_probe(params) => {
                let seen = counter.fetch_add(1, Ordering::SeqCst);
                if seen < 3 {
                    // The stale about:blank still claims to be complete.
                    eval_ok(facts("about:blank", "complete", None))
                } else {
                    eval_ok(facts("https://example.com/", "complete", Some(200)))
                }
            }
            _ => Reply::Ok(json!({})),
        }));

        let mut page = CdpPage::connect_with(&fake.ws_url(), fast())
            .await
            .expect("connect");
        let facts = page
            .navigate_and_wait("https://example.com/")
            .await
            .expect("navigation must complete once the real document exists");

        assert_eq!(facts.href, "https://example.com/");
        assert_eq!(facts.response_status, Some(200));
        assert!(
            probes.load(Ordering::SeqCst) >= 4,
            "accepted the stale about:blank document after only {} probe(s)",
            probes.load(Ordering::SeqCst)
        );
    }

    /// A document that is new but still loading must also be waited out.
    #[tokio::test]
    async fn navigation_waits_for_a_loading_document() {
        let probes = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&probes);
        let fake = FakeCdp::start(Arc::new(move |method, params, _| match method {
            "Page.navigate" => Reply::Ok(json!({"frameId": "F", "loaderId": "L"})),
            "Runtime.evaluate" if is_facts_probe(params) => {
                let seen = counter.fetch_add(1, Ordering::SeqCst);
                if seen < 2 {
                    eval_ok(facts("https://slow.example/", "loading", None))
                } else {
                    eval_ok(facts("https://slow.example/", "complete", Some(200)))
                }
            }
            _ => Reply::Ok(json!({})),
        }));

        let mut page = CdpPage::connect_with(&fake.ws_url(), fast())
            .await
            .expect("connect");
        let facts = page
            .navigate_and_wait("https://slow.example/")
            .await
            .expect("must wait for the document to finish loading");
        assert_eq!(facts.ready_state, "complete");
        assert!(probes.load(Ordering::SeqCst) >= 3);
    }

    /// A page that never leaves `about:blank` must fail loudly, not silently
    /// return an empty document.
    #[tokio::test]
    async fn navigation_reports_a_stalled_document() {
        let fake = FakeCdp::start(Arc::new(move |method, params, _| match method {
            "Page.navigate" => Reply::Ok(json!({"frameId": "F", "loaderId": "L"})),
            "Runtime.evaluate" if is_facts_probe(params) => {
                eval_ok(facts("about:blank", "loading", None))
            }
            _ => Reply::Ok(json!({})),
        }));

        let mut page = CdpPage::connect_with(&fake.ws_url(), fast())
            .await
            .expect("connect");
        let err = page
            .navigate_and_wait("https://example.com/")
            .await
            .expect_err("a stalled navigation must not report success");
        assert_eq!(err.stage, CdpStage::Navigate);
        let message = err.to_string();
        assert!(message.contains("did not become usable"), "{message}");
        assert!(message.contains("about:blank"), "{message}");
        assert!(!page.is_poisoned(), "a slow page is not a dead session");
    }

    /// `Page.navigate` reports immediate failures (DNS, refused) synchronously;
    /// surfacing that beats waiting out the whole navigation budget.
    #[tokio::test]
    async fn navigation_surfaces_immediate_cdp_failures() {
        let fake = FakeCdp::start(Arc::new(move |method, _params, _| match method {
            "Page.navigate" => {
                Reply::Ok(json!({"frameId": "F", "errorText": "net::ERR_NAME_NOT_RESOLVED"}))
            }
            _ => Reply::Ok(json!({})),
        }));

        let mut page = CdpPage::connect_with(&fake.ws_url(), fast())
            .await
            .expect("connect");
        let err = page
            .navigate_and_wait("https://nope.invalid/")
            .await
            .expect_err("navigation must fail");
        assert_eq!(err.stage, CdpStage::Navigate);
        assert!(err.to_string().contains("ERR_NAME_NOT_RESOLVED"), "{}", err);
    }

    /// The budget governing a call must be the call's own budget: a stalled
    /// request names the method instead of reporting a generic read timeout.
    #[tokio::test]
    async fn a_stalled_request_names_the_method_that_stalled() {
        let fake = FakeCdp::start(Arc::new(move |method, _params, _| match method {
            "Page.enable" | "Runtime.enable" | "DOM.enable" => Reply::Ok(json!({})),
            _ => Reply::Never,
        }));

        let mut page = CdpPage::connect_with(&fake.ws_url(), fast())
            .await
            .expect("connect");
        let err = page
            .call("DOM.getDocument", json!({}))
            .await
            .expect_err("must time out");
        assert_eq!(err.stage, CdpStage::Read);
        let message = err.to_string();
        assert!(message.contains("DOM.getDocument"), "{message}");
        assert!(message.contains("timed out"), "{message}");
        assert!(
            page.is_poisoned(),
            "a mid-frame timeout must retire the session"
        );

        let reuse = page
            .call("Runtime.evaluate", json!({}))
            .await
            .expect_err("a poisoned session must refuse further work");
        assert_eq!(reuse.stage, CdpStage::Session);
        assert!(reuse.to_string().contains("unusable"), "{}", reuse);
    }

    /// A frame delivered in pieces must be reassembled; an inner read timeout
    /// could previously abort a call that still had budget left.
    #[tokio::test]
    async fn a_response_split_across_writes_is_reassembled() {
        let fake = FakeCdp::start(Arc::new(move |method, _params, _| match method {
            "Runtime.evaluate" => Reply::SplitAcrossWrites(
                Duration::from_millis(200),
                json!({"result": {"value": "reassembled"}}),
            ),
            _ => Reply::Ok(json!({})),
        }));

        let mut page = CdpPage::connect_with(&fake.ws_url(), fast())
            .await
            .expect("connect");
        let value = page
            .evaluate_string("1 + 1")
            .await
            .expect("a partially delivered response must not abort the call");
        assert_eq!(value, "reassembled");
        assert!(!page.is_poisoned());
    }

    /// Interleaved CDP events and unparsable frames must not be mistaken for the
    /// response we are waiting for.
    #[tokio::test]
    async fn events_and_noise_are_skipped_until_our_response_arrives() {
        let fake = FakeCdp::start(Arc::new(move |method, _params, _| match method {
            "Runtime.evaluate" => Reply::NoiseThen(
                json!({"method": "Page.frameNavigated", "params": {"frame": {"id": "F"}}}),
                json!({"result": {"value": "ours"}}),
            ),
            _ => Reply::Ok(json!({})),
        }));

        let mut page = CdpPage::connect_with(&fake.ws_url(), fast())
            .await
            .expect("connect");
        let value = page
            .evaluate_string("document.title")
            .await
            .expect("must skip the event and the noise");
        assert_eq!(value, "ours");
    }

    /// A CDP-level error (rather than a transport failure) must be surfaced with
    /// the method name, and must not poison the session: the socket is still in
    /// sync, so subsequent calls remain valid.
    #[tokio::test]
    async fn a_cdp_error_is_reported_without_poisoning_the_session() {
        let fake = FakeCdp::start(Arc::new(move |method, _params, _| match method {
            "DOM.getDocument" => Reply::Err("Cannot find context with specified id".into()),
            _ => Reply::Ok(json!({})),
        }));

        let mut page = CdpPage::connect_with(&fake.ws_url(), fast())
            .await
            .expect("connect");
        let err = page
            .call("DOM.getDocument", json!({}))
            .await
            .expect_err("a CDP error is a failure");
        let message = err.to_string();
        assert!(message.contains("DOM.getDocument"), "{message}");
        assert!(message.contains("Cannot find context"), "{message}");
        assert!(
            !page.is_poisoned(),
            "a protocol error leaves the stream in sync"
        );

        // The session is still usable afterwards.
        assert_eq!(page.evaluate_string("ok").await.expect("still usable"), "");
    }

    /// The handshake must enable the domains the tools depend on, exactly once.
    #[tokio::test]
    async fn connect_enables_the_required_domains() {
        let fake = FakeCdp::start(Arc::new(move |_method, _params, _| Reply::Ok(json!({}))));

        let _page = CdpPage::connect_with(&fake.ws_url(), fast())
            .await
            .expect("connect");

        for method in ["Page.enable", "Runtime.enable", "DOM.enable"] {
            assert_eq!(
                fake.count_of(method),
                1,
                "{method} must be enabled exactly once during connect"
            );
        }
    }

    #[tokio::test]
    async fn a_closed_peer_is_reported_as_such() {
        let fake = FakeCdp::start(Arc::new(move |method, _params, _| match method {
            "Runtime.evaluate" => Reply::Close,
            _ => Reply::Ok(json!({})),
        }));

        let mut page = CdpPage::connect_with(&fake.ws_url(), fast())
            .await
            .expect("connect");
        let err = page
            .evaluate_string("document.title")
            .await
            .expect_err("a closed peer is a failure");
        assert!(err.to_string().contains("closed"), "{}", err);
        assert!(page.is_poisoned());
    }

    /// The selector wait must report "not found" instead of pretending success,
    /// so callers can distinguish "no results" from "wrong page".
    #[tokio::test]
    async fn selector_wait_reports_absence_without_failing() {
        let fake = FakeCdp::start(Arc::new(move |method, params, _| match method {
            "Runtime.evaluate"
                if params
                    .get("expression")
                    .and_then(|v| v.as_str())
                    .is_some_and(|e| e.contains("querySelector")) =>
            {
                eval_ok(Value::String("no".into()))
            }
            _ => Reply::Ok(json!({})),
        }));

        let mut page = CdpPage::connect_with(&fake.ws_url(), fast())
            .await
            .expect("connect");
        let found = page
            .wait_for_selector("li.b_algo", Duration::from_millis(150))
            .await
            .expect("absence is not an error");
        assert!(!found);
    }

    /// Opt-in live check: **one** browser process, two real navigations in the
    /// same session.
    ///
    /// Covers the three things the in-process fake peer cannot:
    /// 1. a real browser actually commits the navigation (the `about:blank`
    ///    race — the old code could accept the stale blank document),
    /// 2. `performance.getEntriesByType('navigation')[0].responseStatus` really
    ///    resolves a status code in the installed Chromium, which is what lets
    ///    `http_get` stop fabricating `200 OK`,
    /// 3. one session can serve several pages sequentially, including moving off
    ///    a Bing SERP onto another site.
    ///
    /// Run with: `cargo test --lib -- --ignored live_single_session`
    #[tokio::test]
    #[ignore = "live: launches one headless Chrome/Edge over the network"]
    async fn live_single_session_serves_two_real_navigations() {
        let urls = vec![
            "https://cn.bing.com/search?q=tokio%20rust%20runtime".to_string(),
            "https://example.com/".to_string(),
        ];
        let pages = fetch_html_many(&urls).await;
        assert_eq!(pages.len(), 2);

        // 1 + 3: the SERP must really load, in a session that then moves on.
        let bing = pages[0].as_ref().expect("the search page must load");
        assert_ne!(
            bing.final_url, "about:blank",
            "the stale blank document was accepted as a navigation"
        );
        assert!(
            bing.final_url.contains("bing.com"),
            "landed somewhere unexpected: {}",
            bing.final_url
        );
        assert!(
            bing.html.len() > 1_000,
            "SERP html is implausibly small ({} bytes)",
            bing.html.len()
        );
        println!(
            "[live] bing  status={:?} title={:?} bytes={} has_results={} challenge={:?}",
            bing.status,
            bing.title,
            bing.html.len(),
            bing.html.contains("b_algo"),
            crate::agent::tools::web_result::detect_challenge(&bing.html, bing.title.as_deref())
                .map(|c| c.vendor)
        );

        // 2: the real status code must be obtainable, not invented.
        let example = pages[1].as_ref().expect("example.com must load");
        assert_ne!(example.final_url, "about:blank");
        assert!(
            example.final_url.contains("example.com"),
            "landed somewhere unexpected: {}",
            example.final_url
        );
        assert_eq!(
            example.status,
            Some(200),
            "responseStatus did not resolve a real HTTP code in this Chromium"
        );
        assert!(
            example.html.contains("Example Domain"),
            "unexpected body: {}",
            &example.html[..example.html.len().min(200)]
        );
        println!(
            "[live] example status={:?} title={:?} bytes={}",
            example.status,
            example.title,
            example.html.len()
        );
    }
}
