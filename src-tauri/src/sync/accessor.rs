//! 同步数据访问器：连接 SyncEngine 与各 store 的桥梁。
//!
//! 职责：
//! - read_value(key): 从对应 store 读取当前明文值，序列化为 JSON 字符串
//! - apply_value(key, value): 反序列化 JSON 值，写入 store，持久化，emit 前端刷新事件
//!
//! key 路由规则（与 profile.rs SyncKey 命名规范对齐）：
//! - "settings.{field}" → settings 的单个字段（字段级同步）
//!   field 可以是顶层（fontSize）或嵌套（llmConfig.baseUrl）
//! - "connections.{id}" → 单个 SavedConnection JSON
//! - "quickCommands.{id}" → 单个 QuickCommand JSON
//! - "skills.{id}" → 单个 Skill JSON
//! - "mcpServers.{id}" → 单个 McpServerConfig JSON
//! - "secrets.llmApiKey" → LLM API Key（明文）
//! - "conversations.{id}" → 对话（含消息列表）
//!
//! 字段级 settings 同步：
//! - read_value("settings.fontSize") → 返回 `16`（字段值 JSON）
//! - apply_value("settings.fontSize", "16") → 只改 fontSize，其他字段不动
//! - 通过 settings_field::get_field/set_field 操作 JSON Value
//!
//! apply 后 emit "sync-data-applied" 事件，payload = { key, deleted: bool }。
//! 前端监听后根据 key 前缀刷新对应 store。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock as TokioRwLock;

use crate::agent::conversation::{ConversationDb, ConversationWithMessages};
use crate::config::connections::{ConnectionStore, SavedConnection};
use crate::config::keychain;
use crate::config::persist::JsonPersistable;
use crate::config::quick_commands::QuickCommandStore;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::mcp::store::{McpServerConfig, McpServerStore};
use crate::skills::store::SkillStore;

/// 批量应用一次 pull 变更的结果。
#[derive(Debug, Default)]
pub struct AppliedBatch {
    /// 应用失败的 key（调用方不应推进版本表，下次 pull 自动重试）
    pub failed_keys: Vec<String>,
}

/// 同步数据访问器
pub struct SyncStoreAccessor {
    pub config_dir: PathBuf,
    pub settings: Arc<TokioRwLock<AppSettings>>,
    pub connection_store: Arc<TokioRwLock<ConnectionStore>>,
    pub quick_command_store: Arc<TokioRwLock<QuickCommandStore>>,
    pub skill_store: Arc<TokioRwLock<SkillStore>>,
    pub mcp_store: Arc<TokioRwLock<McpServerStore>>,
    pub mcp_manager: Arc<crate::mcp::manager::McpManager>,
    pub conversation_db: Arc<ConversationDb>,
    /// Tauri AppHandle，用于 emit "sync-data-applied" 事件
    app_handle: RwLock<Option<AppHandle>>,
}

impl SyncStoreAccessor {
    pub fn new(
        config_dir: PathBuf,
        settings: Arc<TokioRwLock<AppSettings>>,
        connection_store: Arc<TokioRwLock<ConnectionStore>>,
        quick_command_store: Arc<TokioRwLock<QuickCommandStore>>,
        skill_store: Arc<TokioRwLock<SkillStore>>,
        mcp_store: Arc<TokioRwLock<McpServerStore>>,
        mcp_manager: Arc<crate::mcp::manager::McpManager>,
        conversation_db: Arc<ConversationDb>,
    ) -> Self {
        Self {
            config_dir,
            settings,
            connection_store,
            quick_command_store,
            skill_store,
            mcp_store,
            mcp_manager,
            conversation_db,
            app_handle: RwLock::new(None),
        }
    }

