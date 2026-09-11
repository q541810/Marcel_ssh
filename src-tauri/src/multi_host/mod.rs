//! 多机操控（Multi-Host Agent）—— 桌面端目标解析与管理层。
//!
//! 职责边界（manager）：
//! - **机器 → 会话解析**：把工具参数里的机器可读引用（SavedConnection.name，
//!   重名时去重后缀）解析为 configId → 在线 session_id；离线且有凭证时静默
//!   拉起一条后台会话（复用 `SshManager` / `command_exec`，**不另起执行体系**）。
//! - **白名单**：`host` 可引用的机器 = 「当前会话所在机器（恒可）」∪
//!   `experimental_settings.multi_host_connection_ids` 勾选集合（防止模型幻觉
//!   指向未授权主机）。多机操控桌面端**恒开启**（无开关）。
//! - **自动拉起会话记账**：自动拉起的会话归属到发起任务，任务/对话终态时
//!   级联关闭（用户已在线打开的会话绝不被关闭）。
//! - **门控**：双端恒开启（与桌面语义一致：无总开关，范围由白名单控制）。
//!   移动端 `multiHostConnectionIds` 默认空 → 仅当前机可执行；勾选后可跨机。
//!
//! 安全约定：
//! - 凭证（密码/私钥 passphrase）只在 Rust 侧从 keychain 读取，绝不进入
//!   WebView、绝不写入日志；与 `commands/ssh.rs` 的静默连接同源。
//! - 自动拉起只发生在「勾选集合内 + keychain 有凭证」；其余情况给明确错误。
//!
//! 复用原则：本模块**不**自建命令执行、不持有第二个会话表——一律经
//! `AppState::ssh_manager`（含 generation 防 stale、断连观察者级联取消）与
//! `AppState::command_exec`（统一 ticket / 取消注册 / 断连级联 / 后台作业）。

use tauri::Manager;

use crate::error::AppError;
use crate::ssh::connection::ConnectionConfig;
use crate::AppState;

/// 目标机器解析结果：确定要操作的会话 + 机器展示信息。
#[derive(Debug, Clone)]
pub struct ResolvedTarget {
    /// 实际执行所在的 SSH session id（在线既有或本次自动拉起）。
    pub session_id: String,
    /// 对应 SavedConnection id。
    pub config_id: String,
    /// 是否本次自动拉起的会话（任务终态时据此关闭）。
    pub auto_spawned: bool,
    /// 展示用主机名（用户可读，审批/卡片 badge 用；脱敏由前端做）。
    pub host_label: String,
}

/// 多机功能是否可用（双端恒开启）。
/// 与桌面语义一致：无总开关；可跨机范围由 `multi_host_connection_ids`
/// 白名单控制（空集合 = 仅当前机）。保留此辅助以便未来按设置收紧，
/// 当前所有调用点共用同一策略，避免双端门控再次分叉。
pub(crate) async fn multi_host_enabled(state: &AppState) -> bool {
    let _ = state;
    true
}

