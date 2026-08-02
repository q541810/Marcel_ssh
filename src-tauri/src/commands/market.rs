//! Plugin market: fetches the market index (list) and per-plugin details
//! (plugin.json + README from the plugin's git repo).
//!
//! The market index lives in the market repository
//! (https://github.com/q541810/marcel-ssh-plugins) as a generated `index.json`.
//! "Download" is intentionally NOT implemented here — the client just opens
//! the plugin repo page in the system browser and the user installs manually.

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

/// 内置默认源：jsDelivr CDN 镜像优先（国内可达、上架 Action 会 purge 缓存保持实时）。
const MIRROR_SOURCE: &str = "https://cdn.jsdelivr.net/gh/q541810/marcel-ssh-plugins@main/index.json";
/// GitHub raw 兜底源（镜像偶发故障时使用；国内网络通常不可达）。
const DEFAULT_SOURCE: &str = "https://raw.githubusercontent.com/q541810/marcel-ssh-plugins/HEAD/index.json";

fn client_with_proxy() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

/// Direct client with system proxy disabled — fallback when the proxied path
/// fails (e.g. proxy settings point at a dead proxy).
fn client_direct() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .unwrap_or_default()
}

async fn try_fetch(client: &reqwest::Client, url: &str) -> Result<String, reqwest::Error> {
    let resp = client.get(url).send().await?;
    let resp = resp.error_for_status()?;
    resp.text().await
}

/// GET a URL as text. Tries the system-proxy client first; if the request
/// fails to even connect, retries once with a direct (no-proxy) client.
async fn fetch_text(url: &str) -> Result<String, AppError> {
    match try_fetch(&client_with_proxy(), url).await {
        Ok(text) => Ok(text),
        Err(proxy_err) => match try_fetch(&client_direct(), url).await {
            Ok(text) => Ok(text),
            Err(direct_err) => Err(AppError::Network(format!(
                "拉取失败: {}（走代理失败: {}）",
                direct_err, proxy_err
            ))),
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
fn github_repo_parts(repo_url: &str) -> Option<(String, String)> {
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

/// Try a list of candidate URLs in order, returning the first success.
/// All failures are aggregated into a single readable error.
async fn fetch_first(urls: &[String]) -> Result<String, AppError> {
    let mut errors: Vec<String> = Vec::new();
    for url in urls {
        match fetch_text(url).await {
            Ok(text) => return Ok(text),
            Err(e) => errors.push(format!("{}: {}", url, e)),
        }
    }
    Err(AppError::Network(format!("所有源都不可用（{}）", errors.join("；"))))
}

/// Fetch a file from a GitHub repo. Mirror-first: jsDelivr CDN (branch name
/// unknown → try `main` then `master`), then GitHub raw as a last resort.
async fn fetch_github_raw(owner: &str, repo: &str, file: &str) -> Option<String> {
    for branch in ["main", "master"] {
        let mirror = format!("https://cdn.jsdelivr.net/gh/{}/{}@{}/{}", owner, repo, branch, file);
        if let Ok(text) = fetch_text(&mirror).await {
            return Some(text);
        }
    }
    let primary = format!("https://raw.githubusercontent.com/{}/{}/HEAD/{}", owner, repo, file);
    fetch_text(&primary).await.ok()
}

/// Fetch the market index. Custom source (if any) first, then the built-in
/// jsDelivr mirror (default), then GitHub raw as the last resort.
#[tauri::command]
pub async fn market_list(index_url: Option<String>) -> Result<MarketIndex, AppError> {
    let mut urls: Vec<String> = Vec::new();
    if let Some(u) = index_url.filter(|s| !s.trim().is_empty()) {
        if u != MIRROR_SOURCE && u != DEFAULT_SOURCE {
            urls.push(u);
        }
    }
    urls.push(MIRROR_SOURCE.to_string());
    urls.push(DEFAULT_SOURCE.to_string());
    let text = fetch_first(&urls)
        .await
        .map_err(|e| AppError::Network(format!("拉取市场索引失败: {}", e)))?;
    parse_market_index(&text)
}

/// Fetch plugin.json + README.md from the plugin's GitHub repo.
/// Non-GitHub repos return empty detail (frontend shows index data only).
#[tauri::command]
pub async fn market_detail(repo_url: String) -> Result<MarketDetail, AppError> {
    let Some((owner, repo)) = github_repo_parts(&repo_url) else {
        return Ok(MarketDetail {
            manifest: None,
            readme: None,
        });
    };

    let manifest = fetch_github_raw(&owner, &repo, "plugin.json")
        .await
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());

    let readme = fetch_github_raw(&owner, &repo, "README.md").await;
    // Cap README size — the frontend renders it as markdown in a modal.
    let readme = readme.filter(|t| t.len() <= 256 * 1024);

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
}
