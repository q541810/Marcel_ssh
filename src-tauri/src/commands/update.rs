use std::time::Duration;

use serde::Serialize;
use tauri_plugin_shell::ShellExt;

use crate::error::AppError;

const DEFAULT_RELEASE_URL: &str = "https://github.com/q541810/Marcel_ssh/releases";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub latest_version: String,
    pub release_url: String,
}

/// Pick the latest version info for the running platform from `latest.json`.
///
/// Desktop reads the top-level `version` / `release_url`. Android reads the
/// nested `android` object; when the field is missing (old `latest.json`
/// without platform separation) it falls back to the top level, which is
/// equivalent since historic releases shipped both platforms together.
fn pick_latest(latest: &serde_json::Value, is_android: bool) -> (String, String) {
    let read = |v: &serde_json::Value, key: &str, default: &str| -> String {
        v.get(key)
            .and_then(|x| x.as_str())
            .unwrap_or(default)
            .to_string()
    };

    let target = if is_android {
        latest
            .get("android")
            .filter(|v| v.is_object())
            .unwrap_or(latest)
    } else {
        latest
    };

    (
        read(target, "version", ""),
        read(target, "release_url", DEFAULT_RELEASE_URL),
    )
}

/// Open a URL in the system browser.
///
/// Uses `ShellExt::open` so Android hits the shell plugin Intent path
/// (`ACTION_VIEW`). The JS `plugin:shell|open` command always goes through
/// the desktop `open` crate (xdg-open), which is a no-op on Android.
#[tauri::command]
pub async fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err(AppError::Other(format!("不允许打开的链接: {}", trimmed)));
    }
    #[allow(deprecated)]
    app.shell()
        .open(trimmed, None)
        .map_err(|e| AppError::Other(format!("打开浏览器失败: {}", e)))
}

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<UpdateCheckResult, AppError> {
    let current_version = app.package_info().version.to_string();
    let user_agent = format!("Marcel-SSH/{}", current_version);

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent(&user_agent)
        .build()
        .map_err(|e| AppError::Update(format!("无法创建 HTTP 客户端: {}", e)))?;

    let resp = client
        .get("https://raw.githubusercontent.com/q541810/Marcel_ssh/main/latest.json")
        .send()
        .await
        .map_err(|e| {
            let msg = if e.is_timeout() {
                "网络连接超时，请检查网络后重试"
            } else if e.is_connect() {
                "无法连接到更新服务器，请检查网络"
            } else {
                "无法检查更新"
            };
            AppError::Update(format!("{}: {}", msg, e))
        })?;

    let latest: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Update(format!("解析更新信息失败: {}", e)))?;

    let (latest_version, release_url) = pick_latest(&latest, cfg!(target_os = "android"));

    let has_update = {
        let cur = semver::Version::parse(&current_version).ok();
        let lat = semver::Version::parse(&latest_version).ok();
        match (cur, lat) {
            (Some(c), Some(l)) => l > c,
            _ => false,
        }
    };

    Ok(UpdateCheckResult {
        has_update,
        latest_version,
        release_url,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn desktop_reads_top_level() {
        let latest = json!({
            "version": "0.8.1",
            "release_url": "https://github.com/q541810/Marcel_ssh/releases/tag/v0.8.1",
            "android": {
                "version": "0.8.0",
                "release_url": "https://github.com/q541810/Marcel_ssh/releases/tag/v0.8.0"
            }
        });
        let (v, url) = pick_latest(&latest, false);
        assert_eq!(v, "0.8.1");
        assert_eq!(
            url,
            "https://github.com/q541810/Marcel_ssh/releases/tag/v0.8.1"
        );
    }

    #[test]
    fn android_reads_android_field() {
        let latest = json!({
            "version": "0.8.1",
            "release_url": "https://github.com/q541810/Marcel_ssh/releases/tag/v0.8.1",
            "android": {
                "version": "0.8.0",
                "release_url": "https://github.com/q541810/Marcel_ssh/releases/tag/v0.8.0"
            }
        });
        let (v, url) = pick_latest(&latest, true);
        assert_eq!(v, "0.8.0");
        assert_eq!(
            url,
            "https://github.com/q541810/Marcel_ssh/releases/tag/v0.8.0"
        );
    }

    #[test]
    fn android_falls_back_to_top_level_when_android_field_missing() {
        let latest = json!({
            "version": "0.8.0",
            "release_url": "https://github.com/q541810/Marcel_ssh/releases/tag/v0.8.0"
        });
        let (v, url) = pick_latest(&latest, true);
        assert_eq!(v, "0.8.0");
        assert_eq!(
            url,
            "https://github.com/q541810/Marcel_ssh/releases/tag/v0.8.0"
        );
    }

    #[test]
    fn android_falls_back_to_top_level_when_android_field_not_object() {
        let latest = json!({
            "version": "0.8.0",
            "release_url": "https://github.com/q541810/Marcel_ssh/releases/tag/v0.8.0",
            "android": "0.8.0"
        });
        let (v, _url) = pick_latest(&latest, true);
        assert_eq!(v, "0.8.0");
    }

    #[test]
    fn missing_fields_use_defaults() {
        let latest = json!({});
        let (v, url) = pick_latest(&latest, false);
        assert_eq!(v, "");
        assert_eq!(url, DEFAULT_RELEASE_URL);
        let (v, url) = pick_latest(&latest, true);
        assert_eq!(v, "");
        assert_eq!(url, DEFAULT_RELEASE_URL);
    }
}