    /// 注入 AppHandle，在 setup 阶段调用。
    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.write() = Some(handle);
    }

    /// 从对应 store 读取 key 的当前明文值，返回 JSON 字符串。
    /// 返回 None 表示 key 不存在或已被删除。
    pub async fn read_value(&self, key: &str) -> Option<String> {
        if crate::sync::settings_field::is_settings_field_key(key) {
            // 字段级 settings 读取：返回单个字段的 JSON 值（不是整个 settings）
            let field_path = crate::sync::settings_field::extract_field_path(key)?;
            let settings = self.settings.read().await;
            let settings_json = serde_json::to_value(&*settings).ok()?;
            let field_value = crate::sync::settings_field::get_field(&settings_json, field_path)?;
            serde_json::to_string(&field_value).ok()
        } else if key == "settings" {
            // 兼容旧整体 settings key：旧设备 pull 时可能请求整体 settings
            let settings = self.settings.read().await;
            serde_json::to_string(&*settings).ok()
        } else if let Some(id) = key.strip_prefix("connections.") {
            let store = self.connection_store.read().await;
            store
                .get_by_id(id)
                .and_then(|c| serde_json::to_string(c).ok())
        } else if let Some(id) = key.strip_prefix("quickCommands.") {
            let store = self.quick_command_store.read().await;
            store
                .commands
                .iter()
                .find(|c| c.id == id)
                .and_then(|c| serde_json::to_string(c).ok())
        } else if let Some(id) = key.strip_prefix("skills.") {
            let store = self.skill_store.read().await;
            store.get(id).and_then(|s| serde_json::to_string(s).ok())
        } else if let Some(id) = key.strip_prefix("mcpServers.") {
            let store = self.mcp_store.read().await;
            store.get(id).and_then(|s| serde_json::to_string(s).ok())
        } else if let Some(id) = key.strip_prefix("conversations.") {
            // 同步读取（ConversationDb 内部用 Mutex，非 tokio 锁）
            // 但数据库操作可能阻塞，spawn_blocking 防止阻塞 async runtime
            let db = self.conversation_db.clone();
            let id = id.to_string();
            tokio::task::spawn_blocking(move || -> Option<String> {
                db.get_conversation_with_messages(&id)
                    .ok()
                    .flatten()
                    .and_then(|c| serde_json::to_string(&c).ok())
            })
            .await
            .ok()
            .flatten()
        } else if key == "secrets.llmApiKey" {
            keychain::get_llm_api_key().ok().flatten()
        } else if key == "secrets.webSearchApiKey" {
            keychain::get_web_search_api_key().ok().flatten()
        } else {
            None
        }
    }

    /// 将解密后的值应用到本地 store + 持久化 + emit 前端刷新事件。
    /// value = None 表示删除该 key 对应的数据。
    pub async fn apply_value(&self, key: &str, value: Option<&str>) -> Result<(), AppError> {
        let deleted = value.is_none();

        if crate::sync::settings_field::is_settings_field_key(key) {
            // 字段级 settings 写入：只改单个字段，其他字段不动
            self.apply_settings_field(key, value).await?;
        } else if key == "settings" {
            // 兼容旧整体 settings key：其他设备尚未升级到 v2 字段级时，
            // pull 下来的可能是整体 settings。降级为整体覆盖。
            log::warn!(
                "[sync] 收到旧格式整体 'settings' key，降级为整体覆盖（建议对端升级到字段级同步）"
            );
            self.apply_settings_whole(value).await?;
        } else if let Some(id) = key.strip_prefix("connections.") {
            self.apply_connection(id, value).await?;
        } else if let Some(id) = key.strip_prefix("quickCommands.") {
            self.apply_quick_command(id, value).await?;
        } else if let Some(id) = key.strip_prefix("skills.") {
            self.apply_skill(id, value).await?;
        } else if let Some(id) = key.strip_prefix("mcpServers.") {
            self.apply_mcp_server(id, value).await?;
        } else if let Some(id) = key.strip_prefix("conversations.") {
            self.apply_conversation(id, value).await?;
        } else if key == "secrets.llmApiKey" {
            self.apply_llm_api_key(value)?;
        } else if key == "secrets.webSearchApiKey" {
            self.apply_web_search_api_key(value)?;
        } else {
            // 未知 key，静默跳过（向前兼容）
            log::warn!("[sync] 未知 key，跳过 apply: {}", key);
        }

        self.emit_applied(key, deleted);
        Ok(())
    }

    // ── 批量应用（pull 主路径：一次 pull 每个 store 只写一次磁盘） ──

    /// 批量应用一次 pull 产生的全部变更（按 store 分组，避免逐 key 全量重写文件）。
    ///
    /// - settings.*：一次读 settings，全部字段 set_field，一次 atomic_write
    /// - settings（旧整体 key）：降级为整体覆盖
    /// - connections.* / quickCommands.* / skills.* / mcpServers.*：同模式批量
    /// - conversations.*：一次 spawn_blocking + 逐会话事务（坏会话失败收集继续）
    /// - secrets.*：直接写 keychain
    ///
    /// 返回失败的 key 列表：调用方据此不推进版本表，下次 pull 自动重试。
    /// 单项解析失败只记失败不中断；整组保存失败时该组全部计入失败。
    /// 应用成功后统一 emit 一次 `sync-batch-applied` 事件（替代逐 key emit）。
    pub async fn apply_batch(
        &self,
        ops: Vec<(String, Option<String>)>,
    ) -> Result<AppliedBatch, AppError> {
        let mut failed_keys: Vec<String> = Vec::new();
        let mut applied: Vec<(String, bool)> = Vec::new();

        // ── 分组 ──
        let mut settings_fields: Vec<(String, Option<String>)> = Vec::new();
        let mut settings_whole: Option<(String, Option<String>)> = None;
        let mut connections: Vec<(String, Option<String>)> = Vec::new();
        let mut quick_commands: Vec<(String, Option<String>)> = Vec::new();
        let mut skills: Vec<(String, Option<String>)> = Vec::new();
        let mut mcp_servers: Vec<(String, Option<String>)> = Vec::new();
        let mut conversations: Vec<(String, Option<String>)> = Vec::new();

        for (key, value) in ops {
            if crate::sync::settings_field::is_settings_field_key(&key) {
                settings_fields.push((key, value));
            } else if key == "settings" {
                settings_whole = Some((key, value));
            } else if key.starts_with("connections.") {
                connections.push((key, value));
            } else if key.starts_with("quickCommands.") {
                quick_commands.push((key, value));
            } else if key.starts_with("skills.") {
                skills.push((key, value));
            } else if key.starts_with("mcpServers.") {
                mcp_servers.push((key, value));
            } else if key.starts_with("conversations.") {
                conversations.push((key, value));
            } else if key == "secrets.llmApiKey" {
                match self.apply_llm_api_key(value.as_deref()) {
                    Ok(()) => applied.push((key, value.is_none())),
                    Err(e) => {
                        log::warn!("[sync] 应用 secrets.llmApiKey 失败：{}", e);
                        failed_keys.push(key);
                    }
                }
            } else if key == "secrets.webSearchApiKey" {
                match self.apply_web_search_api_key(value.as_deref()) {
                    Ok(()) => applied.push((key, value.is_none())),
                    Err(e) => {
                        log::warn!("[sync] 应用 secrets.webSearchApiKey 失败：{}", e);
                        failed_keys.push(key);
                    }
                }
            } else {
                // 未知 key，静默跳过（向前兼容，与单 key apply_value 一致）
                log::warn!("[sync] 未知 key，跳过 apply: {}", key);
            }
        }

        // ── settings 字段级：一次读 + 改 + 写 ──
        if !settings_fields.is_empty() {
            let result = self.apply_settings_fields(&settings_fields).await;
            merge_group_result(
                &settings_fields,
                result,
                "settings 字段",
                &mut failed_keys,
                &mut applied,
            );
        }

        // ── 旧整体 settings key：降级为整体覆盖 ──
        if let Some((key, value)) = settings_whole {
            log::warn!(
                "[sync] 收到旧格式整体 'settings' key，降级为整体覆盖（建议对端升级到字段级同步）"
            );
            match self.apply_settings_whole(value.as_deref()).await {
                Ok(()) => applied.push((key, value.is_none())),
                Err(e) => {
                    log::warn!("[sync] 应用整体 settings 失败：{}", e);
                    failed_keys.push(key);
                }
            }
        }

        // ── 连接 / 快捷命令 / 技能 / MCP：同模式批量 ──
        if !connections.is_empty() {
            let path = ConnectionStore::default_file(&self.config_dir);
            let result = apply_json_store_batch(
                self.connection_store.clone(),
                path,
                &connections,
                |s: &mut ConnectionStore, key, value| {
                    let id = match key.strip_prefix("connections.") {
                        Some(id) => id,
                        None => return false,
                    };
                    match value {
                        Some(json) => match serde_json::from_str::<SavedConnection>(json) {
                            Ok(conn) => {
                                s.remove(id);
                                s.add(conn);
                                true
                            }
                            Err(e) => {
                                log::warn!("[sync] 反序列化 SavedConnection 失败: {}", e);
                                false
                            }
                        },
                        None => {
                            s.remove(id);
                            true
                        }
                    }
                },
            )
            .await;
            merge_group_result(
                &connections,
                result,
                "connections",
                &mut failed_keys,
                &mut applied,
            );
        }
        if !quick_commands.is_empty() {
            let path = QuickCommandStore::default_file(&self.config_dir);
            let result =
                apply_json_store_batch(
                    self.quick_command_store.clone(),
                    path,
                    &quick_commands,
                    |s: &mut QuickCommandStore, key, value| {
                        let id = match key.strip_prefix("quickCommands.") {
                            Some(id) => id,
                            None => return false,
                        };
                        match value {
                            Some(json) => {
                                match serde_json::from_str::<
                                    crate::config::quick_commands::QuickCommand,
                                >(json)
                                {
                                    Ok(cmd) => {
                                        s.remove(id);
                                        s.commands.push(cmd);
                                        true
                                    }
                                    Err(e) => {
                                        log::warn!("[sync] 反序列化 QuickCommand 失败: {}", e);
                                        false
                                    }
                                }
                            }
                            None => {
                                s.remove(id);
                                true
                            }
                        }
                    },
                )
                .await;
            merge_group_result(
                &quick_commands,
                result,
                "quickCommands",
                &mut failed_keys,
                &mut applied,
            );
        }
        if !skills.is_empty() {
            let path = SkillStore::default_file(&self.config_dir);
            let result = apply_json_store_batch(
                self.skill_store.clone(),
                path,
                &skills,
                |s: &mut SkillStore, key, value| {
                    let id = match key.strip_prefix("skills.") {
                        Some(id) => id,
                        None => return false,
                    };
                    match value {
                        Some(json) => {
                            match serde_json::from_str::<crate::skills::store::Skill>(json) {
                                Ok(skill) => {
                                    s.delete(id);
                                    s.add(skill);
                                    true
                                }
                                Err(e) => {
                                    log::warn!("[sync] 反序列化 Skill 失败: {}", e);
                                    false
                                }
                            }
                        }
                        None => {
                            s.delete(id);
                            true
                        }
                    }
                },
            )
            .await;
            merge_group_result(&skills, result, "skills", &mut failed_keys, &mut applied);
        }
        if !mcp_servers.is_empty() {
            let path = McpServerStore::default_file(&self.config_dir);
            let result = apply_json_store_batch(
                self.mcp_store.clone(),
                path,
                &mcp_servers,
                |s: &mut McpServerStore, key, value| {
                    let id = match key.strip_prefix("mcpServers.") {
                        Some(id) => id,
                        None => return false,
                    };
                    match value {
                        Some(json) => match serde_json::from_str::<McpServerConfig>(json) {
                            Ok(server) => {
                                s.servers.retain(|x| x.id != id);
                                s.add(server);
                                true
                            }
                            Err(e) => {
                                log::warn!("[sync] 反序列化 McpServerConfig 失败: {}", e);
                                false
                            }
                        },
                        None => {
                            s.servers.retain(|x| x.id != id);
                            true
                        }
                    }
                },
            )
            .await;
            merge_group_result(
                &mcp_servers,
                result,
                "mcpServers",
                &mut failed_keys,
                &mut applied,
            );
            for (key, _) in &mcp_servers {
                if !failed_keys.contains(key) {
                    if let Some(id) = key.strip_prefix("mcpServers.") {
                        self.mcp_manager.clear_cache(id).await;
                    }
                }
            }
        }

        // ── conversations：一次 spawn_blocking，逐会话事务（坏会话不连累其他） ──
        if !conversations.is_empty() {
            match self.apply_conversations_batch(&conversations).await {
                Ok(failed) => {
                    let failed_set: HashSet<&str> = failed.iter().map(String::as_str).collect();
                    for (key, value) in &conversations {
                        if failed_set.contains(key.as_str()) {
                            failed_keys.push(key.clone());
                        } else {
                            applied.push((key.clone(), value.is_none()));
                        }
                    }
                }
                Err(e) => {
                    log::warn!("[sync] 批量应用 conversations 失败：{}", e);
                    failed_keys.extend(conversations.iter().map(|(k, _)| k.clone()));
                }
            }
        }

        // ── 统一 emit 一次批量事件 ──
        self.emit_applied_batch(&applied);

        Ok(AppliedBatch { failed_keys })
    }

    // ── 各 store 的 apply 实现 ────────────────────────────────

    /// 字段级 settings 写入：只改单个字段，其他字段不动。
    ///
    /// value 是该字段的 JSON 值（不是整个 settings），例如：
    /// - key="settings.fontSize", value="16" → 只改 fontSize
    /// - key="settings.llmConfig.baseUrl", value="\"http://api.example.com\"" → 只改 baseUrl
    ///
    /// value=None 表示删除该字段——但 settings 字段不允许删除，
    /// 这里按"恢复默认值"处理：解析 default settings 取该字段值。
    async fn apply_settings_field(&self, key: &str, value: Option<&str>) -> Result<(), AppError> {
        let field_path = crate::sync::settings_field::extract_field_path(key)
            .ok_or_else(|| AppError::Config(format!("无效的 settings 字段 key: {}", key)))?;

        // 读取当前 settings → JSON Value → 修改字段 → 反序列化回 AppSettings
        let mut settings_json = {
            let settings = self.settings.read().await;
            serde_json::to_value(&*settings)
                .map_err(|e| AppError::Config(format!("序列化 settings 失败: {}", e)))?
        };

        match value {
            Some(json) => {
                let field_value: serde_json::Value = serde_json::from_str(json).map_err(|e| {
                    AppError::Config(format!("反序列化 settings 字段值失败: {}", e))
                })?;
                crate::sync::settings_field::set_field(
                    &mut settings_json,
                    field_path,
                    field_value,
                )?;
            }
            None => {
                // 字段不允许删除：恢复为默认值（而非真正删除）
                let defaults = serde_json::to_value(AppSettings::default())
                    .map_err(|e| AppError::Config(format!("序列化默认 settings 失败: {}", e)))?;
                if let Some(default_val) =
                    crate::sync::settings_field::get_field(&defaults, field_path)
                {
                    crate::sync::settings_field::set_field(
                        &mut settings_json,
                        field_path,
                        default_val,
                    )?;
                }
                // 如果默认 settings 中也没有该字段（未知字段），什么都不做
            }
        }

        // 反序列化回 AppSettings（会丢弃未知字段，向前兼容）
        let new_settings: AppSettings = serde_json::from_value(settings_json)
            .map_err(|e| AppError::Config(format!("反序列化 AppSettings 失败: {}", e)))?;

        // 保留本机 LLM API Key（secrets 通过独立 key 同步，不走 settings）
        let preserved_api_key = {
            let current = self.settings.read().await;
            current.llm_config.as_ref().and_then(|c| {
                if c.api_key.is_empty() {
                    None
                } else {
                    Some(c.api_key.clone())
                }
            })
        };
        let mut final_settings = new_settings;
        if let Some(api_key) = preserved_api_key {
            if let Some(ref mut llm) = final_settings.llm_config {
                llm.api_key = api_key;
            }
        }

        // 写入 store + 持久化
        {
            let mut settings = self.settings.write().await;
            *settings = final_settings;
        }
        let snapshot = self.settings.read().await.clone();
        let path = AppSettings::default_file(&self.config_dir);
        tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
            .await
            .map_err(|e| AppError::Config(format!("持久化 settings 失败: {}", e)))??;
        Ok(())
    }

    /// 批量字段级 settings 写入：一次读 settings → 应用全部字段变更 → 一次保存。
    ///
    /// 与单 key `apply_settings_field` 的语义一致：
    /// - value=Some(json)：只改该字段，其他字段不动
    /// - value=None：字段不允许删除，恢复为默认值
    /// - 保留本机 LLM API Key（secrets 独立同步，不走 settings）
    ///
    /// 返回成功应用的 key 列表；字段级解析失败只记 warn 并跳过（不中断其他字段）。
    /// 反序列化/保存失败返回 Err（整组失败，调用方全部记入 failed_keys）。
    async fn apply_settings_fields(
        &self,
        ops: &[(String, Option<String>)],
    ) -> Result<Vec<String>, AppError> {
        // 读取当前 settings → JSON Value，逐个字段应用（字段路径互不相交，顺序无关）
        let mut settings_json = {
            let settings = self.settings.read().await;
            serde_json::to_value(&*settings)
                .map_err(|e| AppError::Config(format!("序列化 settings 失败: {}", e)))?
        };

        let mut ok_keys: Vec<String> = Vec::new();
        for (key, value) in ops {
            let field_path = match crate::sync::settings_field::extract_field_path(key) {
                Some(p) => p,
                None => {
                    log::warn!("[sync] 无效的 settings 字段 key: {}", key);
                    continue;
                }
            };
            match value {
                Some(json) => {
                    let field_value: serde_json::Value = match serde_json::from_str(json) {
                        Ok(v) => v,
                        Err(e) => {
                            log::warn!("[sync] 反序列化 settings 字段值失败 ({}): {}", key, e);
                            continue;
                        }
                    };
                    if let Err(e) = crate::sync::settings_field::set_field(
                        &mut settings_json,
                        field_path,
                        field_value,
                    ) {
                        log::warn!("[sync] 设置 settings 字段失败 ({}): {}", key, e);
                        continue;
                    }
                }
                None => {
                    // 字段不允许删除：恢复为默认值（而非真正删除）
                    let defaults = serde_json::to_value(AppSettings::default()).map_err(|e| {
                        AppError::Config(format!("序列化默认 settings 失败: {}", e))
                    })?;
                    if let Some(default_val) =
                        crate::sync::settings_field::get_field(&defaults, field_path)
                    {
                        if let Err(e) = crate::sync::settings_field::set_field(
                            &mut settings_json,
                            field_path,
                            default_val,
                        ) {
                            log::warn!("[sync] 恢复 settings 字段默认值失败 ({}): {}", key, e);
                            continue;
                        }
                    }
                    // 默认 settings 中也没有该字段（未知字段），什么都不做
                }
            }
            ok_keys.push(key.clone());
        }

        // 反序列化回 AppSettings（会丢弃未知字段，向前兼容）
        let new_settings: AppSettings = serde_json::from_value(settings_json)
            .map_err(|e| AppError::Config(format!("反序列化 AppSettings 失败: {}", e)))?;

        // 保留本机 LLM API Key（secrets 通过独立 key 同步，不走 settings）
        let preserved_api_key = {
            let current = self.settings.read().await;
            current.llm_config.as_ref().and_then(|c| {
                if c.api_key.is_empty() {
                    None
                } else {
                    Some(c.api_key.clone())
                }
            })
        };
        let mut final_settings = new_settings;
        if let Some(api_key) = preserved_api_key {
            if let Some(ref mut llm) = final_settings.llm_config {
                llm.api_key = api_key;
            }
        }

        // 写入 store + 持久化（一次）
        {
            let mut settings = self.settings.write().await;
            *settings = final_settings;
        }
        let snapshot = self.settings.read().await.clone();
        let path = AppSettings::default_file(&self.config_dir);
        tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
            .await
            .map_err(|e| AppError::Config(format!("持久化 settings 失败: {}", e)))??;
        Ok(ok_keys)
    }

    /// 兼容旧整体 settings 同步：整体覆盖。
    ///
    /// 仅在数据迁移期间处理旧的 `"settings"` 整体 key 时使用。
    /// 新代码应使用字段级 `settings.{field}` key。
    pub async fn apply_settings_whole(&self, value: Option<&str>) -> Result<(), AppError> {
        match value {
            Some(json) => {
                let new_settings: AppSettings = serde_json::from_str(json)
                    .map_err(|e| AppError::Config(format!("反序列化 AppSettings 失败: {}", e)))?;

                // 保留本机已有的 LLM API Key
                let preserved_api_key = {
                    let current = self.settings.read().await;
                    current.llm_config.as_ref().and_then(|c| {
                        if c.api_key.is_empty() {
                            None
                        } else {
                            Some(c.api_key.clone())
                        }
                    })
                };

                let mut final_settings = new_settings;
                if let Some(api_key) = preserved_api_key {
                    if let Some(ref mut llm) = final_settings.llm_config {
                        llm.api_key = api_key;
                    }
                }

                {
                    let mut settings = self.settings.write().await;
                    *settings = final_settings;
                }
                let snapshot = self.settings.read().await.clone();
                let path = AppSettings::default_file(&self.config_dir);
                tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
                    .await
                    .map_err(|e| AppError::Config(format!("持久化 settings 失败: {}", e)))??;
            }
            None => {
                log::warn!("[sync] 收到 settings 的删除请求，忽略");
            }
        }
        Ok(())
    }

    async fn apply_connection(&self, id: &str, value: Option<&str>) -> Result<(), AppError> {
        let path = ConnectionStore::default_file(&self.config_dir);
        match value {
            Some(json) => {
                let conn: SavedConnection = serde_json::from_str(json).map_err(|e| {
                    AppError::Config(format!("反序列化 SavedConnection 失败: {}", e))
                })?;

                let mut store = self.connection_store.write().await;
                // 先删除同 ID 的旧项（如果有），再添加
                store.remove(id);
                store.add(conn);
                let snapshot = store.clone();
                drop(store);

                tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
                    .await
                    .map_err(|e| AppError::Config(format!("持久化 connections 失败: {}", e)))??;
            }
            None => {
                let mut store = self.connection_store.write().await;
                store.remove(id);
                let snapshot = store.clone();
                drop(store);

                tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
                    .await
                    .map_err(|e| AppError::Config(format!("持久化 connections 失败: {}", e)))??;
            }
        }
        Ok(())
    }

    async fn apply_quick_command(&self, id: &str, value: Option<&str>) -> Result<(), AppError> {
        let path = QuickCommandStore::default_file(&self.config_dir);
        match value {
            Some(json) => {
                let cmd: crate::config::quick_commands::QuickCommand = serde_json::from_str(json)
                    .map_err(|e| {
                    AppError::Config(format!("反序列化 QuickCommand 失败: {}", e))
                })?;

                let mut store = self.quick_command_store.write().await;
                // 先删除同 ID 旧项，再添加
                store.remove(id);
                store.commands.push(cmd);
                let snapshot = store.clone();
                drop(store);

                tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
                    .await
                    .map_err(|e| {
                        AppError::Config(format!("持久化 quick_commands 失败: {}", e))
                    })??;
            }
            None => {
                let mut store = self.quick_command_store.write().await;
                store.remove(id);
                let snapshot = store.clone();
                drop(store);

                tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
                    .await
                    .map_err(|e| {
                        AppError::Config(format!("持久化 quick_commands 失败: {}", e))
                    })??;
            }
        }
        Ok(())
    }

    async fn apply_skill(&self, id: &str, value: Option<&str>) -> Result<(), AppError> {
        let path = SkillStore::default_file(&self.config_dir);
        let is_builtin = crate::skills::builtin::is_builtin_skill_id(id);
        match value {
            Some(json) => {
                let skill: crate::skills::store::Skill = serde_json::from_str(json)
                    .map_err(|e| AppError::Config(format!("反序列化 Skill 失败: {}", e)))?;

                let mut store = self.skill_store.write().await;
                if is_builtin {
                    // 内置 skill：内容以本机二进制内嵌版本为准（其他设备可能
                    // 跑着新/旧版本 App），pull 只合并 enabled 状态。
                    // 本地缺失时先整条落地，启动时的 ensure_builtin_skills
                    // 会把内容矫正为本机版本。
                    match store.skills.iter_mut().find(|s| s.id == id) {
                        Some(existing) => {
                            if existing.enabled == skill.enabled {
                                return Ok(());
                            }
                            existing.enabled = skill.enabled;
                            existing.updated_at = skill.updated_at;
                        }
                        None => store.add(skill),
                    }
                } else {
                    store.delete(id);
                    store.add(skill);
                }
                let snapshot = store.clone();
                drop(store);

                tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
                    .await
                    .map_err(|e| AppError::Config(format!("持久化 skills 失败: {}", e)))??;
            }
            None => {
                if is_builtin {
                    // 内置 skill 不可删除；旧版本设备发来的删除请求忽略。
                    return Ok(());
                }
                let mut store = self.skill_store.write().await;
                store.delete(id);
                let snapshot = store.clone();
                drop(store);

                tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
                    .await
                    .map_err(|e| AppError::Config(format!("持久化 skills 失败: {}", e)))??;
            }
        }
        Ok(())
    }

    async fn apply_mcp_server(&self, id: &str, value: Option<&str>) -> Result<(), AppError> {
        let path = McpServerStore::default_file(&self.config_dir);
        match value {
            Some(json) => {
                let server: McpServerConfig = serde_json::from_str(json).map_err(|e| {
                    AppError::Config(format!("反序列化 McpServerConfig 失败: {}", e))
                })?;

                let mut store = self.mcp_store.write().await;
                // 先删除同 ID 旧项，再添加
                store.servers.retain(|s| s.id != id);
                store.add(server);
                let snapshot = store.clone();
                drop(store);

                tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
                    .await
                    .map_err(|e| AppError::Config(format!("持久化 mcp_servers 失败: {}", e)))??;
            }
            None => {
                let mut store = self.mcp_store.write().await;
                store.servers.retain(|s| s.id != id);
                let snapshot = store.clone();
                drop(store);

                tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
                    .await
                    .map_err(|e| AppError::Config(format!("持久化 mcp_servers 失败: {}", e)))??;
            }
        }
        self.mcp_manager.clear_cache(id).await;
        Ok(())
    }

    fn apply_llm_api_key(&self, value: Option<&str>) -> Result<(), AppError> {
        match value {
            Some(key) => {
                if !key.is_empty() {
                    keychain::save_llm_api_key(key)?;
                }
            }
            None => {
                let _ = keychain::delete_llm_api_key();
            }
        }
        Ok(())
    }

    fn apply_web_search_api_key(&self, value: Option<&str>) -> Result<(), AppError> {
        match value {
            Some(key) => {
                if !key.is_empty() {
                    keychain::save_web_search_api_key(key)?;
                }
            }
            None => {
                let _ = keychain::delete_web_search_api_key();
            }
        }
        Ok(())
    }

    /// 应用会话完整快照（pull 时整体覆盖：upsert conversation + replace messages）。
    /// value = None 表示删除会话（级联删除 messages + plans + images）。
    async fn apply_conversation(&self, id: &str, value: Option<&str>) -> Result<(), AppError> {
        let db = self.conversation_db.clone();
        let id_owned = id.to_string();
        match value {
            Some(json) => {
                let snapshot: ConversationWithMessages =
                    serde_json::from_str(json).map_err(|e| {
                        AppError::Config(format!("反序列化 ConversationWithMessages 失败: {}", e))
                    })?;

                // 数据库操作可能阻塞，spawn_blocking
                tokio::task::spawn_blocking(move || -> Result<(), AppError> {
                    // upsert 会话元数据 + 整体替换消息
                    db.upsert_conversation(&snapshot.conversation)
                        .map_err(|e| {
                            AppError::Config(format!("upsert conversation 失败: {}", e))
                        })?;
                    db.replace_messages(&id_owned, &snapshot.messages)
                        .map_err(|e| AppError::Config(format!("replace messages 失败: {}", e)))?;
                    Ok(())
                })
                .await
                .map_err(|e| AppError::Config(format!("数据库任务失败: {}", e)))??;
            }
            None => {
                tokio::task::spawn_blocking(move || -> Result<(), AppError> {
                    db.delete_conversation(&id_owned)
                        .map_err(|e| AppError::Config(format!("删除 conversation 失败: {}", e)))?;
                    Ok(())
                })
                .await
                .map_err(|e| AppError::Config(format!("数据库任务失败: {}", e)))??;
            }
        }
        Ok(())
    }

    /// 批量应用会话变更：一次 spawn_blocking，逐会话调 ConversationDb（坏会话失败收集继续）。
    ///
    /// 返回失败的完整 key 列表（如 `conversations.xxx`）。
    async fn apply_conversations_batch(
        &self,
        ops: &[(String, Option<String>)],
    ) -> Result<Vec<String>, AppError> {
        let db = self.conversation_db.clone();
        let ops_owned: Vec<(String, Option<String>)> = ops.to_vec();
        let failed = tokio::task::spawn_blocking(move || -> Vec<String> {
            let mut failed = Vec::new();
            for (key, value) in ops_owned {
                let id = match key.strip_prefix("conversations.") {
                    Some(id) => id.to_string(),
                    None => continue,
                };
                let result = match &value {
                    Some(json) => {
                        let snapshot: ConversationWithMessages = match serde_json::from_str(json) {
                            Ok(s) => s,
                            Err(e) => {
                                log::warn!(
                                    "[sync] 反序列化 ConversationWithMessages 失败 ({}): {}",
                                    key,
                                    e
                                );
                                failed.push(key.clone());
                                continue;
                            }
                        };
                        db.upsert_conversation(&snapshot.conversation)
                            .and_then(|_| db.replace_messages(&id, &snapshot.messages))
                    }
                    None => db.delete_conversation(&id),
                };
                if let Err(e) = result {
                    log::warn!("[sync] 应用 conversation {} 失败：{}", key, e);
                    failed.push(key.clone());
                }
            }
            failed
        })
        .await
        .map_err(|e| AppError::Config(format!("会话批量应用任务失败: {}", e)))?;
        Ok(failed)
    }

    /// Fork 会话（Phase 4 冲突解决）。
    ///
    /// 用于冲突解决 Fork 动作——本地和远程都改了同一会话时，
    /// 用户选 Fork = 本地原会话保留不变，远程内容另存为新会话。
    ///
    /// - `original_id`: 原会话 id（仅用于日志，不修改原会话）
    /// - `forked_id`: 新会话 id（调用方生成，格式 `{original_id}-fork-{ts}`）
    /// - `theirs_json`: 远程的 ConversationWithMessages JSON（明文）
    ///
    /// 新会话元数据：id=forked_id，title 加 "(fork)" 后缀，created_at/updated_at=now。
    /// 新消息：每条 id 加 `-fork-{ts}` 后缀避免冲突，conversation_id=forked_id。
    /// 写入后 emit `sync-data-applied` 让前端刷新会话列表。
    pub async fn fork_conversation(
        &self,
        original_id: &str,
        forked_id: &str,
        theirs_json: &str,
    ) -> Result<(), AppError> {
        let mut snapshot: ConversationWithMessages =
            serde_json::from_str(theirs_json).map_err(|e| {
                AppError::Config(format!(
                    "fork: 反序列化 theirs ConversationWithMessages 失败: {}",
                    e
                ))
            })?;

        // 修改会话元数据
        let now = chrono::Utc::now();
        let ts_suffix = now.timestamp();
        snapshot.conversation.id = forked_id.to_string();
        snapshot.conversation.title = format!("{} (fork)", snapshot.conversation.title);
        snapshot.conversation.created_at = now;
        snapshot.conversation.updated_at = now;

        // 修改所有消息：id 加后缀避免冲突，conversation_id 改为 forked_id
        for msg in &mut snapshot.messages {
            msg.id = format!("{}-fork-{}", msg.id, ts_suffix);
            msg.conversation_id = forked_id.to_string();
        }

        // 写入数据库
        let db = self.conversation_db.clone();
        let forked_id_owned = forked_id.to_string();
        let snapshot_for_db = snapshot;
        tokio::task::spawn_blocking(move || -> Result<(), AppError> {
            db.upsert_conversation(&snapshot_for_db.conversation)
                .map_err(|e| AppError::Config(format!("fork upsert conversation 失败: {}", e)))?;
            db.replace_messages(&forked_id_owned, &snapshot_for_db.messages)
                .map_err(|e| AppError::Config(format!("fork replace messages 失败: {}", e)))?;
            Ok(())
        })
        .await
        .map_err(|e| AppError::Config(format!("fork 数据库任务失败: {}", e)))??;

        log::info!(
            "[sync] fork 会话: {} → {} (远程内容保留为新会话)",
            original_id,
            forked_id
        );

        // emit 事件让前端刷新会话列表
        self.emit_applied(&format!("conversations.{}", forked_id), false);

        Ok(())
    }

    /// emit "sync-data-applied" 事件，前端监听后根据 key 刷新对应 store。
    fn emit_applied(&self, key: &str, deleted: bool) {
        if let Some(ref handle) = *self.app_handle.read() {
            let payload = serde_json::json!({
                "key": key,
                "deleted": deleted,
            });
            let _ = handle.emit("sync-data-applied", &payload);
        }
    }

    /// emit 一次批量应用事件（pull 主路径：几十个 key 只发一个事件，前端合并刷新一轮）。
    fn emit_applied_batch(&self, applied: &[(String, bool)]) {
        if applied.is_empty() {
            return;
        }
        if let Some(ref handle) = *self.app_handle.read() {
            let payload = serde_json::json!({
                "applied": applied
                    .iter()
                    .map(|(key, deleted)| serde_json::json!({ "key": key, "deleted": deleted }))
                    .collect::<Vec<_>>()
            });
            let _ = handle.emit("sync-batch-applied", &payload);
        }
    }

    /// 列举当前本地存在的所有同步 key。
    ///
    /// 用于首次配对（pair_first）后播种版本表：遍历所有 store 的现有数据，
    /// 为每个 key 生成 `settings.{field}` / `connections.{id}` / ... 形式的 key。
    /// engine.seed_local_versions 会对此列表逐个调用 record_local_change，
    /// 让本地数据进入版本表，随后 push 全量推送到服务端。
    ///
    /// 注意：secrets.llmApiKey / secrets.webSearchApiKey 只在 keychain 中存在时才加入列表。
    /// profile 默认排除 secrets，但用户可能启用，此处仍列举由 record_local_change 过滤。
    pub async fn enumerate_all_keys(&self) -> Vec<String> {
        let mut keys = Vec::new();

        // settings 字段级 key（固定列表，与 settings_field::all_field_paths 对齐）
        for path in crate::sync::settings_field::all_field_paths() {
            keys.push(format!("settings.{}", path));
        }

        // connections
        {
            let store = self.connection_store.read().await;
            for conn in store.get_all() {
                keys.push(format!("connections.{}", conn.id));
            }
        }

        // quickCommands
        {
            let store = self.quick_command_store.read().await;
            for cmd in &store.commands {
                keys.push(format!("quickCommands.{}", cmd.id));
            }
        }

        // skills
        {
            let store = self.skill_store.read().await;
            for skill in store.list() {
                keys.push(format!("skills.{}", skill.id));
            }
        }

        // mcpServers
        {
            let store = self.mcp_store.read().await;
            for server in store.list() {
                keys.push(format!("mcpServers.{}", server.id));
            }
        }

        // conversations（数据库查询，spawn_blocking 避免阻塞 async runtime）
        {
            let db = self.conversation_db.clone();
            if let Ok(ids) = tokio::task::spawn_blocking(move || db.list_all_conversation_ids())
                .await
                .unwrap_or_else(|_| Ok(Vec::new()))
            {
                for id in ids {
                    keys.push(format!("conversations.{}", id));
                }
            }
        }

        // secrets.llmApiKey（仅当存在时）
        if crate::config::keychain::get_llm_api_key()
            .ok()
            .flatten()
            .is_some()
        {
            keys.push("secrets.llmApiKey".to_string());
        }
        // secrets.webSearchApiKey（仅当存在时）
        if crate::config::keychain::get_web_search_api_key()
            .ok()
            .flatten()
            .is_some()
        {
            keys.push("secrets.webSearchApiKey".to_string());
        }

        keys
    }
}

