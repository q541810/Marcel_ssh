//! 跨设备同步 Tauri command 层。
//!
//! 命名规范：与前端 src/lib/tauri.ts 的 sync_* 函数对齐。
//! 状态读取通过 `state.sync_scheduler`，配对流程通过 `state.sync_client`。
//!
//! 注意：sync_pair_first / sync_pair_join 涉及 keychain 操作 + 网络请求 + engine 初始化，
//! 复杂度较高，单独封装在 sync::commands 模块而不是 sync 引擎内。

use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::error::AppError;
use crate::sync::client::SyncClient;
use crate::sync::config_code;
use crate::sync::crypto;
use crate::sync::engine::{ConflictAction, ResolveOutcome};
use crate::sync::keychain as sync_keychain;
use crate::sync::profile::{Platform, SyncProfile};
use crate::sync::scheduler::SyncState;
use crate::AppState;

// ── 响应结构（与前端 types.ts 对齐，camelCase） ────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub configured: bool,
    pub server_url: Option<String>,
    pub device_id: Option<String>,
    pub platform: String,
    pub profile: SyncProfile,
    pub state: SyncState,
    pub pending_count: usize,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPairResult {
    /// 第一台设备：返回新生成的配置码（仅此一次，用户必须手抄保存）
    pub config_code: Option<String>,
    /// 是否是第一台设备（true = 新账户，false = 加入已有账户）
    pub is_first_device: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResetResult {
    pub success: bool,
    pub error: Option<String>,
}

/// 已配对设备信息（camelCase，与前端 SyncDeviceInfo 对齐）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeviceInfoDto {
    pub device_id: String,
    pub platform: String,
    pub last_seen_at: String,
}

// ── 辅助：从 AppState 拿 sync 组件 ────────────────

/// 尝试从 keychain 拿 API Key。
async fn get_api_key(_state: &AppState) -> Result<Option<String>, AppError> {
    match sync_keychain::get_device_api_key()? {
        Some(k) => Ok(Some(k)),
        None => Ok(None),
    }
}

// ── Commands ─────────────────────────────────────

/// 获取同步配置摘要。
#[tauri::command]
pub async fn sync_get_summary(state: State<'_, AppState>) -> Result<SyncSummary, AppError> {
    let server_url = sync_keychain::get_server_url()?;
    let device_id = sync_keychain::get_device_id()?;
    let api_key = sync_keychain::get_device_api_key()?;

    let configured = server_url.is_some() && device_id.is_some() && api_key.is_some();

    let profile = match state.sync_engine.as_ref() {
        Some(engine) => engine.profile(),
        None => SyncProfile::default(),
    };

    let (sync_state, last_error) = match state.sync_scheduler.as_ref() {
        Some(scheduler) => (scheduler.state(), scheduler.last_error()),
        None => (SyncState::NotConfigured, None),
    };

    let pending_count = match state.sync_engine.as_ref() {
        Some(engine) => engine.pending_count(),
        None => 0,
    };

    Ok(SyncSummary {
        configured,
        server_url,
        device_id,
        platform: Platform::current().as_str().to_string(),
        profile,
        state: sync_state,
        pending_count,
        error: last_error,
    })
}

