//! 三方合并算法（base / ours / theirs）。
//!
//! 借鉴 git merge 的思路，但简化为字段级：
//! - base = 上次同步后的值（来自 LocalVersionTable.last_synced_values）
//! - ours = 当前本地值（通过 accessor.read_value 实时读取）
//! - theirs = pull 下来的解密后值
//!
//! 合并规则（per-key）：
//! - ours == base → 本地没改，用 theirs（远程赢）
//! - theirs == base → 远程没改，用 ours（本地赢）
//! - ours == theirs → 一致，无冲突，用任意一方
//! - 三者都不等 → 冲突，需要用户决策
//!
//! 冲突处理策略：
//! - 自动可合并的 key（settings 字段）：按上述规则
//! - 整体 LWW 的 key（connections/quickCommands/skills/mcpServers）：
//!   仍走 LWW（不合并），但检测"两端都改"时标记为冲突让用户选
//! - 会话（conversations）：特殊处理，见 Phase 4
//!
//! 注意：base 是加密后字符串（来自服务端 push/pull 时的 encrypted_value），
//! ours 和 theirs 是明文 JSON 字符串。比较时需要统一到同一表示：
//! - 如果 base 存在，解密后与 ours/theirs 比较
//! - 简化：直接比较明文，base 在 pull 时解密后再比较
//!
//! 实际实现中，pull 路径解密 theirs 后，需要同时解密 base 用于比较。
//! base 解密后 = `decrypt(last_synced_values[key])`。
//! 为避免每次 pull 都解密 base，我们在 pull 时用 theirs 的加密值
//! 直接与 last_synced_values[key]（也是加密值）比较：
//! - 如果加密值相同 → 明文也相同（AES-GCM 是确定的？不是！GCM 有随机 nonce）
//! - 所以不能比较加密值，必须解密后比较
//!
//! 因此本模块接收明文进行比较，调用方负责解密。

use serde_json::Value;

use crate::sync::settings_field;

/// 三方合并结果。
#[derive(Debug, Clone, PartialEq)]
pub enum MergeResult {
    /// 无冲突，使用此值。
    /// `value` 是 JSON 字符串（明文）。
    Resolved { value: String, source: MergeSource },
    /// 冲突，需要用户决策。
    /// `base` / `ours` / `theirs` 都是 JSON 字符串（明文）。
    Conflict {
        base: Option<String>,
        ours: Option<String>,
        theirs: Option<String>,
    },
    /// 远程是删除标记，本地也删除（无操作）。
    BothDeleted,
}

/// 合并值的来源，用于日志/审计。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeSource {
    /// 本地没改，远程赢
    Theirs,
    /// 远程没改，本地赢
    Ours,
    /// 两端一致
    Both,
    /// 远程是删除（本地未改）
    TheirsDeleted,
    /// 本地是删除（远程未改）
    OursDeleted,
}

/// 对单个 key 执行三方合并。
///
/// 参数都是**明文 JSON 字符串**（或 None 表示删除/不存在）。
/// - `base`：上次同步后的值（来自 last_synced_values，需调用方解密）
/// - `ours`：当前本地值（通过 accessor.read_value 读取）
/// - `theirs`：pull 下来的远程值（已解密）
///
/// 返回合并结果。
pub fn merge_key(
    base: Option<&str>,
    ours: Option<&str>,
    theirs: Option<&str>,
) -> MergeResult {
    // 规范化：None 和空字符串等价（避免 None vs "" 误判冲突）
    let base_str = base.filter(|s| !s.is_empty());
    let ours_str = ours.filter(|s| !s.is_empty());
    let theirs_str = theirs.filter(|s| !s.is_empty());

    // 先比较 ours 和 theirs：如果一致，无冲突
    if ours_str == theirs_str {
        return MergeResult::Resolved {
            value: ours_str.unwrap_or_default().to_string(),
            source: MergeSource::Both,
        };
    }

    // 无共同祖先（base 缺失）= 首次 join / 新 key：以远程为准并 apply。
    // 否则本地默认 settings 与云端一不等就 Conflict，冲突路径不 apply → 新设备永远拿不到数据。
    if base_str.is_none() {
        return match theirs_str {
            Some(v) => MergeResult::Resolved {
                value: v.to_string(),
                source: MergeSource::Theirs,
            },
            None => MergeResult::Resolved {
                value: ours_str.unwrap_or_default().to_string(),
                source: MergeSource::Ours,
            },
        };
    }

    // ours == base → 本地没改 → 用 theirs
    if ours_str == base_str {
        return match theirs_str {
            Some(v) => MergeResult::Resolved {
                value: v.to_string(),
                source: MergeSource::Theirs,
            },
            None => MergeResult::Resolved {
                value: String::new(),
                source: MergeSource::TheirsDeleted,
            },
        };
    }

    // theirs == base → 远程没改 → 用 ours
    if theirs_str == base_str {
        return match ours_str {
            Some(v) => MergeResult::Resolved {
                value: v.to_string(),
                source: MergeSource::Ours,
            },
            None => MergeResult::Resolved {
                value: String::new(),
                source: MergeSource::OursDeleted,
            },
        };
    }

    // 有 base 且三者都不等 → 真冲突（两端都改过）
    MergeResult::Conflict {
        base: base_str.map(|s| s.to_string()),
        ours: ours_str.map(|s| s.to_string()),
        theirs: theirs_str.map(|s| s.to_string()),
    }
}