// ── 批量辅助 ────────────────────────────────────────────

/// 通用 JSON store 批量应用：一次写锁内应用全部变更 → 一次原子写盘。
///
/// `apply_one` 接收 (完整 key, 明文值)，返回是否成功；失败项只记录不中断。
/// 写盘失败返回 Err（整组失败）。
async fn apply_json_store_batch<S, F>(
    store: std::sync::Arc<TokioRwLock<S>>,
    path: PathBuf,
    ops: &[(String, Option<String>)],
    apply_one: F,
) -> Result<Vec<String>, AppError>
where
    S: Clone + JsonPersistable + Send + 'static,
    F: Fn(&mut S, &str, Option<&str>) -> bool,
{
    let mut guard = store.write().await;
    let mut candidate = guard.clone();
    let mut ok_keys: Vec<String> = Vec::new();
    for (key, value) in ops {
        if apply_one(&mut candidate, key, value.as_deref()) {
            ok_keys.push(key.clone());
        }
    }
    let path_for_write = path.clone();
    let persisted = candidate.clone();
    tokio::task::spawn_blocking(move || persisted.save_to_path(&path_for_write))
        .await
        .map_err(|e| AppError::Config(format!("持久化 {} 失败: {}", path.display(), e)))??;
    *guard = candidate;
    Ok(ok_keys)
}