/// 第一台设备配对：生成配置码 + 注册账户。
///
/// `password`：账户密码，参与包装密钥派生（v2）；服务端不存储密码。
#[tauri::command]
pub async fn sync_pair_first(
    state: State<'_, AppState>,
    server_url: String,
    password: String,
) -> Result<SyncPairResult, AppError> {
    if server_url.trim().is_empty() {
        return Err(AppError::Config("服务器地址不能为空".into()));
    }
    crypto::validate_account_password(&password)?;

    let server_url = server_url.trim().to_string();

    // 1. 生成配置码
    let config_code = config_code::generate_config_code();
    let config_code_hash = crypto::sha256_hex(&config_code);

    // 2. 生成 Sync Key + 设备 ID（API Key 由服务端生成并仅在 setup 响应中返回一次）
    let sync_key = crypto::generate_sync_key();
    let device_id = Uuid::new_v4().to_string();

    // 3. v2 包装：配置码 + 密码 → 加密 Sync Key
    let wrapping_key = crypto::derive_wrapping_key_v2(&config_code, &password);
    let encrypted_sync_key = crypto::encrypt_sync_key(&wrapping_key, &sync_key)?;

    // 4. 创建 SyncClient 并调用服务端 setup
    let client = SyncClient::new(&server_url)?;
    let profile = SyncProfile::default();

    let setup_request = crate::sync::client::AccountSetupRequest {
        config_code_hash: config_code_hash.clone(),
        encrypted_sync_key: encrypted_sync_key.clone(),
        device_id: device_id.clone(),
        platform: Platform::current().as_str().to_string(),
        sync_profile: serde_json::to_value(&profile)?,
    };

    let response = client.setup_account(setup_request).await.map_err(|e| {
        AppError::Config(format!("配对失败：{}", e))
    })?;
    // 服务端生成并哈希存储 API Key，客户端必须使用响应中的明文 key
    let api_key = response.api_key;

    // 5. 存储凭证到 keychain
    sync_keychain::save_sync_key(&sync_key)?;
    sync_keychain::save_device_id(&device_id)?;
    sync_keychain::save_device_api_key(&api_key)?;
    sync_keychain::save_server_url(&server_url)?;

    // 6. 通知 scheduler：真实 server URL + API Key
    //    启动时 client 可能是 localhost:0 占位，必须先 set_server_url 再 push/pull
    if let Some(scheduler) = state.sync_scheduler.as_ref() {
        scheduler.set_server_url(&server_url);
        scheduler.set_api_key(Some(api_key));
    }

    // 7. 首次配对：播种本地版本表 + 启动调度器 + 触发全量 push
    //    用户在配对前已有本地数据（连接/会话/设置等），但 versions 表为空，
    //    直接 push 不会推任何东西。必须先播种让所有本地数据进入版本表。
    if let Some(engine) = state.sync_engine.as_ref() {
        match engine.seed_local_versions().await {
            Ok(n) => log::info!("[sync] pair_first 播种完成：{} 个 key", n),
            Err(e) => log::warn!("[sync] pair_first 播种失败：{}", e),
        }
    }
    if let Some(scheduler) = state.sync_scheduler.as_ref() {
        // 启动调度器（push 防抖循环 + 轮询循环）。
        // 首次配对时 scheduler 未启动（app setup 时无 api_key），必须在此启动。
        // start() 内部会 trigger_pull_now，但对第一台设备无害（服务端刚创建，pull 返回空）。
        // 已启动时 start() 直接返回（started 标志防重入）。
        let scheduler_clone = scheduler.clone();
        tauri::async_runtime::spawn(async move {
            scheduler_clone.start().await;
        });
        // 防抖 700ms 后执行全量 push（播种的 key 全部 version=1 > last_sync=0）
        scheduler.schedule_push();
    }

    Ok(SyncPairResult {
        config_code: Some(config_code),
        is_first_device: true,
    })
}