/// 解析一个机器引用为可操作的会话。
///
/// 白名单语义（安全边界）：`host` 可引用的机器 = 「当前会话所在机器（恒可）」
/// ∪ `multi_host_connection_ids` 勾选集合（按 SavedConnection.name 匹配，重名
/// 时允许后缀消歧），否则拒绝——即使机器在线也不执行。
///
/// 会话选择：
/// - `host` 命中当前会话所在机器（`current_session_id` 的 config_id）→ 直接用
///   当前会话（不换机、不拉起）；
/// - 其他白名单机器已有在线会话 → 取**最近激活**的一条（同机多开时的确定
///   性选择）；
/// - 无在线会话 → 若集合内且 keychain 有凭证 → 静默拉起（`auto_spawned=true`），
///   由调用方在任务收尾时经 [`Self::cleanup_task_targets`] 关闭；
/// - 无凭证 / 拉取失败 → 明确错误。
pub async fn resolve_target(
    app: &tauri::AppHandle,
    host: &str,
    task_id: &str,
    current_session_id: &str,
) -> Result<ResolvedTarget, AppError> {
    let state = app.state::<AppState>();
    let state: AppState = state.inner().clone();

    // 门控闸：双端恒开启；若未来按设置收紧，此处统一拒绝。
    if !multi_host_enabled(&state).await {
        return Err(AppError::Agent(
            "多机操控当前不可用，不能指定目标机器".into(),
        ));
    }

    // 当前会话所在机器的 config_id（SavedConnection id；临时连接为 None）。
    let current_conn_id = state
        .ssh_manager
        .get_connection_id(current_session_id)
        .await;

    // ── 1. 白名单（勾选集合 ∪ 当前机）+ name 解析（含去重后缀） ──
    let conn = resolve_connection(&state, host, current_conn_id.as_deref()).await?;

    // ── 1.5 host 命中当前会话所在机器 → 直接用当前会话（无需换机/拉起） ──
    if Some(&conn.id) == current_conn_id.as_ref()
        && state.ssh_manager.is_connected(current_session_id).await
    {
        return Ok(ResolvedTarget {
            session_id: current_session_id.to_string(),
            config_id: conn.id.clone(),
            auto_spawned: false,
            host_label: conn.name.clone(),
        });
    }

    // ── 2. 已有在线会话 → 最近激活 ──
    if let Some(sid) = state
        .ssh_manager
        .latest_active_session_for_connection(&conn.id)
        .await
    {
        return Ok(ResolvedTarget {
            session_id: sid,
            config_id: conn.id.clone(),
            auto_spawned: false,
            host_label: conn.name.clone(),
        });
    }

    // ── 3. 离线 → 静默拉起 ──
    let session_id = spawn_connection(&state, &conn, &app).await?;
    // 注册竞态防御：spawn 期间任务可能已被终态化（用户取消/失败/超时收尾）。
    // 此时 cleanup_task_targets 已跑过（或即将跑），我们此刻注册的条目将无人
    // 清理 → 刚拉起的会话泄漏。因此注册前检查任务是否仍存活；已终态则
    // 立即关闭刚拉起的会话，不注册（避免留给已结束的清理轮次去清）。
    let task_alive = state
        .agent_tasks
        .read()
        .get(task_id)
        .map(|t| {
            matches!(
                t.status,
                crate::agent::task::AgentStatus::Planning
                    | crate::agent::task::AgentStatus::Executing
                    | crate::agent::task::AgentStatus::WaitingApproval
            )
        })
        .unwrap_or(false);
    if !task_alive {
        log::info!(
            "multi_host: 任务 {} 已在拉起期间结束，关闭刚拉起的会话 {}",
            task_id,
            session_id
        );
        let _ = state.ssh_manager.disconnect(&session_id).await;
        return Err(AppError::Agent(format!(
            "任务已结束，无法在目标机器 {} 上执行",
            conn.name
        )));
    }
    // 记账：task_id → 自动拉起会话（任务终态由 cleanup 关闭）。
    register_task_target(&state, task_id, &session_id).await;

    Ok(ResolvedTarget {
        session_id,
        config_id: conn.id.clone(),
        auto_spawned: true,
        host_label: conn.name.clone(),
    })
}

