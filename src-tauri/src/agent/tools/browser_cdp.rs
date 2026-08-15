//! Shared local headless Chrome/Edge CDP helpers for web_search / http_get.
//!
//! Minimal WebSocket client over plain TCP (CDP is always ws://127.0.0.1).

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use base64::Engine;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::error::AppError;

const NAV_TIMEOUT: Duration = Duration::from_secs(30);
const BROWSER_BOOT_TIMEOUT: Duration = Duration::from_secs(12);
const SETTLE_AFTER_READY: Duration = Duration::from_millis(500);

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

/// Fetch a single URL's rendered HTML via a short-lived headless browser.
pub async fn fetch_html(url: &str) -> Result<BrowserPage, AppError> {
    with_browser(|mut page| async move {
        page.navigate(url).await?;
        page.wait_ready().await?;
        tokio::time::sleep(SETTLE_AFTER_READY).await;
        let html = page.get_outer_html().await?;
        let final_url = page
            .evaluate_string("location.href")
            .await
            .unwrap_or_else(|_| url.to_string());
        let title = page
            .evaluate_string("document.title || ''")
            .await
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());
        Ok(BrowserPage {
            requested_url: url.to_string(),
            final_url,
            title,
            html,
        })
    })
    .await
}

/// Fetch multiple URLs sequentially in one browser process (much cheaper than
/// spawning per URL).
pub async fn fetch_html_many(urls: &[String]) -> Vec<Result<BrowserPage, AppError>> {
    if urls.is_empty() {
        return Vec::new();
    }
    if urls.len() == 1 {
        return vec![fetch_html(&urls[0]).await];
    }

    let owned: Vec<String> = urls.to_vec();
    match with_browser(|mut page| async move {
        let mut out = Vec::with_capacity(owned.len());
        for url in &owned {
            let result = async {
                page.navigate(url).await?;
                page.wait_ready().await?;
                tokio::time::sleep(SETTLE_AFTER_READY).await;
                let html = page.get_outer_html().await?;
                let final_url = page
                    .evaluate_string("location.href")
                    .await
                    .unwrap_or_else(|_| url.clone());
                let title = page
                    .evaluate_string("document.title || ''")
                    .await
                    .ok()
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty());
                Ok(BrowserPage {
                    requested_url: url.clone(),
                    final_url,
                    title,
                    html,
                })
            }
            .await;
            out.push(result);
        }
        Ok(out)
    })
    .await
    {
        Ok(results) => results,
        Err(e) => urls
            .iter()
            .map(|_| Err(AppError::Agent(format!("browser session failed: {}", e))))
            .collect(),
    }
}


#[derive(Debug, Clone)]
pub struct BrowserPage {
    pub requested_url: String,
    pub final_url: String,
    pub title: Option<String>,
    pub html: String,
}

async fn with_browser<F, Fut, T>(f: F) -> Result<T, AppError>
where
    F: FnOnce(CdpPage) -> Fut,
    Fut: std::future::Future<Output = Result<T, AppError>>,
{
    let browser = find_browser_binary().ok_or_else(|| {
        AppError::Agent(
            "no local Chrome/Edge found; install Chrome or Edge, or switch web mode to HTML/API"
                .into(),
        )
    })?;

    let session = spawn_browser(&browser)?;
    let page_ws = open_page_ws(session.port).await?;
    let page = CdpPage::connect(&page_ws).await?;
    let result = f(page).await;
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

fn pick_free_port() -> Result<u16, AppError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::Agent(format!("failed to allocate debug port: {}", e)))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Agent(format!("failed to read debug port: {}", e)))?
        .port();
    drop(listener);
    Ok(port)
}

fn spawn_browser(binary: &PathBuf) -> Result<BrowserSession, AppError> {
    let port = pick_free_port()?;
    let user_data_dir = std::env::temp_dir().join(format!(
        "marcel-browser-{}-{}",
        std::process::id(),
        port
    ));
    std::fs::create_dir_all(&user_data_dir)
        .map_err(|e| AppError::Agent(format!("failed to create browser profile dir: {}", e)))?;

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
        .map_err(|e| AppError::Agent(format!("failed to start browser: {}", e)))?;

    Ok(BrowserSession {
        child,
        port,
        user_data_dir,
    })
}