/// 对 settings 字段做三方合并。
///
/// 与 `merge_key` 相同规则：base 缺失时远程赢（join 新设备）。
///
/// 返回合并结果，调用方根据结果决定 apply 或弹 UI。
pub fn merge_settings_field(
    base_field: Option<&Value>,
    ours_field: Option<&Value>,
    theirs_field: Option<&Value>,
) -> MergeResult {
    // 转为 JSON 字符串比较（保证顺序一致）
    let base_str = base_field.and_then(|v| serde_json::to_string(v).ok());
    let ours_str = ours_field.and_then(|v| serde_json::to_string(v).ok());
    let theirs_str = theirs_field.and_then(|v| serde_json::to_string(v).ok());

    merge_key(
        base_str.as_deref(),
        ours_str.as_deref(),
        theirs_str.as_deref(),
    )
}

/// 检查一个 key 是否是"整体 LWW"类型（不走字段级合并）。
///
/// 这些 key 冲突时仍走 LWW，但会标记为冲突让用户选。
pub fn is_whole_lww_key(key: &str) -> bool {
    key.starts_with("connections.")
        || key.starts_with("quickCommands.")
        || key.starts_with("skills.")
        || key.starts_with("mcpServers.")
        || key == "secrets.llmApiKey"
        || key == "secrets.webSearchApiKey"
}