/// 合并一组批量应用的结果到 failed_keys / applied（applied 项携带 deleted 标志）。
fn merge_group_result(
    ops: &[(String, Option<String>)],
    result: Result<Vec<String>, AppError>,
    label: &str,
    failed_keys: &mut Vec<String>,
    applied: &mut Vec<(String, bool)>,
) {
    match result {
        Ok(ok_keys) => {
            let ok: HashSet<&str> = ok_keys.iter().map(String::as_str).collect();
            for (key, value) in ops {
                if ok.contains(key.as_str()) {
                    applied.push((key.clone(), value.is_none()));
                } else {
                    failed_keys.push(key.clone());
                }
            }
        }
        Err(e) => {
            log::warn!("[sync] 批量应用 {} 失败：{}", label, e);
            failed_keys.extend(ops.iter().map(|(k, _)| k.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sync_accessor_test_{}_{}_{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_accessor(tag: &str) -> (PathBuf, Arc<SyncStoreAccessor>) {
        let dir = temp_dir(tag);
        let accessor = Arc::new(SyncStoreAccessor::new(
            dir.clone(),
            Arc::new(TokioRwLock::new(AppSettings::default())),
            Arc::new(TokioRwLock::new(ConnectionStore::new())),
            Arc::new(TokioRwLock::new(QuickCommandStore::new())),
            Arc::new(TokioRwLock::new(SkillStore::new())),
            Arc::new(TokioRwLock::new(McpServerStore::new())),
            Arc::new(crate::mcp::manager::McpManager::new()),
            Arc::new(ConversationDb::new(dir.join("conv.db")).unwrap()),
        ));
        (dir, accessor)
    }

    #[tokio::test]
    async fn apply_batch_settings_fields_applies_all_and_persists() {
        let (dir, accessor) = test_accessor("settings");
        let ops = vec![
            ("settings.fontSize".to_string(), Some("18".to_string())),
            (
                "settings.fontFamily".to_string(),
                Some("\"monospace\"".to_string()),
            ),
        ];
        let batch = accessor.apply_batch(ops).await.unwrap();
        assert!(batch.failed_keys.is_empty());

        // 内存 store 更新
        {
            let settings = accessor.settings.read().await;
            assert_eq!(settings.font_size, 18);
            assert_eq!(settings.font_family, "monospace");
        }
        // 文件一次写盘，内容包含全部字段
        let content = std::fs::read_to_string(AppSettings::default_file(&dir)).unwrap();
        assert!(content.contains("\"fontSize\": 18"));
        assert!(content.contains("\"monospace\""));
    }

    #[tokio::test]
    async fn apply_batch_settings_bad_field_value_collects_failed() {
        let (_dir, accessor) = test_accessor("settings_bad");
        let ops = vec![
            ("settings.fontSize".to_string(), Some("18".to_string())),
            // 非法 JSON：该字段失败，不影响其他字段
            (
                "settings.fontFamily".to_string(),
                Some("not-json".to_string()),
            ),
        ];
        let batch = accessor.apply_batch(ops).await.unwrap();
        assert_eq!(batch.failed_keys, vec!["settings.fontFamily".to_string()]);
        let settings = accessor.settings.read().await;
        assert_eq!(settings.font_size, 18);
        assert_eq!(settings.font_family, AppSettings::default().font_family);
    }

    #[tokio::test]
    async fn apply_batch_connections_upsert_and_delete() {
        let (dir, accessor) = test_accessor("connections");
        let conn_json = serde_json::json!({
            "id": "conn-1",
            "name": "test",
            "host": "example.com",
            "port": 22,
            "username": "root",
            "authMethod": "password"
        })
        .to_string();
        let ops = vec![
            ("connections.conn-1".to_string(), Some(conn_json.clone())),
            ("connections.conn-2".to_string(), None), // 删除不存在的 id：无害
        ];
        let batch = accessor.apply_batch(ops).await.unwrap();
        assert!(batch.failed_keys.is_empty());

        {
            let store = accessor.connection_store.read().await;
            let conns = store.get_all();
            assert_eq!(conns.len(), 1);
            assert_eq!(conns[0].id, "conn-1");
            assert_eq!(conns[0].host, "example.com");
        }
        let content = std::fs::read_to_string(ConnectionStore::default_file(&dir)).unwrap();
        assert!(content.contains("conn-1"));
    }

    #[tokio::test]
    async fn apply_batch_unknown_key_skipped_not_failed() {
        let (_dir, accessor) = test_accessor("unknown");
        let ops = vec![
            ("unknown.xyz".to_string(), Some("v".to_string())),
            ("settings.fontSize".to_string(), Some("14".to_string())),
        ];
        let batch = accessor.apply_batch(ops).await.unwrap();
        // 未知 key 跳过（与单 key apply_value 一致），不算失败
        assert!(batch.failed_keys.is_empty());
        let settings = accessor.settings.read().await;
        assert_eq!(settings.font_size, 14);
    }

    #[tokio::test]
    async fn apply_batch_conversations_upsert_and_delete() {
        let (_dir, accessor) = test_accessor("conversations");
        let now = chrono::Utc::now().to_rfc3339();
        let snapshot = serde_json::json!({
            "conversation": {
                "id": "conv-1",
                "connectionId": "conn-1",
                "title": "hello",
                "createdAt": now,
                "updatedAt": now
            },
            "messages": [
                {
                    "id": "msg-1",
                    "conversationId": "conv-1",
                    "role": "user",
                    "content": "hi",
                    "timestamp": now,
                    "createdAt": now
                }
            ]
        })
        .to_string();
        let ops = vec![
            ("conversations.conv-1".to_string(), Some(snapshot.clone())),
            ("conversations.conv-2".to_string(), None), // 删除不存在的会话：无害
        ];
        let batch = accessor.apply_batch(ops).await.unwrap();
        assert!(batch.failed_keys.is_empty());

        let db = accessor.conversation_db.clone();
        let loaded = tokio::task::spawn_blocking(move || {
            db.get_conversation_with_messages("conv-1")
                .unwrap()
                .unwrap()
        })
        .await
        .unwrap();
        assert_eq!(loaded.conversation.title, "hello");
        assert_eq!(loaded.messages.len(), 1);
        assert_eq!(loaded.messages[0].content, "hi");
    }

    #[tokio::test]
    async fn apply_batch_conversations_bad_json_collects_failed() {
        let (_dir, accessor) = test_accessor("conversations_bad");
        let now = chrono::Utc::now().to_rfc3339();
        let good = serde_json::json!({
            "conversation": {
                "id": "conv-good",
                "connectionId": "conn-1",
                "title": "ok",
                "createdAt": now,
                "updatedAt": now
            },
            "messages": []
        })
        .to_string();
        let ops = vec![
            (
                "conversations.conv-bad".to_string(),
                Some("not-json".to_string()),
            ),
            ("conversations.conv-good".to_string(), Some(good)),
        ];
        let batch = accessor.apply_batch(ops).await.unwrap();
        assert_eq!(
            batch.failed_keys,
            vec!["conversations.conv-bad".to_string()]
        );

        let db = accessor.conversation_db.clone();
        let exists = tokio::task::spawn_blocking(move || {
            db.get_conversation_with_messages("conv-good")
                .unwrap()
                .is_some()
        })
        .await
        .unwrap();
        assert!(exists);
    }
}
