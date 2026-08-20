//! Plugin market: fetches the market index (list), per-plugin details
//! (plugin.json + README from the plugin's git repo) and downloads plugin
//! source archives for installation.
//!
//! The market index lives in the market repository
//! (https://github.com/q541810/marcel-ssh-plugins) as a generated `index.json`.
//!
//! Mirror strategy (single configuration, effective everywhere):
//! - User configures a **GitHub acceleration mirror prefix** (e.g.
//!   `https://ghfast.top`) in the market UI. Every GitHub resource — index,
//!   detail files, images, plugin zip archives — is fetched through it.
//! - Legacy configs (a full `index.json` URL) still work for the index only.
//! - Without a custom mirror, built-in defaults apply: jsDelivr CDN for the
//!   index + single files, a built-in mirror list for zip downloads, then
//!   direct GitHub as the last resort.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketIcon {
    pub kind: String,
    pub value: String,
}

/// One entry of the market index.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub icon: Option<MarketIcon>,
    pub repo_url: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketIndex {
    #[serde(default)]
    pub generated_at: String,
    pub plugins: Vec<MarketPlugin>,
}

/// Detail view payload: full plugin.json + README.md fetched from the plugin
/// repo. Both are best-effort (`None` when the repo isn't GitHub-hosted or a
/// fetch fails — the UI degrades to just the index data + open-repo button).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDetail {
    pub manifest: Option<serde_json::Value>,
    pub readme: Option<String>,
}

/// 内置默认 GitHub 加速镜像前缀列表（ghproxy 类，支持整仓 zip 下载）。
/// 域名可能失效——按序尝试，全部失败后回退 GitHub 直连。
/// 用户可在市场页配置自己的镜像前缀，所有 GitHub 资源统一走配置镜像。
const DEFAULT_MIRRORS: &[&str] = &[
    "https://ghfast.top",
    "https://gh-proxy.com",
    "https://ghproxy.net",
];

/// 内置默认市场索引源：jsDelivr CDN 优先（国内可达、上架 Action purge 保实时）。
const DEFAULT_INDEX_SOURCE: &str =
    "https://cdn.jsdelivr.net/gh/q541810/marcel-ssh-plugins@main/index.json";
/// GitHub raw 兜底源（镜像偶发故障时使用；国内网络通常不可达）。
const DEFAULT_INDEX_FALLBACK: &str =
    "https://raw.githubusercontent.com/q541810/marcel-ssh-plugins/HEAD/index.json";

/// 单次下载大小上限（zip 归档）。
const MAX_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;

/// 镜像配置形态。
enum MirrorKind {
    /// 未配置：使用内置默认（jsDelivr 索引 + 内置镜像列表下载）。
    None,
    /// 旧版配置：完整 index.json URL（仅索引有效）。
    IndexUrl(String),
    /// 完整 URL 指向 jsDelivr 域名：单文件镜像（不支持整仓 zip）。
    JsDelivr(String),
    /// GitHub 加速镜像前缀（如 `https://ghfast.top`）。
    Prefix(String),
}

fn classify_mirror(mirror: &str) -> MirrorKind {
    let m = mirror.trim().trim_end_matches('/');
    if m.is_empty() {
        return MirrorKind::None;
    }
    if m.ends_with("index.json") {
        return MirrorKind::IndexUrl(m.to_string());
    }
    if m.contains("cdn.jsdelivr.net") {
        return MirrorKind::JsDelivr(m.to_string());
    }
    MirrorKind::Prefix(m.to_string())
}

fn client_with_proxy() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap_or_default()
}

/// Direct client with system proxy disabled — fallback when the proxied path
/// fails (e.g. proxy settings point at a dead proxy).
fn client_direct() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .no_proxy()
        .build()
        .unwrap_or_default()
}

async fn try_fetch_text(client: &reqwest::Client, url: &str) -> Result<String, reqwest::Error> {
    let resp = client
        .get(url)
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .send()
        .await?;
    let resp = resp.error_for_status()?;
    resp.text().await
}