/// 检查一个 key 是否是 settings 字段级 key（走字段级合并）。
pub fn is_settings_field_merge_key(key: &str) -> bool {
    settings_field::is_settings_field_key(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_merge_no_conflict_both_same() {
        // ours == theirs → 无冲突
        let result = merge_key(Some("v1"), Some("v2"), Some("v2"));
        assert_eq!(
            result,
            MergeResult::Resolved {
                value: "v2".to_string(),
                source: MergeSource::Both
            }
        );
    }

    #[test]
    fn test_merge_no_conflict_ours_unchanged() {
        // ours == base → 本地没改，用 theirs
        let result = merge_key(Some("v1"), Some("v1"), Some("v2"));
        assert_eq!(
            result,
            MergeResult::Resolved {
                value: "v2".to_string(),
                source: MergeSource::Theirs
            }
        );
    }

    #[test]
    fn test_merge_no_conflict_theirs_unchanged() {
        // theirs == base → 远程没改，用 ours
        let result = merge_key(Some("v1"), Some("v2"), Some("v1"));
        assert_eq!(
            result,
            MergeResult::Resolved {
                value: "v2".to_string(),
                source: MergeSource::Ours
            }
        );
    }

    #[test]
    fn test_merge_conflict_both_changed_differently() {
        // 三者都不等 → 冲突
        let result = merge_key(Some("v1"), Some("v2"), Some("v3"));
        assert_eq!(
            result,
            MergeResult::Conflict {
                base: Some("v1".to_string()),
                ours: Some("v2".to_string()),
                theirs: Some("v3".to_string()),
            }
        );
    }

    #[test]
    fn test_merge_no_base_both_have_value_takes_theirs() {
        // base 不存在 + 两端都有不同值 → 首次同步/join：远程赢并 apply
        let result = merge_key(None, Some("v1"), Some("v2"));
        assert_eq!(
            result,
            MergeResult::Resolved {
                value: "v2".to_string(),
                source: MergeSource::Theirs,
            }
        );
    }

    #[test]
    fn test_merge_no_base_ours_only() {
        // base 不存在 + theirs 不存在 + ours 有值 → 本地新增，无冲突
        let result = merge_key(None, Some("v1"), None);
        assert_eq!(
            result,
            MergeResult::Resolved {
                value: "v1".to_string(),
                source: MergeSource::Ours
            }
        );
    }

    #[test]
    fn test_merge_no_base_theirs_only() {
        // base 不存在 + ours 不存在 + theirs 有值 → 远程新增，无冲突
        let result = merge_key(None, None, Some("v1"));
        assert_eq!(
            result,
            MergeResult::Resolved {
                value: "v1".to_string(),
                source: MergeSource::Theirs
            }
        );
    }

    #[test]
    fn test_merge_both_deleted() {
        // 两端都删除（base 有值，ours/theirs 都为 None）
        let result = merge_key(Some("v1"), None, None);
        // ours == theirs == None → 无冲突，值 = ""
        match result {
            MergeResult::Resolved { source, .. } => {
                // source 可能是 Both 或 TheirsDeleted/OursDeleted，取决于比较顺序
                assert!(
                    source == MergeSource::Both
                        || source == MergeSource::TheirsDeleted
                        || source == MergeSource::OursDeleted
                );
            }
            _ => panic!("expected Resolved"),
        }
    }

    #[test]
    fn test_merge_empty_string_treated_as_none() {
        // 空字符串和 None 等价（避免 None vs "" 误判冲突）
        let result = merge_key(Some(""), Some("v1"), Some(""));
        // theirs == base（都是 None/空）→ 用 ours
        match result {
            MergeResult::Resolved {
                source: MergeSource::Ours,
                ..
            } => {}
            _ => panic!("expected Resolved with Ours, got {:?}", result),
        }
    }

    #[test]
    fn test_merge_settings_field_basic() {
        let base = json!(14);
        let ours = json!(14);
        let theirs = json!(16);
        let result = merge_settings_field(Some(&base), Some(&ours), Some(&theirs));
        assert_eq!(
            result,
            MergeResult::Resolved {
                value: "16".to_string(),
                source: MergeSource::Theirs
            }
        );
    }

    #[test]
    fn test_merge_settings_field_conflict() {
        let base = json!(14);
        let ours = json!(16);
        let theirs = json!(18);
        let result = merge_settings_field(Some(&base), Some(&ours), Some(&theirs));
        assert!(matches!(result, MergeResult::Conflict { .. }));
    }

    #[test]
    fn test_is_whole_lww_key() {
        assert!(is_whole_lww_key("connections.abc"));
        assert!(is_whole_lww_key("quickCommands.xyz"));
        assert!(is_whole_lww_key("skills.123"));
        assert!(is_whole_lww_key("mcpServers.m1"));
        assert!(is_whole_lww_key("secrets.llmApiKey"));
        assert!(is_whole_lww_key("secrets.webSearchApiKey"));

        // settings 字段不是 LWW key
        assert!(!is_whole_lww_key("settings.fontSize"));
        assert!(!is_whole_lww_key("settings.llmConfig.baseUrl"));

        // conversations 也不是 LWW（走 Phase 4 fork 逻辑）
        assert!(!is_whole_lww_key("conversations.conv1"));
    }

    #[test]
    fn test_is_settings_field_merge_key() {
        assert!(is_settings_field_merge_key("settings.fontSize"));
        assert!(is_settings_field_merge_key("settings.llmConfig.baseUrl"));
        assert!(!is_settings_field_merge_key("settings")); // 整体 key 不走字段级合并
        assert!(!is_settings_field_merge_key("connections.abc"));
    }

    #[test]
    fn test_merge_no_conflict_ours_changed_theirs_same_as_base() {
        // 本地改了 fontSize 14→16，远程没改（仍是 14）
        let result = merge_key(Some("14"), Some("16"), Some("14"));
        assert_eq!(
            result,
            MergeResult::Resolved {
                value: "16".to_string(),
                source: MergeSource::Ours
            }
        );
    }

    #[test]
    fn test_merge_disjoint_changes_no_conflict() {
        // 模拟场景：桌面改 fontSize，手机改 fontFamily（不同 key，不会到同一 merge_key 调用）
        // 这里测试同 key 不冲突的场景
        let result = merge_key(Some("14"), Some("16"), Some("14"));
        assert!(matches!(result, MergeResult::Resolved { .. }));
    }
}
