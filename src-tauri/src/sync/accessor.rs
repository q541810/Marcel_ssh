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

/// 同步数据访问器
pub struct SyncStoreAccessor {
    pub config_dir: PathBuf,
    pub settings: Arc<TokioRwLock<AppSettings>>,
    pub connection_store: Arc<TokioRwLock<ConnectionStore>>,
    pub quick_command_store: Arc<TokioRwLock<QuickCommandStore>>,
    pub skill_store: Arc<TokioRwLock<SkillStore>>,
    pub mcp_store: Arc<TokioRwLock<McpServerStore>>,
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
        conversation_db: Arc<ConversationDb>,
    ) -> Self {
        Self {
            config_dir,
            settings,
            connection_store,
            quick_command_store,
            skill_store,
            mcp_store,
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
            store.get_by_id(id).and_then(|c| serde_json::to_string(c).ok())
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
            log::warn!("[sync] 收到旧格式整体 'settings' key，降级为整体覆盖（建议对端升级到字段级同步）");
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

    // ── 各 store 的 apply 实现 ────────────────────────────────

    /// 字段级 settings 写入：只改单个字段，其他字段不动。
    ///
    /// value 是该字段的 JSON 值（不是整个 settings），例如：
    /// - key="settings.fontSize", value="16" → 只改 fontSize
    /// - key="settings.llmConfig.baseUrl", value="\"http://api.example.com\"" → 只改 baseUrl
    ///
    /// value=None 表示删除该字段——但 settings 字段不允许删除，
    /// 这里按"恢复默认值"处理：解析 default settings 取该字段值。
    async fn apply_settings_field(
        &self,
        key: &str,
        value: Option<&str>,
    ) -> Result<(), AppError> {
        let field_path = crate::sync::settings_field::extract_field_path(key)
            .ok_or_else(|| AppError::Config(format!("无效的 settings 字段 key: {}", key)))?;

        // 读取当前 settings → JSON Value → 修改字段 → 反序列化回 AppSettings
        let mut settings_json = {
            let settings = self.settings.read().await;
            serde_json::to_value(&*settings).map_err(|e| {
                AppError::Config(format!("序列化 settings 失败: {}", e))
            })?
        };

        match value {
            Some(json) => {
                let field_value: serde_json::Value = serde_json::from_str(json).map_err(|e| {
                    AppError::Config(format!("反序列化 settings 字段值失败: {}", e))
                })?;
                crate::sync::settings_field::set_field(&mut settings_json, field_path, field_value)?;
            }
            None => {
                // 字段不允许删除：恢复为默认值（而非真正删除）
                let defaults = serde_json::to_value(AppSettings::default())
                    .map_err(|e| AppError::Config(format!("序列化默认 settings 失败: {}", e)))?;
                if let Some(default_val) = crate::sync::settings_field::get_field(&defaults, field_path) {
                    crate::sync::settings_field::set_field(&mut settings_json, field_path, default_val)?;
                }
                // 如果默认 settings 中也没有该字段（未知字段），什么都不做
            }
        }

        // 反序列化回 AppSettings（会丢弃未知字段，向前兼容）
        let new_settings: AppSettings = serde_json::from_value(settings_json).map_err(|e| {
            AppError::Config(format!("反序列化 AppSettings 失败: {}", e))
        })?;

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

    /// 兼容旧整体 settings 同步：整体覆盖。
    ///
    /// 仅在数据迁移期间处理旧的 `"settings"` 整体 key 时使用。
    /// 新代码应使用字段级 `settings.{field}` key。
    pub async fn apply_settings_whole(&self, value: Option<&str>) -> Result<(), AppError> {
        match value {
            Some(json) => {
                let new_settings: AppSettings = serde_json::from_str(json).map_err(|e| {
                    AppError::Config(format!("反序列化 AppSettings 失败: {}", e))
                })?;

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
                let cmd: crate::config::quick_commands::QuickCommand =
                    serde_json::from_str(json).map_err(|e| {
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
                    .map_err(|e| AppError::Config(format!("持久化 quick_commands 失败: {}", e)))??;
            }
            None => {
                let mut store = self.quick_command_store.write().await;
                store.remove(id);
                let snapshot = store.clone();
                drop(store);

                tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
                    .await
                    .map_err(|e| AppError::Config(format!("持久化 quick_commands 失败: {}", e)))??;
            }
        }
        Ok(())
    }

    async fn apply_skill(&self, id: &str, value: Option<&str>) -> Result<(), AppError> {
        let path = SkillStore::default_file(&self.config_dir);
        match value {
            Some(json) => {
                let skill: crate::skills::store::Skill = serde_json::from_str(json).map_err(|e| {
                    AppError::Config(format!("反序列化 Skill 失败: {}", e))
                })?;

                let mut store = self.skill_store.write().await;
                store.delete(id);
                store.add(skill);
                let snapshot = store.clone();
                drop(store);

                tokio::task::spawn_blocking(move || snapshot.save_to_path(&path))
                    .await
                    .map_err(|e| AppError::Config(format!("持久化 skills 失败: {}", e)))??;
            }
            None => {
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
                let snapshot: ConversationWithMessages = serde_json::from_str(json).map_err(|e| {
                    AppError::Config(format!("反序列化 ConversationWithMessages 失败: {}", e))
                })?;

                // 数据库操作可能阻塞，spawn_blocking
                tokio::task::spawn_blocking(move || -> Result<(), AppError> {
                    // upsert 会话元数据 + 整体替换消息
                    db.upsert_conversation(&snapshot.conversation)
                        .map_err(|e| AppError::Config(format!("upsert conversation 失败: {}", e)))?;
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