/// 解析机器可读引用 → 可操作的 SavedConnection。
///
/// 可解析集合 = 「当前会话所在机器（若为已保存连接，`current_conn_id`）」∪
/// 勾选集合 `multi_host_connection_ids`。当前机无需勾选即可被 `host` 引用
/// （与「不传 host 就在当前机执行」等价），但**只有已保存连接**才能按名字
/// 被引用（临时连接没有稳定可读名，走不传 host 路径）。
///
/// 匹配规则（与前端 TabBar 去重后缀同思路）：
/// - 精确 name 唯一匹配 → 命中；
/// - name 相同多条：尝试 `name` / `name:1` / `name:2` … 后缀消歧（第 0 条
///   为裸 name，第 i 条为 `name:i`——与 `TabBar` 展示 `dupIndex` 一致）；
/// - 匹配不到或歧义 → 明确错误。
async fn resolve_connection(
    state: &AppState,
    host: &str,
    current_conn_id: Option<&str>,
) -> Result<crate::config::connections::SavedConnection, AppError> {
    let host = host.trim();
    if host.is_empty() {
        return Err(AppError::Agent("机器引用不能为空".into()));
    }

    let allowlist: std::collections::HashSet<String> = state
        .settings
        .read()
        .await
        .experimental_settings
        .multi_host_connection_ids
        .iter()
        .cloned()
        .collect();
    // 当前机隐式授权：无需进勾选集合。
    let allowlist = if let Some(cid) = current_conn_id {
        let mut s = allowlist;
        s.insert(cid.to_string());
        s
    } else {
        allowlist
    };

    let store = state.connection_store.read().await;
    let all = store.get_all().to_vec();
    drop(store);

    // 可解析集合为空（无勾选机器且当前机不是已保存连接）→ 明确错误。
    if allowlist.is_empty() {
        return Err(AppError::Agent(
            "无可操作的机器：请先在 Agent 面板勾选可跨机的目标机器".into(),
        ));
    }

    // 集合内按 name 分组（保序）。
    let mut matched_by_name: Vec<&crate::config::connections::SavedConnection> = all
        .iter()
        .filter(|c| allowlist.contains(&c.id) && c.name == host)
        .collect();
    if matched_by_name.is_empty() {
        // 去重后缀消歧：`name:N`
        let (base, idx) = split_suffix(host);
        if let Some(idx) = idx {
            matched_by_name = all
                .iter()
                .filter(|c| allowlist.contains(&c.id) && c.name == base)
                .collect();
            matched_by_name = matched_by_name
                .into_iter()
                .skip(idx)
                .take(1)
                .collect::<Vec<_>>();
            if matched_by_name.is_empty() {
                return Err(AppError::Agent(format!(
                    "找不到机器「{}」在可操作集合内",
                    host
                )));
            }
        } else {
            // 给出可用的集合列表帮助模型（不泄露凭证/连接密码）。
            let names = all
                .iter()
                .filter(|c| allowlist.contains(&c.id))
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>();
            return Err(AppError::Agent(format!(
                "机器「{}」不在可操作集合内。可用机器: {}",
                host,
                names.join(", ")
            )));
        }
    }

    if matched_by_name.len() > 1 {
        return Err(AppError::Agent(format!(
            "机器「{}」存在多个同名项，请用 name:序号 精确指定",
            host
        )));
    }
    Ok(matched_by_name[0].clone())
}

/// 从 `name:N` 拆出基础名与序号；无后缀 → (原串, None)。
fn split_suffix(host: &str) -> (String, Option<usize>) {
    match host.rsplit_once(':') {
        Some((base, num)) if !base.is_empty() && !num.is_empty() => {
            if let Ok(n) = num.parse::<usize>() {
                return (base.to_string(), Some(n));
            }
            (host.to_string(), None)
        }
        _ => (host.to_string(), None),
    }
}

/// 为机器清单生成**展示名**：同名多项附加 `name:N` 消歧后缀（0 起，按
/// 出现顺序）。这是提示词与解析器之间的唯一契约——解析器 `split_suffix`
/// 对展示名还原出的 index 必须等于该项在原始列表中的同名序号，模型才能
/// 精确引用。单独抽成纯函数以便单测锁死该契约。
fn disambiguated_labels(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(names.len());
    for (i, name) in names.iter().enumerate() {
        let same_name_count = names.iter().filter(|n| *n == name).count();
        if same_name_count > 1 {
            // 同名第几个（0 起）作为后缀。
            let idx = names[..i].iter().filter(|n| *n == name).count();
            out.push(format!("{}:{}", name, idx));
        } else {
            out.push(name.clone());
        }
    }
    out
}

/// 静默拉起一条到该 SavedConnection 的会话（复用 commands/ssh.rs 同源逻辑：
/// keychain 读凭证、jump 构建）。密码/passphrase 绝不入 WebView。
async fn spawn_connection(
    state: &AppState,
    conn: &crate::config::connections::SavedConnection,
    app: &tauri::AppHandle,
) -> Result<String, AppError> {
    let saved = conn.clone();
    let auth_method = crate::commands::ssh::build_connect_auth_method(&saved)?;
    let jump = crate::commands::ssh::build_jump_config(&saved, &saved.id, &auth_method)?;

    let config = ConnectionConfig {
        host: saved.host.clone(),
        port: saved.port,
        username: saved.username.clone(),
        auth_method,
        connection_id: Some(saved.id.clone()),
        trust_new_host_key: false,
        jump,
    };

    state.ssh_manager.connect(config, app.clone()).await
}