/// 后续设备加入：配置码 + 账户密码（旧账户密码可空，回退 v1 仅码包装）。
#[tauri::command]
pub async fn sync_pair_join(
    state: State<'_, AppState>,
    server_url: String,
    config_code: String,
    password: String,
) -> Result<SyncPairResult, AppError> {
    if server_url.trim().is_empty() {
        return Err(AppError::Config("服务器地址不能为空".into()));
    }
    config_code::validate_config_code(&config_code)?;

    let server_url = server_url.trim().to_string();
    let config_code_hash = crypto::sha256_hex(&config_code);

    // 1. 创建 SyncClient + 生成本设备 ID
    let client = SyncClient::new(&server_url)?;
    let device_id = Uuid::new_v4().to_string();
    let profile = SyncProfile::default();

    // 2. 调用服务端 join：校验配置码 + 注册设备 + 返回 encrypted_sync_key 与 api_key
    //    （设备注册必须在 join 内完成，否则新设备无 API Key 无法调用需认证的 register）
    let join_request = crate::sync::client::AccountJoinRequest {
        config_code_hash,
        device_id: device_id.clone(),
        platform: Platform::current().as_str().to_string(),
        sync_profile: serde_json::to_value(&profile)?,
    };
    let join_response = client.join_account(join_request).await.map_err(|e| {
        AppError::Config(format!("配对失败：{}（请检查配置码是否正确）", e))
    })?;
    let api_key = join_response.api_key;

    // 3. 解密 Sync Key：优先 v2（码+密码），失败再试 v1（旧账户仅码）
    //    join 已在服务端注册设备；解密失败时尽量撤销，避免孤儿设备占配额
    let sync_key = match crypto::decrypt_sync_key_with_password(
        &config_code,
        &password,
        &join_response.encrypted_sync_key,
    ) {
        Ok(k) => k,
        Err(e) => {
            if let Err(cleanup_err) = client.delete_device(&api_key, &device_id).await {
                log::warn!(
                    "[sync] join 解密失败后撤销设备失败 device={}：{}",
                    &device_id[..8.min(device_id.len())],
                    cleanup_err
                );
            }
            return Err(e);
        }
    };

    // 4. 存储凭证
    sync_keychain::save_sync_key(&sync_key)?;
    sync_keychain::save_device_id(&device_id)?;
    sync_keychain::save_device_api_key(&api_key)?;
    sync_keychain::save_server_url(&server_url)?;

    // 5. 通知 scheduler：真实 server URL + API Key
    if let Some(scheduler) = state.sync_scheduler.as_ref() {
        scheduler.set_server_url(&server_url);
        scheduler.set_api_key(Some(api_key));
    }

    // 6. 后续设备加入：启动调度器（内部触发首次全量 pull）
    //    首次配对时 scheduler 未启动（app setup 时无 api_key），必须在此启动。
    //    start() 内部 trigger_pull_now 会执行全量 pull（last_sync_versions 为空 = 拉取全部）。
    //    拉取后按字段级三方合并 / LWW 应用到本地，冲突进 pending_conflicts 弹窗。
    //    已启动时 start() 直接返回（started 标志防重入），此时靠轮询或手动 pull。
    if let Some(scheduler) = state.sync_scheduler.as_ref() {
        let scheduler_clone = scheduler.clone();
        tauri::async_runtime::spawn(async move {
            scheduler_clone.start().await;
        });
    }

    Ok(SyncPairResult {
        config_code: None,
        is_first_device: false,
    })
}

/// 更新 sync_profile。
///
/// 本地：写入 SyncEngine 内存 + 持久化到 sync_profile.json
/// 远程：推送到服务端（per-device，不影响其他设备）
#[tauri::command]
pub async fn sync_update_profile(
    state: State<'_, AppState>,
    profile: SyncProfile,
) -> Result<(), AppError> {
    // 本地更新 + 持久化（必须在服务端推送前完成，否则重启后丢失）
    if let Some(engine) = state.sync_engine.as_ref() {
        engine.update_profile(profile.clone());
        engine.persist_profile().await?;
    }

    // 服务端更新（per-device）
    let api_key = match get_api_key(&state).await? {
        Some(k) => k,
        None => return Ok(()), // 未配置同步，静默返回
    };

    let server_url = match sync_keychain::get_server_url()? {
        Some(url) => url,
        None => return Ok(()),
    };

    let client = SyncClient::new(&server_url)?;
    let device_id = match sync_keychain::get_device_id()? {
        Some(id) => id,
        None => return Ok(()),
    };

    let request = crate::sync::client::SyncProfileUpdateRequest {
        device_id,
        sync_profile: serde_json::to_value(&profile)?,
    };

    client.update_sync_profile(&api_key, request).await?;

    Ok(())
}

/// 手动触发 push。
#[tauri::command]
pub async fn sync_push_now(state: State<'_, AppState>) -> Result<(), AppError> {
    if let Some(scheduler) = state.sync_scheduler.as_ref() {
        scheduler.schedule_push();
    }
    Ok(())
}

/// 手动触发 pull。
#[tauri::command]
pub async fn sync_pull_now(state: State<'_, AppState>) -> Result<(), AppError> {
    if let Some(scheduler) = state.sync_scheduler.as_ref() {
        scheduler.trigger_pull_now().await;
    }
    Ok(())
}

/// 列出已配对设备（返回 camelCase，与前端 SyncDeviceInfo 对齐）。
#[tauri::command]
pub async fn sync_list_devices(
    state: State<'_, AppState>,
) -> Result<Vec<SyncDeviceInfoDto>, AppError> {
    let api_key = match get_api_key(&state).await? {
        Some(k) => k,
        None => return Ok(vec![]),
    };

    let server_url = match sync_keychain::get_server_url()? {
        Some(url) => url,
        None => return Ok(vec![]),
    };

    let client = SyncClient::new(&server_url)?;
    let devices = client.list_devices(&api_key).await?;
    Ok(devices
        .into_iter()
        .map(|d| SyncDeviceInfoDto {
            device_id: d.device_id,
            platform: d.platform,
            last_seen_at: d.last_seen_at,
        })
        .collect())
}

