use std::time::Duration;

use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub latest_version: String,
    pub release_url: String,
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

    let latest_version = latest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let release_url = latest
        .get("release_url")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/q541810/Marcel_ssh/releases")
        .to_string();

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