/// 记账：task_id → 自动拉起的会话。同一会话被多个任务引用时引用计数。
async fn register_task_target(state: &AppState, task_id: &str, session_id: &str) {
    state
        .multi_host_targets
        .write()
        .await
        .entry(task_id.to_string())
        .or_insert_with(std::collections::HashSet::new)
        .insert(session_id.to_string());
}

/// 清理某任务自动拉起的全部会话（任务终态调用）。
/// **只关自动拉起的**：用户手动打开的在线会话绝不受影响（判断依据 =
/// 记账集合里的 session_id 当前仍在线）。
pub async fn cleanup_task_targets(state: &AppState, task_id: &str) {
    let session_ids: Vec<String> = state
        .multi_host_targets
        .write()
        .await
        .remove(task_id)
        .map(|s| s.into_iter().collect())
        .unwrap_or_default();
    for sid in session_ids {
        // 若该会话仍由 manager 持有（未被别处主动断开），关闭它。
        if state.ssh_manager.is_connected(&sid).await {
            log::info!(
                "multi_host: 任务 {} 结束，关闭自动拉起的会话 {}",
                task_id,
                sid
            );
            let _ = state.ssh_manager.disconnect(&sid).await;
        }
    }
}

/// 该 task 是否注册过任何自动拉起会话（供 agent_loop 收尾判定是否需要清理）。
pub async fn has_task_targets(state: &AppState, task_id: &str) -> bool {
    state
        .multi_host_targets
        .read()
        .await
        .get(task_id)
        .map_or(false, |s| !s.is_empty())
}

// ── 审批/卡片归属辅助 ────────────────────────────────────────────────