/// 删除某设备（撤销其 API Key）。
#[tauri::command]
pub async fn sync_remove_device(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<(), AppError> {
    let _api_key = match get_api_key(&state).await? {
        Some(k) => k,
        None => return Ok(()),
    };

    let server_url = match sync_keychain::get_server_url()? {
        Some(url) => url,
        None => return Ok(()),
    };

    let _client = SyncClient::new(&server_url)?;
    // 服务端删除设备接口（Phase 5 实现，当前占位）
    // client.remove_device(&api_key, &device_id).await?;
    log::info!("删除设备 {}（待服务端接口实现）", device_id);

    Ok(())
}

/// 账户重置：删除账户及所有数据。
///
/// 安全：服务端要求双因子（API Key + config_code_hash）。
/// 若本机已无 API Key（凭证被清除），需要先 join 一次拿到 API Key 才能删除。
#[tauri::command]
pub async fn sync_reset_account(
    state: State<'_, AppState>,
    config_code: String,
) -> Result<SyncResetResult, AppError> {
    config_code::validate_config_code(&config_code)?;
    let config_code_hash = crypto::sha256_hex(&config_code);

    let server_url = match sync_keychain::get_server_url()? {
        Some(url) => url,
        None => {
            return Ok(SyncResetResult {
                success: false,
                error: Some("未配置同步".into()),
            })
        }
    };

    let api_key = match get_api_key(&state).await? {
        Some(k) => k,
        None => {
            return Ok(SyncResetResult {
                success: false,
                error: Some(
                    "本机已无 API Key，请先重新加入账户获取凭证后再试".into(),
                ),
            })
        }
    };

    let client = SyncClient::new(&server_url)?;
    match client.delete_account(&api_key, &config_code_hash).await {
        Ok(()) => {
            // 清除本机凭证
            sync_keychain::clear_all_sync_credentials()?;
            if let Some(scheduler) = state.sync_scheduler.as_ref() {
                scheduler.set_api_key(None);
            }
            Ok(SyncResetResult {
                success: true,
                error: None,
            })
        }
        Err(e) => Ok(SyncResetResult {
            success: false,
            error: Some(e.to_string()),
        }),
    }
}

/// 关闭同步（清除本机凭证，不删服务端数据）。
#[tauri::command]
pub async fn sync_disable(state: State<'_, AppState>) -> Result<(), AppError> {
    sync_keychain::clear_all_sync_credentials()?;
    if let Some(scheduler) = state.sync_scheduler.as_ref() {
        scheduler.set_api_key(None);
    }
    Ok(())
}

// ── 冲突解决 commands ────────────────────────────────────────

/// 用户在 UI 选择的冲突解决动作（前端传入）。
///
/// 序列化为 JSON：`{ "type": "ours" }` / `{ "type": "custom", "value": "..." }` 等。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConflictActionDto {
    /// 用本地值（bump 版本 + 触发 push 让远程更新）
    Ours,
    /// 用远程值（apply theirs + 更新版本表，不 push）
    Theirs,
    /// 跳过本次（不 apply，下次还会冲突）
    SkipOnce,
    /// 永久跳过（加进 excluded_keys + 持久化 + 持久化 SyncProfile）
    SkipForever,
    /// 用自定义值（apply custom + bump 版本 + 触发 push）
    Custom { value: String },
    /// Fork：保留本地原会话，远程内容另存为新会话（仅用于 conversations.* 冲突）。
    /// engine 内部会校验 key 前缀，非会话 key 会返回错误。
    Fork,
}

impl ConflictActionDto {
    fn into_engine_action(self) -> ConflictAction {
        match self {
            ConflictActionDto::Ours => ConflictAction::UseOurs,
            ConflictActionDto::Theirs => ConflictAction::UseTheirs,
            ConflictActionDto::SkipOnce => ConflictAction::SkipOnce,
            ConflictActionDto::SkipForever => ConflictAction::SkipForever,
            ConflictActionDto::Custom { value } => ConflictAction::UseCustom(value),
            ConflictActionDto::Fork => ConflictAction::Fork,
        }
    }
}

/// 解决结果（前端据此判断是否触发后续操作）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    /// "pushNeeded" / "appliedTheirs" / "skipped" / "excluded"
    pub outcome: String,
    /// 是否已经触发 push（UseOurs / UseCustom 时为 true）
    pub push_triggered: bool,
}