/// GET a URL as text. Tries the system-proxy client first; if the request
/// fails to even connect, retries once with a direct (no-proxy) client.
async fn fetch_text(url: &str) -> Result<String, AppError> {
    match try_fetch_text(&client_with_proxy(), url).await {
        Ok(text) => Ok(text),
        Err(proxy_err) => match try_fetch_text(&client_direct(), url).await {
            Ok(text) => Ok(text),
            Err(direct_err) => Err(AppError::Network(format!(
                "拉取失败: {}（走代理失败: {}）",
                direct_err, proxy_err
            ))),
        },
    }
}

/// GET a URL as raw bytes with a size cap, using one client.
/// `on_progress` (if any) is called with (received, expected-total) as chunks
/// arrive; total 0 means the server didn't send a Content-Length.
/// GET a URL as raw bytes with a size cap, using one client.
async fn fetch_bytes_once(
    client: &reqwest::Client,
    url: &str,
) -> Result<Vec<u8>, AppError> {
    use futures::StreamExt;

    let resp = client
        .get(url)
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .send()
        .await
        .map_err(|e| AppError::Network(format!("请求失败: {}", e)))?;
    let resp = resp
        .error_for_status()
        .map_err(|e| AppError::Network(format!("请求失败: {}", e)))?;
    if resp.content_length().unwrap_or(0) > MAX_DOWNLOAD_BYTES {
        return Err(AppError::Other("文件超过大小上限，拒绝下载".into()));
    }
    let stream = resp.bytes_stream();
    futures::pin_mut!(stream);
    let mut buf: Vec<u8> = Vec::new();
    let mut total: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Network(format!("下载中断: {}", e)))?;
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD_BYTES {
            return Err(AppError::Other("文件超过大小上限，拒绝下载".into()));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// GET a URL as raw bytes with a size cap. Proxy-first with direct fallback.
async fn fetch_bytes(url: &str) -> Result<Vec<u8>, AppError> {
    match fetch_bytes_once(&client_with_proxy(), url).await {
        Ok(bytes) => Ok(bytes),
        Err(_) => match fetch_bytes_once(&client_direct(), url).await {
            Ok(bytes) => Ok(bytes),
            Err(direct_err) => Err(direct_err),
        },
    }
}

/// Parse a market index JSON document into `MarketIndex`.
/// Kept as a pure function so it can be unit-tested without network.
pub fn parse_market_index(text: &str) -> Result<MarketIndex, AppError> {
    serde_json::from_str(text).map_err(|e| AppError::Other(format!("市场索引格式错误: {}", e)))
}

/// Extract `(owner, repo)` from a `https://github.com/<owner>/<repo>` URL.
/// Returns `None` for non-GitHub URLs or URLs with extra path segments.
pub fn github_repo_parts(repo_url: &str) -> Option<(String, String)> {
    let url = repo_url.trim_end_matches('/');
    let rest = url.strip_prefix("https://github.com/")?;
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?.to_string();
    let repo = parts.next().filter(|s| !s.is_empty())?.to_string();
    if parts.next().is_some() {
        return None;
    }
    Some((owner, repo))
}

// ─── URL construction ──────────────────────────────────────────────────────

/// 市场索引候选 URL：自定义镜像优先，内置默认兜底。
pub fn index_urls(mirror: Option<&str>) -> Vec<String> {
    let mut urls = Vec::new();
    match classify_mirror(mirror.unwrap_or("")) {
        MirrorKind::IndexUrl(u) => urls.push(u),
        MirrorKind::Prefix(p) => urls.push(format!(
            "{}/https://raw.githubusercontent.com/q541810/marcel-ssh-plugins/HEAD/index.json",
            p
        )),
        MirrorKind::JsDelivr(d) => {
            urls.push(format!("{}/gh/q541810/marcel-ssh-plugins@main/index.json", d))
        }
        MirrorKind::None => {}
    }
    urls.push(DEFAULT_INDEX_SOURCE.to_string());
    urls.push(DEFAULT_INDEX_FALLBACK.to_string());
    urls
}

/// GitHub 单文件候选 URL（plugin.json / README 等）。
pub fn raw_file_urls(owner: &str, repo: &str, file: &str, mirror: Option<&str>) -> Vec<String> {
    let mut urls = Vec::new();
    match classify_mirror(mirror.unwrap_or("")) {
        MirrorKind::IndexUrl(_) => {}
        MirrorKind::Prefix(p) => urls.push(format!(
            "{}/https://raw.githubusercontent.com/{}/{}/HEAD/{}",
            p, owner, repo, file
        )),
        MirrorKind::JsDelivr(d) => {
            for branch in ["main", "master"] {
                urls.push(format!("{}/gh/{}/{}@{}/{}", d, owner, repo, branch, file));
            }
        }
        MirrorKind::None => {
            for branch in ["main", "master"] {
                urls.push(format!(
                    "https://cdn.jsdelivr.net/gh/{}/{}@{}/{}",
                    owner, repo, branch, file
                ));
            }
        }
    }
    urls.push(format!(
        "https://raw.githubusercontent.com/{}/{}/HEAD/{}",
        owner, repo, file
    ));
    urls
}

/// 插件源码 zip 候选 URL（main/master 依次）。jsDelivr 与旧版 index.json
/// 配置不支持整仓 zip，直接跳过（回退内置镜像列表与 GitHub 直连）。
pub fn zip_urls(owner: &str, repo: &str, mirror: Option<&str>) -> Vec<String> {
    let mut urls = Vec::new();
    match classify_mirror(mirror.unwrap_or("")) {
        MirrorKind::IndexUrl(_) | MirrorKind::JsDelivr(_) => {}
        MirrorKind::Prefix(p) => {
            for branch in ["main", "master"] {
                urls.push(format!(
                    "{}/https://github.com/{}/{}/archive/refs/heads/{}.zip",
                    p, owner, repo, branch
                ));
            }
        }
        MirrorKind::None => {
            for m in DEFAULT_MIRRORS {
                for branch in ["main", "master"] {
                    urls.push(format!(
                        "{}/https://github.com/{}/{}/archive/refs/heads/{}.zip",
                        m, owner, repo, branch
                    ));
                }
            }
        }
    }
    // GitHub 直连兜底（走系统代理）
    for branch in ["main", "master"] {
        urls.push(format!(
            "https://github.com/{}/{}/archive/refs/heads/{}.zip",
            owner, repo, branch
        ));
    }
    urls
}

// ─── Fetch helpers ─────────────────────────────────────────────────────────

/// Try a list of candidate URLs in order, returning the first success (text).
/// All failures are aggregated into a single readable error.
async fn fetch_first(urls: &[String]) -> Result<String, AppError> {
    let mut errors: Vec<String> = Vec::new();
    for url in urls {
        match fetch_text(url).await {
            Ok(text) => return Ok(text),
            Err(e) => errors.push(format!("{}: {}", url, e)),
        }
    }
    Err(AppError::Network(format!(
        "所有源都不可用（{}）",
        errors.join("；")
    )))
}

/// Try a list of candidate URLs in order, returning the first success (bytes,
/// size-capped). Used for plugin archive downloads.
pub async fn download_first(urls: &[String]) -> Result<Vec<u8>, AppError> {
    let mut errors: Vec<String> = Vec::new();
    for url in urls {
        match fetch_bytes(url).await {
            Ok(bytes) => return Ok(bytes),
            Err(e) => errors.push(format!("{}: {}", url, e)),
        }
    }
    Err(AppError::Network(format!(
        "所有源都不可用（{}）",
        errors.join("；")
    )))
}

/// GET a URL as raw bytes with a size cap, reporting progress and honouring
/// cancellation. `on_progress(received, expected_total)` is called as chunks
/// arrive (total 0 means the server sent no Content-Length). Cancellation is
/// checked between chunks AND during in-flight reads via `cancel_rx`, so a
/// stalled connection can be aborted immediately. A cancelled download returns
/// `AppError::Cancelled`.
async fn fetch_bytes_with_progress(
    url: &str,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<Vec<u8>, AppError> {
    use futures::StreamExt;

    let client = client_with_proxy();
    let mut resp = match client
        .get(url)
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .send()
        .await
        .map_err(|e| AppError::Network(format!("请求失败: {}", e)))
    {
        Ok(r) => r,
        Err(proxy_err) => match client_direct()
            .get(url)
            .header("Cache-Control", "no-cache")
            .header("Pragma", "no-cache")
            .send()
            .await
            .map_err(|e| AppError::Network(format!("请求失败: {}", e)))
        {
            Ok(r) => r,
            Err(direct_err) => {
                return Err(AppError::Network(format!(
                    "拉取失败: {}（走代理失败: {}）",
                    direct_err, proxy_err
                )))
            }
        },
    };
    resp = resp
        .error_for_status()
        .map_err(|e| AppError::Network(format!("请求失败: {}", e)))?;
    let total = resp.content_length().unwrap_or(0);
    if total > MAX_DOWNLOAD_BYTES {
        return Err(AppError::Other("文件超过大小上限，拒绝下载".into()));
    }
    let stream = resp.bytes_stream();
    futures::pin_mut!(stream);
    let mut buf: Vec<u8> = Vec::new();
    let mut received: u64 = 0;
    loop {
        let chunk = tokio::select! {
            chunk = stream.next() => chunk,
            _ = cancel_rx.changed() => {
                return Err(AppError::Cancelled("下载已取消".into()));
            }
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|e| AppError::Network(format!("下载中断: {}", e)))?;
        received += chunk.len() as u64;
        if received > MAX_DOWNLOAD_BYTES {
            return Err(AppError::Other("文件超过大小上限，拒绝下载".into()));
        }
        buf.extend_from_slice(&chunk);
        on_progress(received, total);
    }
    Ok(buf)
}

/// Try a list of candidate URLs in order, returning the first success (bytes,
/// size-capped), with progress reporting and cancellation. Used by plugin
/// install so the frontend can show a live progress bar and let the user abort
/// a stalled download. A cancelled install returns `AppError::Cancelled` and
/// does not try the remaining fallback URLs.
pub async fn download_first_with_progress(
    urls: &[String],
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    on_progress: impl Fn(u64, u64) + Send + Sync,
) -> Result<Vec<u8>, AppError> {
    let mut errors: Vec<String> = Vec::new();
    for url in urls {
        if *cancel_rx.borrow() {
            return Err(AppError::Cancelled("下载已取消".into()));
        }
        match fetch_bytes_with_progress(url, cancel_rx, &on_progress).await {
            Ok(bytes) => return Ok(bytes),
            Err(e @ AppError::Cancelled(_)) => return Err(e),
            Err(e) => errors.push(format!("{}: {}", url, e)),
        }
    }
    Err(AppError::Network(format!(
        "所有源都不可用（{}）",
        errors.join("；")
    )))
}

// ─── Commands ──────────────────────────────────────────────────────────────

fn bust_url(url: &str, ts: i64) -> String {
    if url.contains('?') {
        format!("{}&t={}", url, ts)
    } else {
        format!("{}?t={}", url, ts)
    }
}

/// Fetch the market index. `index_url` carries the user-configured mirror
/// (empty = built-in defaults). Order: custom mirror → jsDelivr → GitHub raw.
/// 为穿透 jsDelivr 12h 边缘缓存（`?t=` 对 cdn.jsdelivr.net 无效），改为并发拉取全部候选源并取 `generatedAt` 最新的那份；
/// 单源失败不影响其它源，全部失败才报错。每次请求仍带 `no-cache` 头与时间戳。
#[tauri::command]
pub async fn market_list(index_url: Option<String>) -> Result<MarketIndex, AppError> {
    let urls = index_urls(index_url.as_deref());
    let ts = chrono::Utc::now().timestamp_millis();
    let busted: Vec<String> = urls.into_iter().map(|u| bust_url(&u, ts)).collect();
    // 并发拉取，取最新的 index
    let futures = busted.iter().map(|u| async {
        let text = fetch_text(u).await.ok()?;
        let idx = parse_market_index(&text).ok()?;
        Some((idx, text))
    });
    let results = futures::future::join_all(futures).await;
    let mut best: Option<(MarketIndex, String)> = None;
    for opt in results.into_iter().flatten() {
        let (idx, _) = &opt;
        let is_newer = match &best {
            None => true,
            Some((best_idx, _)) => idx.generated_at > best_idx.generated_at,
        };
        if is_newer {
            best = Some(opt);
        }
    }
    if let Some((idx, _)) = best {
        return Ok(idx);
    }
    // 降级：串行 fetch_first（保留原错误聚合）
    let text = fetch_first(&busted)
        .await
        .map_err(|e| AppError::Network(format!("拉取市场索引失败: {}", e)))?;
    parse_market_index(&text)
}

/// Fetch plugin.json + README.md from the plugin's GitHub repo, routed through
/// the configured mirror. Non-GitHub repos return empty detail (frontend shows
/// index data only).
#[tauri::command]
pub async fn market_detail(
    repo_url: String,
    mirror: Option<String>,
) -> Result<MarketDetail, AppError> {
    let Some((owner, repo)) = github_repo_parts(&repo_url) else {
        return Ok(MarketDetail {
            manifest: None,
            readme: None,
        });
    };

    let manifest = fetch_first(&raw_file_urls(&owner, &repo, "plugin.json", mirror.as_deref()))
        .await
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());

    // Cap README size — the frontend renders it as markdown in a modal.
    let readme = fetch_first(&raw_file_urls(&owner, &repo, "README.md", mirror.as_deref()))
        .await
        .ok()
        .filter(|t| t.len() <= 256 * 1024);

    Ok(MarketDetail { manifest, readme })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_index() {
        let json = r#"{
            "generatedAt": "2026-08-02T00:00:00Z",
            "plugins": [{
                "id": "marcel-pet",
                "name": "桌宠",
                "version": "1.0.0",
                "publisher": "q541810",
                "minAppVersion": "0.7.1",
                "description": "桌宠",
                "capabilities": ["window.create"],
                "category": "pet",
                "icon": { "kind": "emoji", "value": "🐾" },
                "repoUrl": "https://github.com/q541810/RemielleDan_Pet_Plugin",
                "updatedAt": "2026-08-02"
            }]
        }"#;
        let index = parse_market_index(json).unwrap();
        assert_eq!(index.plugins.len(), 1);
        let p = &index.plugins[0];
        assert_eq!(p.id, "marcel-pet");
        assert_eq!(p.min_app_version.as_deref(), Some("0.7.1"));
        assert_eq!(p.icon.as_ref().unwrap().kind, "emoji");
        assert_eq!(p.repo_url, "https://github.com/q541810/RemielleDan_Pet_Plugin");
    }

    #[test]
    fn parses_index_with_minimal_fields() {
        let json = r#"{
            "plugins": [{ "id": "a", "name": "A", "version": "1.0.0", "repoUrl": "https://github.com/x/y" }]
        }"#;
        let index = parse_market_index(json).unwrap();
        let p = &index.plugins[0];
        assert_eq!(p.min_app_version, None);
        assert!(p.capabilities.is_empty());
        assert_eq!(p.category, "");
        assert_eq!(p.icon, None);
    }

    #[test]
    fn rejects_malformed_index() {
        assert!(parse_market_index("not json").is_err());
        assert!(parse_market_index("{\"plugins\": 42}").is_err());
    }

    #[test]
    fn extracts_github_repo_parts() {
        assert_eq!(
            github_repo_parts("https://github.com/q541810/RemielleDan_Pet_Plugin"),
            Some(("q541810".into(), "RemielleDan_Pet_Plugin".into()))
        );
        assert_eq!(
            github_repo_parts("https://github.com/q541810/repo/"),
            Some(("q541810".into(), "repo".into()))
        );
        assert_eq!(
            github_repo_parts("https://github.com/q541810/repo/tree/main"),
            None
        );
        assert_eq!(github_repo_parts("https://gitee.com/q/repo"), None);
        assert_eq!(github_repo_parts("https://github.com/onlyowner"), None);
        assert_eq!(github_repo_parts(""), None);
    }

    #[test]
    fn classifies_mirror_kinds() {
        assert!(matches!(classify_mirror(""), MirrorKind::None));
        assert!(matches!(classify_mirror("  "), MirrorKind::None));
        assert!(matches!(
            classify_mirror("https://ghfast.top"),
            MirrorKind::Prefix(_)
        ));
        assert!(matches!(
            classify_mirror("https://mirror.example.com/index.json"),
            MirrorKind::IndexUrl(_)
        ));
        assert!(matches!(
            classify_mirror("https://cdn.jsdelivr.net"),
            MirrorKind::JsDelivr(_)
        ));
    }

    #[test]
    fn index_urls_order_matches_mirror_kind() {
        // 无配置：内置默认 + raw 兜底
        let urls = index_urls(None);
        assert_eq!(urls.len(), 2);
        assert!(urls[0].contains("cdn.jsdelivr.net"));
        assert!(urls[1].contains("raw.githubusercontent.com"));

        // 旧版 index.json URL：直接用 + 内置兜底
        let urls = index_urls(Some("https://my.mirror/x/index.json"));
        assert_eq!(urls[0], "https://my.mirror/x/index.json");
        assert_eq!(urls.len(), 3);

        // 前缀镜像：构造 raw 索引 + 内置兜底
        let urls = index_urls(Some("https://ghfast.top"));
        assert_eq!(
            urls[0],
            "https://ghfast.top/https://raw.githubusercontent.com/q541810/marcel-ssh-plugins/HEAD/index.json"
        );
        assert_eq!(urls.len(), 3);

        // jsDelivr：构造 jsDelivr 索引 + 内置兜底
        let urls = index_urls(Some("https://cdn.jsdelivr.net"));
        assert!(urls[0].starts_with("https://cdn.jsdelivr.net/gh/q541810/marcel-ssh-plugins@main/index.json"));
    }

    #[test]
    fn raw_file_urls_cover_all_mirror_kinds() {
        // 无配置：jsDelivr main/master + raw 兜底
        let urls = raw_file_urls("o", "r", "plugin.json", None);
        assert_eq!(urls.len(), 3);
        assert!(urls[0].contains("@main"));
        assert!(urls[1].contains("@master"));
        assert!(urls[2].contains("raw.githubusercontent.com"));

        // 前缀镜像：1 个前缀 URL + raw 兜底
        let urls = raw_file_urls("o", "r", "plugin.json", Some("https://ghfast.top"));
        assert_eq!(urls.len(), 2);
        assert!(urls[0].starts_with("https://ghfast.top/https://raw.githubusercontent.com/o/r/HEAD/plugin.json"));
        assert!(urls[1].contains("raw.githubusercontent.com"));

        // jsDelivr：2 个 jsDelivr + raw 兜底
        let urls = raw_file_urls("o", "r", "plugin.json", Some("https://cdn.jsdelivr.net"));
        assert_eq!(urls.len(), 3);
        assert!(urls[0].contains("@main"));
        assert!(urls[1].contains("@master"));

        // 旧版 index.json：仅 raw 兜底
        let urls = raw_file_urls("o", "r", "plugin.json", Some("https://x/index.json"));
        assert_eq!(urls.len(), 1);
        assert!(urls[0].contains("raw.githubusercontent.com"));
    }

    #[test]
    fn zip_urls_skip_mirrors_that_cannot_serve_archives() {
        // 无配置：内置镜像列表（每个 main/master）+ 直连兜底（main/master）
        let urls = zip_urls("o", "r", None);
        assert_eq!(urls.len(), DEFAULT_MIRRORS.len() * 2 + 2);
        assert!(urls.iter().all(|u| u.ends_with(".zip")));

        // 前缀镜像：2 前缀 + 2 直连
        let urls = zip_urls("o", "r", Some("https://ghfast.top"));
        assert_eq!(urls.len(), 4);
        assert!(urls[0].starts_with("https://ghfast.top/https://github.com/o/r/archive/refs/heads/main.zip"));

        // jsDelivr / 旧版 index.json：无法服务 zip → 仅直连兜底
        let urls = zip_urls("o", "r", Some("https://cdn.jsdelivr.net"));
        assert_eq!(urls.len(), 2);
        let urls = zip_urls("o", "r", Some("https://x/index.json"));
        assert_eq!(urls.len(), 2);
    }

    #[tokio::test]
    async fn download_with_progress_cancelled_before_request() {
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        tx.send(true).unwrap();
        let urls = vec!["https://invalid.example/a.zip".to_string()];
        // 取消已置位：不发起任何请求，直接返回 Cancelled
        let err = download_first_with_progress(&urls, &mut rx, |_, _| {})
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Cancelled(_)));
    }
}
