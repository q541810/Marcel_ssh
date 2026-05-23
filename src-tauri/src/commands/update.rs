use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub latest_version: String,
    pub release_url: String,
}

#[tauri::command]
pub async fn check_update(
    app: tauri::AppHandle,
) -> Result<UpdateCheckResult, String> {
    let current_version = app
        .package_info()
        .version
        .to_string();

    let resp = reqwest::get(
        "https://raw.githubusercontent.com/q541810/Marcel_ssh/main/latest.json",
    )
    .await
    .map_err(|e| format!("无法检查更新: {}", e))?;

    let latest: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析更新信息失败: {}", e))?;

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
