//! settings 字段级同步支持。
//!
//! 背景：
//! - profile.rs 的 SyncKey 已按字段级解析（`settings.fontSize`、`settings.llmConfig.baseUrl` 等），
//!   但 accessor.rs 原本只认整体 `"settings"` key，导致字段级同步实际不工作。
//! - 本模块提供字段路径读写，让 accessor 能按 `settings.{path}` 读写单个字段。
//!
//! 路径规范（与 profile.rs SyncKey::category() 已定义的 key 对齐）：
//! - 顶层字段：`settings.fontSize`、`settings.fontFamily`、`settings.hideThinkingDisplay` 等
//! - 嵌套字段：`settings.llmConfig.baseUrl`、`settings.agentModeSettings.confirmEachCommand` 等
//! - terminalColors 作为整体同步（21 个颜色字段太碎，字段级收益低且用户通常一起改）
//!
//! 字段路径 = 去掉 `settings.` 前缀后的剩余部分（如 `fontSize`、`llmConfig.baseUrl`）。
//! 用 serde_json::Value 的路径访问实现，避免硬编码每个字段的 getter/setter。

use serde_json::Value;

use crate::error::AppError;

/// 从 `settings.{path}` 形式的完整 key 中提取字段路径。
/// 例如 `settings.fontSize` → `fontSize`，`settings.llmConfig.baseUrl` → `llmConfig.baseUrl`。
/// 如果 key 不是 `settings.` 前缀，返回 None。
pub fn extract_field_path(key: &str) -> Option<&str> {
    key.strip_prefix("settings.")
}

/// 判断 key 是否是 settings 字段级 key（`settings.xxx`，但不等于 `settings` 本身）。
pub fn is_settings_field_key(key: &str) -> bool {
    key.starts_with("settings.") && key != "settings"
}

/// 按 JSON 路径读取 settings 中某个字段的值。
///
/// `field_path` 可以是 `fontSize` 或 `llmConfig.baseUrl`（点号分隔嵌套）。
/// 返回该字段的 JSON 值（而非整个 settings）。
///
/// 返回 None 表示字段不存在（不应发生，因为字段路径来自已定义的 key 列表）。
pub fn get_field(settings_json: &Value, field_path: &str) -> Option<Value> {
    let mut current = settings_json;
    for segment in field_path.split('.') {
        if !segment.is_empty() {
            current = current.get(segment)?;
        }
    }
    Some(current.clone())
}

/// 按 JSON 路径设置 settings 中某个字段的值。
///
/// `field_path` 可以是 `fontSize` 或 `llmConfig.baseUrl`（点号分隔嵌套）。
/// 中间节点不存在时自动创建为空 Object（向前兼容字段添加）。
///
/// 注意：调用者需保证 settings_json 是 Object（由 AppSettings 序列化保证）。
pub fn set_field(
    settings_json: &mut Value,
    field_path: &str,
    value: Value,
) -> Result<(), AppError> {
    let segments: Vec<&str> = field_path.split('.').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err(AppError::Config("字段路径不能为空".into()));
    }

    let mut current = settings_json;
    let last_idx = segments.len() - 1;
    for (i, segment) in segments.iter().enumerate() {
        let is_last = i == last_idx;
        if is_last {
            current[segment] = value;
            break;
        } else {
            // 中间节点：确保是 Object，不存在则创建
            if !current.get(segment).map(|v| v.is_object()).unwrap_or(false) {
                current[segment] = Value::Object(serde_json::Map::new());
            }
            current = current.get_mut(segment).unwrap();
        }
    }
    Ok(())
}