impl From<ResolveOutcome> for ResolveResult {
    fn from(outcome: ResolveOutcome) -> Self {
        match outcome {
            ResolveOutcome::PushNeeded => ResolveResult {
                outcome: "pushNeeded".into(),
                push_triggered: false,
            },
            ResolveOutcome::AppliedTheirs => ResolveResult {
                outcome: "appliedTheirs".into(),
                push_triggered: false,
            },
            ResolveOutcome::Skipped => ResolveResult {
                outcome: "skipped".into(),
                push_triggered: false,
            },
            ResolveOutcome::Excluded => ResolveResult {
                outcome: "excluded".into(),
                push_triggered: false,
            },
        }
    }
}

/// 获取所有待解决的冲突列表。
#[tauri::command]
pub async fn sync_get_pending_conflicts(
    state: State<'_, AppState>,
) -> Result<Vec<crate::sync::engine::PendingConflict>, AppError> {
    Ok(match state.sync_engine.as_ref() {
        Some(engine) => engine.pending_conflicts(),
        None => vec![],
    })
}

/// 解决单个冲突。
///
/// `key` = 冲突的 key（如 `settings.fontSize`）
/// `action` = 解决动作（{ type: "ours" } / { type: "custom", value: "..." } 等）
///
/// 如果结果是 `pushNeeded`，本命令会自动调度一次 push（防抖触发）。
#[tauri::command]
pub async fn sync_resolve_conflict(
    state: State<'_, AppState>,
    key: String,
    action: ConflictActionDto,
) -> Result<ResolveResult, AppError> {
    let engine = state
        .sync_engine
        .as_ref()
        .ok_or_else(|| AppError::Config("同步引擎未初始化".into()))?;

    let outcome = engine
        .resolve_conflict(&key, action.into_engine_action())
        .await?;

    let result = ResolveResult::from(outcome);
    if result.outcome == "pushNeeded" {
        if let Some(scheduler) = state.sync_scheduler.as_ref() {
            scheduler.schedule_push();
        }
    }
    Ok(result)
}

/// 批量解决所有冲突。
///
/// `actions` = 每个冲突对应的解决动作（按 key 索引）
/// 如果任一项结果为 `pushNeeded`，自动调度 push。
#[tauri::command]
pub async fn sync_resolve_all_conflicts(
    state: State<'_, AppState>,
    actions: std::collections::HashMap<String, ConflictActionDto>,
) -> Result<Vec<ResolveResult>, AppError> {
    let engine = state
        .sync_engine
        .as_ref()
        .ok_or_else(|| AppError::Config("同步引擎未初始化".into()))?;

    let outcomes = engine
        .resolve_all_conflicts(|conflict| {
            actions
                .get(&conflict.key)
                .cloned()
                .map(|dto| dto.into_engine_action())
                .unwrap_or(ConflictAction::SkipOnce)
        })
        .await?;

    let results: Vec<ResolveResult> = outcomes.into_iter().map(ResolveResult::from).collect();
    if results.iter().any(|r| r.outcome == "pushNeeded") {
        if let Some(scheduler) = state.sync_scheduler.as_ref() {
            scheduler.schedule_push();
        }
    }
    Ok(results)
}

/// 添加永久跳过项（用户在设置 UI 主动排除某 key）。
#[tauri::command]
pub async fn sync_add_excluded_key(
    state: State<'_, AppState>,
    key: String,
) -> Result<(), AppError> {
    let engine = state
        .sync_engine
        .as_ref()
        .ok_or_else(|| AppError::Config("同步引擎未初始化".into()))?;
    engine.add_excluded_key(&key).await
}

/// 移除永久跳过项（用户在设置 UI 重新启用某 key）。
#[tauri::command]
pub async fn sync_remove_excluded_key(
    state: State<'_, AppState>,
    key: String,
) -> Result<(), AppError> {
    let engine = state
        .sync_engine
        .as_ref()
        .ok_or_else(|| AppError::Config("同步引擎未初始化".into()))?;
    engine.remove_excluded_key(&key).await
}

/// 获取当前所有永久跳过项。
#[tauri::command]
pub async fn sync_get_excluded_keys(
    state: State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
    Ok(match state.sync_engine.as_ref() {
        Some(engine) => engine.profile().excluded_keys.into_iter().collect(),
        None => vec![],
    })
}