/// 从工具参数提取可选 `host`；无 host = None（当前会话执行）。
pub fn optional_host(params: &serde_json::Value) -> Option<String> {
    params
        .get("host")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 生成注入主任务 system prompt 的「多机操控」段（桌面恒注入）。
/// 数据收集在此完成；**文案模板外置**于 templates/agent/多机.hbs
/// （经 TemplateManager::render_multi_host 渲染），本模块不硬编码提示词文本。
/// 可 host 引用的机器 = 勾选集合 ∪ 当前会话所在机器（若为已保存连接）。
/// 两者皆无可引用机器（空集合 + 当前机为临时连接）→ None（零变化）。
pub async fn build_prompt_section(state: &AppState, session_id: &str) -> Option<String> {
    if !multi_host_enabled(state).await {
        return None;
    }
    let current_conn_id = state.ssh_manager.get_connection_id(session_id).await;

    // 可 host 引用集合 = 勾选集合 ∪ 当前会话所在机器（当前机隐式授权）。
    let mut candidate_ids: std::collections::HashSet<String> = state
        .settings
        .read()
        .await
        .experimental_settings
        .multi_host_connection_ids
        .iter()
        .cloned()
        .collect();
    if let Some(cid) = &current_conn_id {
        candidate_ids.insert(cid.clone());
    }

    let store = state.connection_store.read().await;
    let all = store.get_all().to_vec();
    drop(store);

    // 候选机器（集合内且仍存在）→ 名字 + 是否当前机 + 在线状态。
    let mut names: Vec<String> = Vec::with_capacity(all.len());
    let mut current_flags: Vec<bool> = Vec::with_capacity(all.len());
    let mut online_flags: Vec<bool> = Vec::with_capacity(all.len());
    for c in all.iter().filter(|c| candidate_ids.contains(&c.id)) {
        let cur = current_conn_id.as_ref() == Some(&c.id);
        let online = cur
            || !state
                .ssh_manager
                .sessions_for_connection(&c.id)
                .await
                .is_empty();
        names.push(c.name.clone());
        current_flags.push(cur);
        online_flags.push(online);
    }

    if names.is_empty() {
        return None;
    }

    // 同名按原始出现顺序编号；列表整体按「编号后的名字」排序以便阅读
    // （同名项天然相邻，序号与原始序一致——排序只影响展示顺序不影响语义）。
    let labels = disambiguated_labels(&names);
    let mut order: Vec<usize> = (0..labels.len()).collect();
    order.sort_by(|&a, &b| labels[a].cmp(&labels[b]));

    let current = match &current_conn_id {
        Some(cid) => all
            .iter()
            .find(|c| c.id == *cid)
            .map(|c| c.name.clone())
            .unwrap_or_else(|| cid.clone()),
        None => session_id.to_string(),
    };

    // 机器列表交给模板 each 渲染；只传数据，不拼文案。当前机带
    // is_current 标记（模板可显示「当前会话」徽标），状态文案仍按在线判断。
    let machines: Vec<serde_json::Value> = order
        .iter()
        .map(|&i| {
            serde_json::json!({
                "label": labels[i],
                "is_current": current_flags[i],
                "status": if current_flags[i] {
                    "当前会话"
                } else if online_flags[i] {
                    "在线"
                } else {
                    "离线，将自动连接"
                },
            })
        })
        .collect();

    let rendered = crate::agent::templates::TemplateManager.render_multi_host(
        &current,
        &machines,
        // upload/download 仅桌面注册（本机文件系统语义）；移动端提示词
        // 不得引导模型调用必败工具。
        cfg!(desktop),
    );
    if rendered.trim().is_empty() {
        None
    } else {
        Some(rendered)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_suffix_plain_name_no_suffix() {
        assert_eq!(
            split_suffix("web-prod-01"),
            ("web-prod-01".to_string(), None)
        );
    }

    #[test]
    fn split_suffix_numeric_suffix_parsed() {
        assert_eq!(
            split_suffix("web-prod-01:2"),
            ("web-prod-01".to_string(), Some(2))
        );
        assert_eq!(split_suffix("a:0"), ("a".to_string(), Some(0)));
    }

    #[test]
    fn split_suffix_non_numeric_suffix_kept_whole() {
        assert_eq!(split_suffix("web:a"), ("web:a".to_string(), None));
        assert_eq!(split_suffix(":3"), (":3".to_string(), None));
    }

    #[test]
    fn split_suffix_empty_handled() {
        assert_eq!(split_suffix(""), ("".to_string(), None));
    }

    #[test]
    fn optional_host_extracts_trimmed_non_empty() {
        let p = serde_json::json!({ "host": "  web-1  " });
        assert_eq!(optional_host(&p).as_deref(), Some("web-1"));
        let p2 = serde_json::json!({ "host": "" });
        assert_eq!(optional_host(&p2), None);
        let p3 = serde_json::json!({ "host": "  " });
        assert_eq!(optional_host(&p3), None);
        let p4 = serde_json::json!({});
        assert_eq!(optional_host(&p4), None);
        let p5 = serde_json::json!({ "host": 123 });
        assert_eq!(optional_host(&p5), None);
    }

    #[test]
    fn optional_host_non_object_returns_none() {
        let p = serde_json::json!([1, 2]);
        assert_eq!(optional_host(&p), None);
    }

    #[test]
    fn disambiguated_labels_keeps_unique_names() {
        let names: Vec<String> = ["web-a", "web-b"].iter().map(|s| s.to_string()).collect();
        let labels = disambiguated_labels(&names);
        assert_eq!(labels, vec!["web-a", "web-b"]);
    }

    #[test]
    fn disambiguated_labels_indexes_duplicates_in_order() {
        // 同名 web 三条：展示名 web:0 / web:1 / web:2，按出现顺序。
        let names: Vec<String> = ["web", "db", "web", "web"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let labels = disambiguated_labels(&names);
        assert_eq!(labels, vec!["web:0", "db", "web:1", "web:2"]);
    }

    #[test]
    fn disambiguated_labels_roundtrip_via_split_suffix() {
        // 契约锁死：展示名经 split_suffix 还原的 (base, idx) 必须命中
        // 原始列表中的同名第 idx 个——模型引用 name:N 与解析器 skip(N) 一致。
        let names: Vec<String> = ["app", "app", "cache", "app", "cache"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let labels = disambiguated_labels(&names);
        for (label, original) in labels.iter().zip(names.iter()) {
            let (base, idx) = split_suffix(label);
            // 同名第 idx 个 == 原名字（base 相同的项里第 idx 个）。
            let same_positions: Vec<usize> = names
                .iter()
                .enumerate()
                .filter(|(_, n)| *n == &base)
                .map(|(i, _)| i)
                .collect();
            let target = same_positions.get(idx.unwrap_or(0));
            match target {
                Some(&pos) => assert_eq!(&names[pos], original, "label {}", label),
                None => panic!("label {} 无法还原", label),
            }
        }
    }
}