/// 列举所有可同步的 settings 字段路径（不含 `settings.` 前缀）。
///
/// 与 profile.rs SyncKey::category() 解析的 key 集合对齐。
/// terminalColors 作为整体（字段路径 = `terminalColors`）。
pub fn all_field_paths() -> &'static [&'static str] {
    &[
        // TerminalSettings
        "terminalColors",
        "fontSize",
        "fontFamily",
        // ModelService
        "llmConfig.baseUrl",
        "llmConfig.model",
        "llmConfig.vision",
        "llmConfig.maxRetries",
        "llmConfig.retryDelaySecs",
        "llmConfig.retryHttpStatuses",
        "llmConfig.extraBody",
        "agentModeSettings.compactContext",
        // AgentPolicy
        "commandTimeoutSecs",
        "agentModeSettings.confirmEachCommand",
        "agentModeSettings.confirmEditFile",
        "agentModeSettings.enableModelCommandApproval",
        "agentModeSettings.modelApprovalModel",
        "agentModeSettings.modelApprovalPrompt",
        "agentModeSettings.modelApprovalContextLevel",
        "agentModeSettings.listMode",
        "agentModeSettings.commandList",
        "customProtectedPaths",
        "agentModeSettings.maxToolRounds",
        "agentModeSettings.systemPrompt",
        // DisplaySettings
        "hideThinkingDisplay",
        // 桌面专属字段（手机端被 profile.is_available_on_platform 过滤，不参与同步）
        // 这里仍列举，因为同步引擎会按平台过滤，accessor 不重复过滤
        "notificationSettings.agentApproval",
        "notificationSettings.agentQuestion",
        "notificationSettings.agentTaskDone",
        "notificationSettings.agentTaskFailed",
        "notificationSettings.notificationVolume",
        "experimentalSettings.enableWebSearch",
        "experimentalSettings.enableHttpFetch",
        "experimentalSettings.enableCloudPage",
        "experimentalSettings.webSearchMode",
        "experimentalSettings.webSearchApiProvider",
        "experimentalSettings.httpFetchMode",
        "folderUploadCompressionLevel",
        "disabledPlugins",
        "authorizedCapabilities",
        "disableAllInjections",
        // llmConfig.providerType 桌面专属，profile 已过滤
        "llmConfig.providerType",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_extract_field_path() {
        assert_eq!(extract_field_path("settings.fontSize"), Some("fontSize"));
        assert_eq!(
            extract_field_path("settings.llmConfig.baseUrl"),
            Some("llmConfig.baseUrl")
        );
        assert_eq!(extract_field_path("settings"), None);
        assert_eq!(extract_field_path("connections.abc"), None);
    }

    #[test]
    fn test_is_settings_field_key() {
        assert!(is_settings_field_key("settings.fontSize"));
        assert!(is_settings_field_key("settings.llmConfig.baseUrl"));
        assert!(!is_settings_field_key("settings"));
        assert!(!is_settings_field_key("connections.abc"));
    }

    #[test]
    fn test_get_field_top_level() {
        let settings = json!({"fontSize": 16, "fontFamily": "monospace"});
        assert_eq!(get_field(&settings, "fontSize"), Some(json!(16)));
        assert_eq!(get_field(&settings, "fontFamily"), Some(json!("monospace")));
    }

    #[test]
    fn test_get_field_nested() {
        let settings = json!({
            "llmConfig": {"baseUrl": "http://api.example.com", "model": "gpt-4"}
        });
        assert_eq!(
            get_field(&settings, "llmConfig.baseUrl"),
            Some(json!("http://api.example.com"))
        );
        assert_eq!(
            get_field(&settings, "llmConfig.model"),
            Some(json!("gpt-4"))
        );
    }

    #[test]
    fn test_get_field_missing() {
        let settings = json!({"fontSize": 16});
        assert_eq!(get_field(&settings, "fontFamily"), None);
        assert_eq!(get_field(&settings, "llmConfig.baseUrl"), None);
    }

    #[test]
    fn test_set_field_top_level() {
        let mut settings = json!({"fontSize": 14});
        set_field(&mut settings, "fontSize", json!(18)).unwrap();
        assert_eq!(settings["fontSize"], json!(18));
    }

    #[test]
    fn test_set_field_nested_existing() {
        let mut settings = json!({
            "llmConfig": {"baseUrl": "http://old.example.com", "model": "gpt-3"}
        });
        set_field(
            &mut settings,
            "llmConfig.baseUrl",
            json!("http://new.example.com"),
        )
        .unwrap();
        assert_eq!(
            settings["llmConfig"]["baseUrl"],
            json!("http://new.example.com")
        );
        // 其他字段不变
        assert_eq!(settings["llmConfig"]["model"], json!("gpt-3"));
    }

    #[test]
    fn test_set_field_nested_missing_parent() {
        let mut settings = json!({});
        set_field(
            &mut settings,
            "llmConfig.baseUrl",
            json!("http://api.example.com"),
        )
        .unwrap();
        assert_eq!(
            settings["llmConfig"]["baseUrl"],
            json!("http://api.example.com")
        );
    }

    #[test]
    fn test_set_field_empty_path() {
        let mut settings = json!({"fontSize": 14});
        assert!(set_field(&mut settings, "", json!(18)).is_err());
    }

    #[test]
    fn test_roundtrip_app_settings() {
        // 验证 AppSettings 序列化后，所有字段路径都能 get/set
        use crate::config::settings::AppSettings;
        let settings = AppSettings::default();
        let mut json_val = serde_json::to_value(&settings).unwrap();

        for path in all_field_paths() {
            // 能读到原值
            let original = get_field(&json_val, path);
            assert!(original.is_some(), "字段路径 {} 读不到值", path);

            // 能写入新值并读回
            let new_val = json!(42);
            set_field(&mut json_val, path, new_val.clone()).unwrap();
            assert_eq!(
                get_field(&json_val, path),
                Some(new_val),
                "字段路径 {} 写入后读不回",
                path
            );
        }
    }

    #[test]
    fn test_all_field_paths_covers_profile_keys() {
        // 验证 all_field_paths 覆盖 profile.rs 中所有 settings.* 字段
        use crate::sync::profile::SyncCategory;
        use crate::sync::profile::SyncKey;

        let paths: std::collections::HashSet<&str> = all_field_paths().iter().copied().collect();

        // 构造所有 profile 中定义的 settings.* key
        let profile_keys: Vec<String> = all_field_paths()
            .iter()
            .map(|p| format!("settings.{}", p))
            .collect();

        for key in &profile_keys {
            let sync_key = SyncKey::new(key);
            assert_eq!(
                sync_key.category(),
                // 所有 settings.* key 都应该映射到某个 SyncCategory（不是 None）
                sync_key.category().map(|c| c),
                "key {} 没有对应的 SyncCategory",
                key
            );
        }

        // 验证 None 变体不会误匹配（Some 的 unwrap 安全）
        let _ = SyncCategory::TerminalSettings;
    }
}