async fn open_page_ws(port: u16) -> Result<String, AppError> {
    let list_url = format!("http://127.0.0.1:{}/json/list", port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| AppError::Agent(format!("HTTP client error: {}", e)))?;

    let deadline = tokio::time::Instant::now() + BROWSER_BOOT_TIMEOUT;
    loop {
        if tokio::time::Instant::now() > deadline {
            return Err(AppError::Agent(
                "browser CDP endpoint did not become ready in time".into(),
            ));
        }

        match client.get(&list_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let pages: Value = resp
                    .json()
                    .await
                    .map_err(|e| AppError::Agent(format!("invalid CDP list JSON: {}", e)))?;
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

struct CdpPage {
    stream: TcpStream,
    next_id: u64,
    read_buf: Vec<u8>,
}

impl CdpPage {
    async fn connect(ws_url: &str) -> Result<Self, AppError> {
        let without_scheme = ws_url.strip_prefix("ws://").ok_or_else(|| {
            AppError::Agent(format!("unsupported CDP URL (need ws://): {}", ws_url))
        })?;
        let (host_port, path) = without_scheme
            .split_once('/')
            .map(|(h, p)| (h, format!("/{}", p)))
            .unwrap_or((without_scheme, "/".to_string()));

        let mut stream = timeout(Duration::from_secs(8), TcpStream::connect(host_port))
            .await
            .map_err(|_| AppError::Agent("CDP tcp connect timed out".into()))?
            .map_err(|e| AppError::Agent(format!("CDP tcp connect failed: {}", e)))?;

        let key = {
            let mut bytes = [0u8; 16];
            for (i, b) in bytes.iter_mut().enumerate() {
                *b = ((std::process::id() as u8).wrapping_add(i as u8).wrapping_mul(17)) ^ 0x5A;
            }
            base64::engine::general_purpose::STANDARD.encode(bytes)
        };

        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        stream
            .write_all(req.as_bytes())
            .await
            .map_err(|e| AppError::Agent(format!("CDP handshake write failed: {}", e)))?;

        let mut header_buf = Vec::with_capacity(1024);
        let mut tmp = [0u8; 256];
        loop {
            let n = timeout(Duration::from_secs(5), stream.read(&mut tmp))
                .await
                .map_err(|_| AppError::Agent("CDP handshake read timed out".into()))?
                .map_err(|e| AppError::Agent(format!("CDP handshake read failed: {}", e)))?;
            if n == 0 {
                return Err(AppError::Agent("CDP handshake closed early".into()));
            }
            header_buf.extend_from_slice(&tmp[..n]);
            if header_buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
            if header_buf.len() > 16_384 {
                return Err(AppError::Agent("CDP handshake headers too large".into()));
            }
        }

        let header_text = String::from_utf8_lossy(&header_buf);
        if !header_text.starts_with("HTTP/1.1 101") && !header_text.contains(" 101 ") {
            return Err(AppError::Agent(format!(
                "CDP websocket upgrade failed: {}",
                header_text.lines().next().unwrap_or("?")
            )));
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
        };
        page.call("Page.enable", serde_json::json!({})).await?;
        page.call("Runtime.enable", serde_json::json!({})).await?;
        let _ = page.call("DOM.enable", serde_json::json!({})).await;
        Ok(page)
    }

    async fn navigate(&mut self, url: &str) -> Result<(), AppError> {
        self.call("Page.navigate", serde_json::json!({ "url": url }))
            .await?;
        Ok(())
    }

    async fn wait_ready(&mut self) -> Result<(), AppError> {
        let deadline = tokio::time::Instant::now() + NAV_TIMEOUT;
        loop {
            if tokio::time::Instant::now() > deadline {
                return Err(AppError::Agent("page navigation timed out".into()));
            }
            let ready = self
                .evaluate_string("document.readyState")
                .await
                .unwrap_or_default();
            if ready == "interactive" || ready == "complete" {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    async fn wait_for_selector(
        &mut self,
        selector: &str,
        max_wait: Duration,
    ) -> Result<(), AppError> {
        let deadline = tokio::time::Instant::now() + max_wait;
        let expr = format!(
            "document.querySelector({}) ? 'yes' : 'no'",
            serde_json::to_string(selector).unwrap_or_else(|_| "\"body\"".into())
        );
        loop {
            if tokio::time::Instant::now() > deadline {
                return Ok(());
            }
            let val = self.evaluate_string(&expr).await.unwrap_or_default();
            if val == "yes" {
                tokio::time::sleep(Duration::from_millis(300)).await;
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    async fn get_outer_html(&mut self) -> Result<String, AppError> {
        if let Ok(doc) = self
            .call("DOM.getDocument", serde_json::json!({ "depth": 0 }))
            .await
        {
            if let Some(node_id) = doc.pointer("/root/nodeId").and_then(|v| v.as_i64()) {
                if let Ok(html) = self
                    .call(
                        "DOM.getOuterHTML",
                        serde_json::json!({ "nodeId": node_id }),
                    )
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
        self.evaluate_string("document.documentElement.outerHTML")
            .await
    }

    async fn evaluate_string(&mut self, expression: &str) -> Result<String, AppError> {
        let result = self
            .call(
                "Runtime.evaluate",
                serde_json::json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )
            .await?;

        if let Some(exc) = result.pointer("/exceptionDetails") {
            return Err(AppError::Agent(format!("browser JS error: {}", exc)));
        }

        let value = result
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null);

        match value {
            Value::String(s) => Ok(s),
            other => Ok(other.to_string()),
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, AppError> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        self.write_text_frame(&msg.to_string()).await?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            if tokio::time::Instant::now() > deadline {
                return Err(AppError::Agent(format!(
                    "CDP response timed out for {}",
                    method
                )));
            }

            let text = self.read_text_frame().await?;
            let v: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue,
            };

            if v.get("id").and_then(|x| x.as_u64()) != Some(id) {
                continue;
            }

            if let Some(err) = v.get("error") {
                return Err(AppError::Agent(format!("CDP {} error: {}", method, err)));
            }

            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn write_text_frame(&mut self, text: &str) -> Result<(), AppError> {
        let payload = text.as_bytes();
        let mut frame = Vec::with_capacity(2 + 8 + 4 + payload.len());
        frame.push(0x81);
        let mask_bit = 0x80u8;
        if payload.len() < 126 {
            frame.push(mask_bit | (payload.len() as u8));
        } else if payload.len() <= 65535 {
            frame.push(mask_bit | 126);
            frame.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        } else {
            frame.push(mask_bit | 127);
            frame.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        }
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        frame.extend_from_slice(&mask);
        for (i, b) in payload.iter().enumerate() {
            frame.push(b ^ mask[i % 4]);
        }
        self.stream
            .write_all(&frame)
            .await
            .map_err(|e| AppError::Agent(format!("CDP send failed: {}", e)))
    }

    async fn read_text_frame(&mut self) -> Result<String, AppError> {
        loop {
            while self.read_buf.len() < 2 {
                self.fill_buf().await?;
            }
            let b0 = self.read_buf[0];
            let b1 = self.read_buf[1];
            let opcode = b0 & 0x0F;
            let masked = (b1 & 0x80) != 0;
            let mut len = (b1 & 0x7F) as usize;
            let mut offset = 2usize;

            if len == 126 {
                while self.read_buf.len() < offset + 2 {
                    self.fill_buf().await?;
                }
                len = u16::from_be_bytes([self.read_buf[offset], self.read_buf[offset + 1]])
                    as usize;
                offset += 2;
            } else if len == 127 {
                while self.read_buf.len() < offset + 8 {
                    self.fill_buf().await?;
                }
                let mut bytes = [0u8; 8];
                bytes.copy_from_slice(&self.read_buf[offset..offset + 8]);
                len = u64::from_be_bytes(bytes) as usize;
                offset += 8;
            }

            let mask_len = if masked { 4 } else { 0 };
            let total = offset + mask_len + len;
            while self.read_buf.len() < total {
                self.fill_buf().await?;
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
                    return String::from_utf8(payload)
                        .map_err(|e| AppError::Agent(format!("invalid UTF-8 in CDP frame: {}", e)));
                }
                0x8 => return Err(AppError::Agent("CDP websocket closed by peer".into())),
                0x9 => {
                    let mut pong = Vec::with_capacity(2 + payload.len());
                    pong.push(0x8A);
                    pong.push(0x80 | (payload.len() as u8).min(125));
                    let mask = [0x11u8, 0x22, 0x33, 0x44];
                    pong.extend_from_slice(&mask);
                    for (i, b) in payload.iter().enumerate() {
                        pong.push(b ^ mask[i % 4]);
                    }
                    let _ = self.stream.write_all(&pong).await;
                }
                0xA => {}
                _ => {}
            }
        }
    }

    async fn fill_buf(&mut self) -> Result<(), AppError> {
        let mut tmp = [0u8; 8192];
        let n = timeout(Duration::from_secs(10), self.stream.read(&mut tmp))
            .await
            .map_err(|_| AppError::Agent("CDP read timed out".into()))?
            .map_err(|e| AppError::Agent(format!("CDP read failed: {}", e)))?;
        if n == 0 {
            return Err(AppError::Agent("CDP websocket closed".into()));
        }
        self.read_buf.extend_from_slice(&tmp[..n]);
        Ok(())
    }
}

/// Search Bing SERP HTML via browser (used by web_search browser mode).
pub async fn fetch_bing_search_html(
    endpoint: crate::config::settings::WebSearchEndpoint,
    query: &str,
) -> Result<String, AppError> {
    use crate::agent::tools::web_search::urlencoding;

    with_browser(|mut page| async move {
        let host = match endpoint {
            crate::config::settings::WebSearchEndpoint::Cn => "https://cn.bing.com",
            crate::config::settings::WebSearchEndpoint::Www => "https://www.bing.com",
        };
        let url = format!(
            "{}/search?q={}",
            host,
            urlencoding::encode(query)
        );
        page.navigate(&url).await?;
        page.wait_ready().await?;
        page.wait_for_selector("li.b_algo", Duration::from_secs(18))
            .await?;
        page.get_outer_html().await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::pick_page_ws_url;
    use serde_json::json;

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
}
