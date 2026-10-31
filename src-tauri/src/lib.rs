pub mod agent;
// 取消信号注册表：Agent 任务 / SFTP 上传 / SFTP 下载 / 插件安装四张取消表
// 的统一容器（此前是同一个类型抄 4 遍 + 两份逐字相同的 Drop guard）。
pub mod cancel;
// 「owner → 子资源 id」记账：owner 终态时整体取走回收（多机自动拉起的会话 /
// Agent 传输）。注册与清理的竞态由收尾标记关掉，见模块注释。
pub mod child_resources;
pub mod command_exec;
pub mod commands;
pub mod config;
// 数据源登记表 + 数据变更广播 + 统一 JSON 存储：本机所有落盘数据的唯一来源。
pub mod data;
// 分段并发下载器（HTTP Range）：GitHub 这类线路按单连接限速，安装包下载
// 靠把一条流拆成多条连接才能跑满带宽（见模块内实测数据）。
pub mod download;
pub mod error;
pub mod llm;
pub mod mcp;
pub mod mcp_server;
pub mod memory;
pub mod multi_host;
pub mod notification;
pub mod plugins;
pub mod skills;
pub mod ssh;
// 跨设备同步：核心库（HLC / 镜像 / 差异 / 落地 / 加密与远端格式，纯逻辑无 IO）
// 在 sync/core，存储适配器与运行时在其兄弟模块，见模块注释。
pub mod sync;
// 跨读取块的 UTF-8 解码器：终端 / 远端命令通道 / 本机命令管道共用，
// 避免多字节字符被包边界切开后变成 U+FFFD。
pub(crate) mod utf8_carry;
pub mod util;
// 无感更新器：桌面 Windows 走 NSIS「退出即静默安装」，Android 走 APK
// 「后台下载 + 一键拉起系统安装器」，其他桌面平台只检查提示。
pub mod updater;

use std::collections::HashMap;
use std::path::PathBuf;

use parking_lot::RwLock as PlRwLock;
use tauri::{AppHandle, Emitter, Manager};

use crate::agent::conversation::ConversationDb;
use crate::agent::task::AgentTask;
use crate::agent::task::AgentTaskPlan;
use crate::config::connections::ConnectionStore;
use crate::config::persist::JsonPersistable;
use crate::config::quick_commands::QuickCommandStore;
use crate::config::settings::AppSettings;
use crate::data::{DataChangeBus, DataSourceId, JsonStore};
use crate::mcp::manager::McpManager;
use crate::mcp::store::McpServerStore;
use crate::skills::store::SkillStore;
use crate::ssh::connection::SshManager;
use crate::ssh::known_hosts::KnownHostsStore;

/// 前端插件事件订阅总数（主 webview 的 `eventFanout` 在订阅集每次变化时
/// 经 `plugin_events_report_subscribers` 命令上报，页面初始化也会报一次现值）。
/// `plugin://events` 的唯一消费者就是主 webview 的 fanout（插件窗口收的是
/// 它二次分发的 `plugin-event-<id>`），所以归零 = 无人监听。
static PLUGIN_EVENT_SUBSCRIBERS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// 记录前端当前插件事件订阅总数；0 = 关闭 `plugin://events` 镜像。
pub fn set_plugin_event_subscribers(count: usize) {
    PLUGIN_EVENT_SUBSCRIBERS.store(count, std::sync::atomic::Ordering::Relaxed);
}

/// 发射事件到原始通道 + plugin://events 通道
/// 插件系统通过监听 plugin://events 接收所有应用事件；
/// 无插件订阅时只发原通道——镜像那份要多一次 JSON 包装 + 全 webview 广播，
/// 终端刷屏类高频事件下是白付的（见 PLUGIN_EVENT_SUBSCRIBERS 门控）。
pub fn emit_event<S: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let mirror = PLUGIN_EVENT_SUBSCRIBERS.load(std::sync::atomic::Ordering::Relaxed) > 0;
    emit_event_with_mirror(app, event, payload, mirror);
}

/// `emit_event` 的镜像开关直通实现：测试钉「镜像关 = 原通道照发、镜像开 = 照发
/// plugin://events」时不经全局计数，不干扰并行用例的事件捕获。
fn emit_event_with_mirror<S: serde::Serialize + Clone>(
    app: &AppHandle,
    event: &str,
    payload: S,
    mirror: bool,
) {
    let _ = app.emit(event, &payload);
    if mirror {
        let _ = app.emit(
            "plugin://events",
            serde_json::json!({
                "event": event,
                "data": payload,
            }),
        );
    }
}

/// Shared application state managed by Tauri.
///
/// Note: SSH-related state uses `tokio::sync::RwLock` because async tasks
/// hold these locks across `.await` points. Other state uses `parking_lot`
/// for cheaper, sync access.
#[derive(Clone)]
pub struct AppState {
    pub ssh_manager: SshManager,
    pub agent_tasks: std::sync::Arc<PlRwLock<HashMap<String, AgentTask>>>,
    pub plans: std::sync::Arc<PlRwLock<HashMap<String, AgentTaskPlan>>>,
    /// 会话级模型记忆（**仅内存**，不落盘）：conversation_id → llmRegistry
    /// 模型条目 id（空串 = 无记忆，跟随全局最近使用）。
    /// 取代旧版 SQLite `conversations.model_id` 的每会话持久化。
    /// 启动时由 `take_persisted_model_ids` 一次性装载存量值。
    pub session_models: std::sync::Arc<PlRwLock<HashMap<String, String>>>,
    /// 会话级思考强度记忆（**仅内存**，不落盘）：conversation_id →
    /// { model_id → `reasoning_effort` 档位字符串 }。
    ///
    /// 档位按「会话 × 模型」双维记忆：每个会话分别记住它用过的每个模型的
    /// 档位，切到别的模型显示该模型自己的记忆（无记忆 = 不传/跟随模型
    /// 默认），切回原模型原档位仍在——互不污染、切走不丢。
    /// 空串 = 无记忆。与 `session_models` 同生命周期（启动装载、会话删除
    /// 级联清理），但独立维度：仅当档位在当前生效模型声明内才生效。
    pub session_efforts: std::sync::Arc<PlRwLock<HashMap<String, HashMap<String, String>>>>,
    // 5 份 JSON 配置：读用 `store.read().await`（与原来的 RwLock 一致），**写只能走**
    // `mutate` / `begin_update` / `replace`（`JsonStore` 是它们唯一的写盘出口，见 `data/`）。
    pub connection_store: JsonStore<ConnectionStore>,
    pub settings: JsonStore<AppSettings>,
    pub quick_command_store: JsonStore<QuickCommandStore>,
    pub conversation_db: std::sync::Arc<ConversationDb>,
    pub skill_store: JsonStore<SkillStore>,
    pub mcp_store: JsonStore<McpServerStore>,
    /// 数据变更广播：任何已登记的数据成功写盘后发一条「哪份数据变了」。
    /// 现阶段只有测试订阅，以后的同步引擎订阅它。
    pub data_changes: DataChangeBus,
    pub mcp_manager: std::sync::Arc<McpManager>,
    /// Application config directory. Used for persisting connections, settings, etc.
    pub config_dir: PathBuf,
    /// Agent 阻塞式交互（审批 / 提问）统一队列管理器
    pub agent_interaction: crate::agent::interaction::AgentInteractionManager,
    /// 运行中 Agent 任务的取消信号（task_id → 取消通道）。置位即让 agent loop
    /// 放弃当前 LLM 调用（`llm/manager.rs` 的 `select!` 臂）。
    pub task_cancel: crate::cancel::CancellationRegistry,
    /// SFTP 上传的取消信号（upload_id → 取消通道）。
    pub upload_cancel: crate::cancel::CancellationRegistry,
    /// SFTP 下载的取消信号（download_id → 取消通道）。
    pub download_cancel: crate::cancel::CancellationRegistry,
    /// 插件安装的取消信号（install_id → 取消通道）。
    pub plugin_install_cancel: crate::cancel::CancellationRegistry,
    /// GitHub 导入 skill 的下载取消信号（import_id → 取消通道）。
    pub skill_import_cancel: crate::cancel::CancellationRegistry,
    /// **手动**上下文压缩的占位与取消信号（conversation_id → 取消通道）。
    ///
    /// 与上面四张表的区别：这里用 `try_register`（同一 id 只允许一个在册目标），
    /// 所以「在册」本身就是**互斥锁**——同一会话不允许并发两次压缩（会各写一张卡、
    /// 破坏归档边界的「恒单卡」前提）。同时它是那次摘要调用的取消通道，用户点
    /// 「取消压缩」即在这里置位，`context/mod.rs` 的 `select!` 立刻中断摘要。
    ///
    /// 为什么需要这张表：压缩不是任务（不进 `agent_tasks`），此前它**完全不可见**
    /// ——运行中发的消息会被随后落下的压缩卡盖到后面，归档边界于是把那条消息从
    /// 后续请求里抹掉。现在 `agent_compact_conversation` 在入口占位、
    /// `agent_start_task` 在入口查位，两侧都不再当会话空闲。
    ///
    /// 键是会话 id 而不是任务 id：压缩的守卫与取消都按「会话」问（一次压缩就是
    /// 该会话的一次独占操作），与 `task_cancel` 按 task_id 键控是两回事。
    pub compactions: crate::cancel::CancellationRegistry,
    /// 命令执行统一管理器：所有 SSH 命令执行（用户直发 / 系统长任务 /
    /// Agent 工具 / 插件）的唯一入口，集中管理执行记录、取消注册表
    /// （取代旧的 long_exec_cancel_senders）、断连级联取消与后台作业
    /// （环形缓冲 + 溢出文件 + 非忙等读取）。
    pub command_exec: crate::command_exec::CommandExecutionManager,
    /// 本机（用户这台电脑）命令执行管理器：与 `command_exec` **完全同构**
    /// （同一个传输层抽象、同一套结果类型与收尾语义——超时/取消只停止等待、
    /// 不杀进程），只是执行落在一台本机子进程上。
    ///
    /// 为什么要单独一个 manager 而不是共用：`command_exec` 构造时注册了
    /// SshManager 的断连观察者（会话断开 → 级联取消该会话上的执行），本机作业
    /// 与任何 SSH 会话都没有关系，共用会让「用户断了一台服务器」连坐杀掉本机
    /// 正在跑的构建/脚本。这里用 `with_transport_at`（不注册断连观察者）。
    pub local_command_exec: crate::command_exec::CommandExecutionManager,
    /// Watcher state for "open with system" files, keyed by task_id.
    /// Value = (session_id, local_path, cancel sender). local_path 用于「重复打开」时
    /// 复用已下载的本地副本（再次唤起系统应用，不重新下载、不重复监视）；
    /// cancel sender 设为 true 中止下载 + 监视。
    pub sysopen_watchers: std::sync::Arc<
        PlRwLock<HashMap<String, (String, std::path::PathBuf, tokio::sync::watch::Sender<bool>)>>,
    >,
    /// Active "open with system" dedup table: (session_id, remote_path) -> task_id.
    /// Prevents the same remote file being opened twice concurrently (which would
    /// have the two local copies clobber each other and race on sync-back).
    pub sysopen_active_paths: std::sync::Arc<PlRwLock<HashMap<(String, String), String>>>,
    /// Non-fatal warning about config load (settings / skills; e.g. file backed
    /// up). Surfaced to the frontend via `config_get_settings` so it can show a
    /// notification.
    pub settings_warning: std::sync::Arc<PlRwLock<Option<String>>>,
    /// Plugin registry: single source of truth for plugin manifests + state.
    /// Reloads on startup and whenever settings change (enable/disable plugin,
    /// authorized capabilities). Emits `plugin-registry-changed` after reload.
    pub plugin_registry: crate::plugins::registry::SharedPluginRegistry,
    /// 多机操控记账：task_id → 该任务自动拉起的会话 id（见 `multi_host` 模块）。
    /// 任务终态时经 `cleanup_task_targets` 关闭这些会话；**用户手动打开的会话
    /// 不在集合内，绝不被自动关闭**。注册与终态清理的竞态由
    /// [`crate::child_resources`] 的收尾标记关掉（不是靠"注册前查一眼"）。
    pub multi_host_targets: crate::child_resources::ChildResources,
    /// Agent 传输互斥：**同一时刻只跑一个 Agent 传输**（多 agent 任务的
    /// 上传/下载串行）。用户 SFTP 面板传输不受此锁限制（那是前端双道
    /// transferScheduler 调度，与 Agent 传输相互独立——见传输中心语义）。
    pub agent_transfer_mutex: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// Agent 传输记账：task_id → 该任务发起的 Agent 传输 id。
    /// 任务终态/停止时级联取消这些传输（只取消传输本身，不动任务）。
    /// 与 `multi_host_targets` 共用 [`crate::child_resources`] 的竞态保证。
    pub agent_transfer_by_task: crate::child_resources::ChildResources,
    /// 长期记忆（`memory/` 模块）：记忆库、注入快照、后台复盘调度、整理助手。
    pub memory: std::sync::Arc<crate::memory::MemoryManager>,
    /// 跨设备同步（`sync/` 模块）的 manager：actor + 定时器 + 命令。`setup` 里 `start`；
    /// 没开启同步时只做「旧版残留清理」并空转等命令。
    pub sync: crate::sync::SyncManager,
}

impl AppState {
    /// Create a new AppState, loading any persisted config from `config_dir`.
    ///
    /// All independent stores are loaded in parallel. File I/O is offloaded to
    /// the blocking thread pool via `tokio::task::spawn_blocking` so the async
    /// runtime is never stalled. Settings-dependent work (keychain, llm_config
    /// backfill) runs sequentially after settings are loaded.
    pub async fn new(config_dir: PathBuf) -> Self {
        crate::agent::image_store::init(&config_dir);
        // 私钥库：导入的私钥加密存放在 {config_dir}/keys，与其它配置同目录
        crate::ssh::key_store::init(&config_dir);

        // 数据变更广播：先建好，各 store 与 known_hosts 写盘后都往这里发。
        let data_changes = DataChangeBus::new();
        // 密钥链没有变更通知：把总线上报口装上，机密流才知道「本机 Key 变了」。
        // 只发「机密变了」、不带槽位也不带值——订阅方自己做全量比对。
        crate::config::keychain::install_change_bus(data_changes.clone());

        // Pre-compute file paths so each `spawn_blocking` closure can own its
        // own copy without borrowing `config_dir`.
        let connections_file = ConnectionStore::default_file(&config_dir);
        let settings_file = AppSettings::default_file(&config_dir);
        let db_path = DataSourceId::Conversations.path(&config_dir);
        let skills_file = SkillStore::default_file(&config_dir);
        let quick_commands_file = QuickCommandStore::default_file(&config_dir);
        let mcp_servers_file = McpServerStore::default_file(&config_dir);

        // Clone before the file path is moved into the spawn_blocking closure.
        let settings_backup_src = settings_file.clone();

        // Captured during phase-2 fallbacks; surfaced via AppState.settings_warning.
        let mut settings_warning: Option<String> = None;
        // 加载失败、被迫改用默认值的配置：跨设备同步据此改从镜像恢复，而不是把
        // 「全变成默认值」当成用户的删除推给其它设备。
        let mut load_failures: Vec<DataSourceId> = Vec::new();

        // ── Phase 1: parallel loads (all independent) ──────────────────────
        let (
            known_hosts_res,
            connections_res,
            settings_res,
            db_handle,
            skills_res,
            qc_res,
            mcp_res,
        ) = {
            // Clone once for the ConversationDb closure which needs both paths.
            let config_dir_for_db = config_dir.clone();

            tokio::join!(
                // KnownHostsStore::load is already async.
                KnownHostsStore::load_in_config_dir(&config_dir, Some(data_changes.clone())),
                // Sync JSON stores – offload to blocking thread pool.
                tokio::task::spawn_blocking(move || {
                    ConnectionStore::load_from_path(&connections_file)
                }),
                tokio::task::spawn_blocking(move || {
                    AppSettings::load_from_path(&settings_file)
                }),
                // ConversationDb involves SQLite file I/O + schema migration.
                tokio::task::spawn_blocking(move || -> ConversationDb {
                    match ConversationDb::new(&db_path) {
                        Ok(db) => {
                            log::info!("✓ 对话数据库已加载: {}", db_path.display());
                            match db.list_conversations("__diagnostic__") {
                                Ok(count) if !count.is_empty() => {
                                    log::info!("  数据库中有 {} 个会话记录", count.len());
                                }
                                _ => {
                                    log::info!("  数据库中暂无会话记录（首次使用）");
                                }
                            }
                            db
                        }
                        Err(e) => {
                            log::warn!("Failed to init file DB ({}): {}", db_path.display(), e);
                            log::warn!("  Falling back to in-memory DB");
                            log::warn!(
                                "  Check write permissions: {}",
                                config_dir_for_db.display()
                            );
                            ConversationDb::in_memory().expect("Failed to init in-memory DB")
                        }
                    }
                }),
                tokio::task::spawn_blocking(move || { SkillStore::load_from_path(&skills_file) }),
                tokio::task::spawn_blocking(move || {
                    QuickCommandStore::load_from_path(&quick_commands_file)
                }),
                tokio::task::spawn_blocking(move || {
                    McpServerStore::load_from_path(&mcp_servers_file)
                }),
            )
        };

        // ── Phase 2: process results with fallbacks ────────────────────────

        // KnownHosts – async fallback on error (can still .await here).
        let known_hosts = match known_hosts_res {
            Ok(kh) => kh,
            Err(e) => {
                log::error!("无法加载 known_hosts.json，尝试 fallback: {}", e);
                match KnownHostsStore::load(
                    std::env::temp_dir().join("marcel-ssh-known-hosts-fallback.json"),
                )
                .await
                {
                    Ok(store) => {
                        log::warn!("known_hosts 使用临时目录 fallback");
                        store
                    }
                    Err(e2) => {
                        log::error!("known_hosts fallback 也失败: {}; 使用纯内存 store", e2);
                        KnownHostsStore::in_memory()
                    }
                }
            }
        };

        let connection_store = match connections_res {
            Ok(Ok(store)) => store,
            Ok(Err(e)) => {
                log::warn!("无法加载连接配置，使用默认值：{}", e);
                // 先隔离原文件：开着同步时会从镜像恢复并覆盖它
                backup_config_on_load_failure(&ConnectionStore::default_file(&config_dir));
                load_failures.push(DataSourceId::Connections);
                ConnectionStore::new()
            }
            Err(join_err) => {
                log::warn!("连接配置加载任务失败：{}", join_err);
                load_failures.push(DataSourceId::Connections);
                ConnectionStore::new()
            }
        };

        let mut settings = match settings_res {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                log::warn!("无法加载应用设置，使用默认值：{}", e);
                // The file exists but is unreadable/incompatible.
                // Back it up before any save overwrites it silently.
                let bak_path = backup_config_on_load_failure(&settings_backup_src);
                let msg = match bak_path {
                    Some(path) => format!(
                        "配置文件加载失败: {}。旧文件已备份到 {}，当前使用默认设置。",
                        e,
                        path.display()
                    ),
                    None => format!("配置文件加载失败: {}。当前使用默认设置。", e),
                };
                append_load_warning(&mut settings_warning, msg);
                load_failures.push(DataSourceId::Settings);
                AppSettings::default()
            }
            Err(join_err) => {
                log::warn!("应用设置加载任务失败：{}", join_err);
                append_load_warning(
                    &mut settings_warning,
                    format!("应用设置加载任务失败: {}。当前使用默认设置。", join_err),
                );
                load_failures.push(DataSourceId::Settings);
                AppSettings::default()
            }
        };

        // Backwards-compat: 旧版单渠道单模型配置（llmConfig）在加载时自动迁移为
        // 多渠道多模型注册表（默认渠道 + 单模型 + 槽位绑定），API Key 从旧
        // keychain 条目搬入渠道条目。迁移幂等，无旧配置时不做任何改动。
        //
        // 下面三段启动期自愈各自只改内存里的 `settings` 并记一笔「要回写」，等
        // `JsonStore` 建好后统一 `save_current()` 落一次盘（旧版是每段各写一次，
        // 终态相同）。
        let mut settings_needs_save = false;
        if crate::llm::registry::migrate_legacy_settings(&mut settings) {
            log::info!("旧版 LLM 单配置已迁移为多渠道多模型注册表");
            settings_needs_save = true;
        }

        // 自愈：清理注册表里同 id 重复的模型条目（历史「保存渠道」合并 bug 的
        // 遗留数据，UI 表现为同一模型出现两次）。有改动则立即落盘修复。
        {
            let before = settings.llm_registry.models.len();
            let changed = settings.llm_registry.dedupe_duplicate_models();
            if changed {
                log::warn!(
                    "检测到 {} 条重复模型记录（同 id），已自动去重（{} → {}）并落盘修复",
                    before - settings.llm_registry.models.len(),
                    before,
                    settings.llm_registry.models.len()
                );
                settings_needs_save = true;
            }
        }

        // 自愈：归一化思考强度档位（trim + 丢空 + 去重）。旧数据可能携带首尾
        // 空格档位，会令任务注入（原始值全等比较）匹配失败而被静默忽略；
        // 启动时修一次并落盘，与「展示、持久化、注入」语义对齐。
        {
            let changed = settings.llm_registry.normalize_reasoning_efforts();
            if changed {
                log::warn!("检测到思考强度档位含空格/重复/空项，已自动归一化并落盘修复");
                settings_needs_save = true;
            }
        }

        // ── Phase 3: settings-dependent work (sequential) ──────────────────

        // LLM API Key: 移出启动关键路径（不在此处同步阻塞读取系统密钥链）。
        // 改由 tauri setup 中的后台异步任务进行预热，且 Agent 执行前具备兜底加载。

        log::info!(
            "Loaded {} saved connections from {}",
            connection_store.get_all().len(),
            config_dir.display()
        );

        let conversation_db = db_handle.expect("对话数据库初始化任务失败");

        // 旧版每会话持久化的模型选择 → 内存映射（一次性装载并清空 DB 列）。
        // 之后「会话 → 模型」只存内存，重启后由「全局最近使用」接管默认语义。
        let session_models: std::sync::Arc<PlRwLock<HashMap<String, String>>> =
            std::sync::Arc::new(PlRwLock::new(HashMap::new()));
        // 会话级思考强度：按「会话 × 模型」双维记忆，**重启后记住**——
        // 存量从 `conversations.efforts_json` 列装载（每会话一张
        // {model_id → effort} JSON 映射），之后每次变更经 set 命令回写。
        let session_efforts: std::sync::Arc<PlRwLock<HashMap<String, HashMap<String, String>>>> =
            std::sync::Arc::new(PlRwLock::new(HashMap::new()));
        match conversation_db.load_all_conversation_efforts() {
            Ok(rows) if !rows.is_empty() => {
                let mut loaded = 0usize;
                {
                    let mut map = session_efforts.write();
                    for (conv_id, json) in rows {
                        if let Some(json) = json {
                            match serde_json::from_str::<HashMap<String, String>>(&json) {
                                Ok(inner) if !inner.is_empty() => {
                                    loaded += inner.len();
                                    map.insert(conv_id, inner);
                                }
                                // 损坏/空映射：容忍跳过（保持原样，不报错不清数据）
                                _ => log::warn!(
                                    "会话 {} 的思考档位映射无法解析，已忽略（不覆盖）",
                                    conv_id
                                ),
                            }
                        }
                    }
                }
                log::info!(
                    "已装载 {} 个会话的持久化思考档位（共 {} 条 model→档位）",
                    session_efforts.read().len(),
                    loaded
                );
            }
            Ok(_) => {}
            Err(e) => log::warn!("读取持久化思考档位失败（忽略，回落默认）: {}", e),
        }
        match conversation_db.take_persisted_model_ids() {
            Ok(rows) if !rows.is_empty() => {
                {
                    let mut map = session_models.write();
                    for (conv_id, model_id) in rows {
                        map.insert(conv_id, model_id);
                    }
                }
                log::info!(
                    "已把 {} 个会话的旧模型选择迁移到内存映射（DB 列已清空）",
                    session_models.read().len()
                );
            }
            Ok(_) => {}
            Err(e) => log::warn!("读取会话旧模型选择失败（忽略，回落全局最近使用）: {}", e),
        }

        // 加载失败时 `skills_load_failed = true`：文件读不动或内容不兼容，
        // 这时**不能**让接着的内置注入落盘覆盖它（见下方注入块）。
        let (skill_store, skills_load_failed) = match skills_res {
            Ok(Ok(store)) => (store, false),
            Ok(Err(e)) => {
                log::warn!("Failed to load skills, using defaults: {}", e);
                // 文件存在但解析失败：先隔离成备份再走空 store。必须在这里做——
                // 紧随其后的内置 skill 注入会在启动期落盘覆盖 skills.json，
                // 没有备份就等于把用户全部 skill 当场销毁。
                let bak_path =
                    backup_config_on_load_failure(&SkillStore::default_file(&config_dir));
                let msg = match bak_path {
                    Some(path) => format!(
                        "技能配置加载失败: {}。旧文件已备份到 {}，本次未加载任何技能。",
                        e,
                        path.display()
                    ),
                    None => format!("技能配置加载失败: {}。本次未加载任何技能。", e),
                };
                append_load_warning(&mut settings_warning, msg);
                load_failures.push(DataSourceId::Skills);
                (SkillStore::new(), true)
            }
            Err(join_err) => {
                log::warn!("Skills 加载任务失败：{}", join_err);
                // 加载任务崩了（文件状态未知）：同样不落盘，避免覆盖掉可能是
                // 用户数据的原文件。
                append_load_warning(
                    &mut settings_warning,
                    format!("技能配置加载任务失败: {}。本次未加载任何技能。", join_err),
                );
                load_failures.push(DataSourceId::Skills);
                (SkillStore::new(), true)
            }
        };

        // 内置 skill：注入缺失项 / 覆盖旧版内容（enabled 状态保留），并摘掉已下线的
        // 旧内置项。内容以二进制内嵌版本为准，保证应用升级后用户吃到最新内容。
        //
        // 加载失败时**不落盘**（内存里照常注入，UI/工具不受影响）：空 store
        // 落盘会把刚隔离出来的原文件替换成「只剩内置项」，而持久化的内容里
        // 一个用户 skill 都没有。等用户自己触发一次保存（那时内存已合并好
        // 新内容）再写，与 connections / quick_commands / mcp「启动期不写盘」
        // 的既有做法一致。
        //
        // 落盘本身要等 `JsonStore` 建好（见下方 Phase 3 的 `skills_needs_save`）。
        let mut skills_needs_save = false;
        let skill_store = {
            let mut store = skill_store;
            let changed = crate::skills::builtin::ensure_builtin_skills(&mut store);
            let retired = crate::skills::builtin::retire_builtin_skills(&mut store);
            if !changed.is_empty() || retired > 0 {
                if skills_load_failed {
                    log::warn!(
                        "内置 skill 已注入 {} 项、下线 {} 项，但 skills.json 本次加载失败，暂不落盘（原文件保持原样）",
                        changed.len(),
                        retired
                    );
                } else {
                    skills_needs_save = true;
                    log::info!(
                        "内置 skill 已注入/更新 {} 项，下线 {} 项",
                        changed.len(),
                        retired
                    );
                }
            }
            store
        };

        let quick_command_store = match qc_res {
            Ok(Ok(store)) => store,
            Ok(Err(e)) => {
                log::warn!("Failed to load quick commands, using defaults: {}", e);
                backup_config_on_load_failure(&QuickCommandStore::default_file(&config_dir));
                load_failures.push(DataSourceId::QuickCommands);
                QuickCommandStore::new()
            }
            Err(join_err) => {
                log::warn!("Quick commands 加载任务失败：{}", join_err);
                load_failures.push(DataSourceId::QuickCommands);
                QuickCommandStore::new()
            }
        };

        let mcp_store = match mcp_res {
            Ok(Ok(store)) => store,
            Ok(Err(e)) => {
                log::warn!("Failed to load MCP servers, using defaults: {}", e);
                backup_config_on_load_failure(&McpServerStore::default_file(&config_dir));
                load_failures.push(DataSourceId::McpServers);
                McpServerStore::new()
            }
            Err(join_err) => {
                log::warn!("MCP servers 加载任务失败：{}", join_err);
                load_failures.push(DataSourceId::McpServers);
                McpServerStore::new()
            }
        };

        // ── Phase 3: wire up shared store handles ─────────────────────
        // 5 份 JSON 配置包成 `JsonStore`（此后唯一的写盘出口），供 Self{} 使用。
        let connection_store_arc =
            JsonStore::new(&config_dir, connection_store, Some(data_changes.clone()));
        let settings_arc = JsonStore::new(&config_dir, settings, Some(data_changes.clone()));
        let quick_command_store_arc =
            JsonStore::new(&config_dir, quick_command_store, Some(data_changes.clone()));
        let conversation_db_arc = std::sync::Arc::new(conversation_db);
        let skill_store_arc = JsonStore::new(&config_dir, skill_store, Some(data_changes.clone()));
        let mcp_store_arc = JsonStore::new(&config_dir, mcp_store, Some(data_changes.clone()));

        // 启动期要回写的两份：设置（LLM 迁移 / 去重 / 档位归一化）与 skills（内置注入）。
        // 失败只记日志，不阻断启动（与旧版 `let _ =` / warn 的处理一致）。
        if settings_needs_save {
            if let Err(e) = settings_arc.save_current().await {
                log::warn!("启动期设置自愈后持久化失败: {}", e);
            }
        }
        if skills_needs_save {
            if let Err(e) = skill_store_arc.save_current().await {
                log::warn!("内置 skill 同步后持久化失败: {}", e);
            }
        }

        // MCP 鉴权头从明文配置挪进密钥链（三期）。幂等；某个服务器失败就保留它的明文，
        // 由 `effective_headers` 的回落兜住，绝不因为一次写失败就把令牌弄丢。
        {
            let migrated = mcp_store_arc
                .mutate(|store| {
                    let ids = crate::mcp::store::McpServerStore::migrate_plain_headers(
                        &mut store.servers,
                    );
                    Ok(ids)
                })
                .await;
            match migrated {
                Ok(ids) if !ids.is_empty() => {
                    log::info!("已把 {} 个 MCP 服务器的鉴权头迁进密钥链", ids.len());
                }
                Ok(_) => {}
                Err(e) => log::warn!("MCP 鉴权头迁移失败（保留明文）: {e}"),
            }
        }

        let mcp_manager = std::sync::Arc::new(McpManager::new());
        let memory = std::sync::Arc::new(crate::memory::MemoryManager::open(&config_dir));

        // SSH 连接管理器 + 命令执行统一管理器（后者注册断连观察者，
        // 必须在 SshManager 构造后立即创建并共享同一句柄）。后台作业
        // 的输出溢出文件放在配置目录下，随体系统一管理；作业台账
        // （job 序号水位）与其余配置同目录，保证 job_id 跨运行单调。
        // 跨设备同步要和 GUI 共用同一份 known_hosts（指纹校验是安全边界）。
        if known_hosts.recovered_from_corruption() {
            load_failures.push(DataSourceId::KnownHosts);
        }
        let known_hosts_for_sync = known_hosts.clone();
        let ssh_manager = SshManager::with_known_hosts(known_hosts);
        let command_exec = crate::command_exec::CommandExecutionManager::new(
            ssh_manager.clone(),
            DataSourceId::JobsTemp.path(&config_dir),
            DataSourceId::JobLedger.path(&config_dir),
        )
        .await;

        // 本机执行管理器：与上面那台共用同一套命令执行体系（文件里只有子进程
        // 而不是 SSH 通道这一点不同），台账与作业溢出目录同样落在配置目录下。
        // `with_transport_at` 是**不注册断连观察者**的构造——SSH 断连不该连坐
        // 取消本机作业，正合本机需求。**这里也刻意不挂 task drain hook**：那个
        // 钩子回收的是多机操控自动拉起的 SSH 会话（见下方 state 构造之后的
        // 注释），本机作业没有任何这类子资源，挂了也只会是空转。
        // 本机作业 id 前缀 `local_job_N`：与远端 `job_N` 在形状上分开——两台
        // manager 各自从自己的台账发号，不分开就会撞 id（合并通知 / 合并列表里
        // 两条不同作业同名，读路径还会拿错数据）。前缀走**构造参数**而不是
        // 构造后的 setter：`with_transport_at_prefixed` 内部不 clone inner，
        // 没有「改不动前缀」的中间状态。
        let local_command_exec =
            crate::command_exec::CommandExecutionManager::with_transport_at_prefixed(
                std::sync::Arc::new(crate::command_exec::LocalExecTransport::new()),
                DataSourceId::LocalCommand.path(&config_dir),
                crate::command_exec::CommandExecutionManager::LOCAL_JOB_ID_PREFIX,
            );

        // 跨设备同步 manager：只构造、不起任务（`setup` 里 `start`）。
        let sync = crate::sync::SyncManager::new(crate::sync::SyncWiring {
            config_dir: config_dir.clone(),
            stores: crate::sync::sources::SourceStores {
                settings: settings_arc.clone(),
                connections: connection_store_arc.clone(),
                quick_commands: quick_command_store_arc.clone(),
                skills: skill_store_arc.clone(),
                mcp_servers: mcp_store_arc.clone(),
                known_hosts: known_hosts_for_sync,
                mcp_manager: mcp_manager.clone(),
            },
            ssh_manager: ssh_manager.clone(),
            data_changes: data_changes.clone(),
            load_failures,
            // 机密流算「本机有哪些槽位」用：连接 / 渠道 / MCP 服务器都在这里。
            // 用一个可刷新的快照缓存，而不是每次 `read().await`——驱动工厂的 `create` 是同步的。
            secret_catalog: Some({
                let connections = connection_store_arc.clone();
                let settings = settings_arc.clone();
                let mcp_servers = mcp_store_arc.clone();
                let cache: std::sync::Arc<
                    parking_lot::Mutex<crate::config::keychain::SecretSlotCatalog>,
                > = std::sync::Arc::new(parking_lot::Mutex::new(Default::default()));
                // 后台定期刷新（并第一次立刻刷），读侧永远拿缓存：30 秒的滞后对「有哪些槽位」
                // 完全够用，而它在 `create_driver` 的同步上下文里必须立刻返回。
                {
                    let cache = cache.clone();
                    tauri::async_runtime::spawn(async move {
                        loop {
                            let mut catalog = crate::config::keychain::SecretSlotCatalog::default();
                            catalog.connection_ids = connections
                                .read()
                                .await
                                .connections
                                .iter()
                                .map(|c| c.id.clone())
                                .collect();
                            catalog.channel_ids = settings
                                .read()
                                .await
                                .llm_registry
                                .channels
                                .iter()
                                .map(|c| c.id.clone())
                                .collect();
                            catalog.mcp_ids = mcp_servers
                                .read()
                                .await
                                .servers
                                .iter()
                                .map(|s| s.id.clone())
                                .collect();
                            *cache.lock() = catalog;
                            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        }
                    });
                }
                std::sync::Arc::new(move || cache.lock().clone())
            }),
        });

        let state = Self {
            ssh_manager,
            agent_tasks: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            plans: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            session_models,
            session_efforts,
            connection_store: connection_store_arc,
            settings: settings_arc,
            quick_command_store: quick_command_store_arc,
            conversation_db: conversation_db_arc,
            skill_store: skill_store_arc,
            mcp_store: mcp_store_arc,
            data_changes,
            mcp_manager: mcp_manager.clone(),
            config_dir,
            agent_interaction: crate::agent::interaction::AgentInteractionManager::new(),
            task_cancel: crate::cancel::CancellationRegistry::new(),
            upload_cancel: crate::cancel::CancellationRegistry::new(),
            download_cancel: crate::cancel::CancellationRegistry::new(),
            plugin_install_cancel: crate::cancel::CancellationRegistry::new(),
            skill_import_cancel: crate::cancel::CancellationRegistry::new(),
            compactions: crate::cancel::CancellationRegistry::new(),
            command_exec,
            local_command_exec,
            sysopen_watchers: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            sysopen_active_paths: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            settings_warning: std::sync::Arc::new(PlRwLock::new(settings_warning)),
            plugin_registry: crate::plugins::registry::new_shared(),
            multi_host_targets: crate::child_resources::ChildResources::new(),
            agent_transfer_mutex: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            agent_transfer_by_task: crate::child_resources::ChildResources::new(),
            memory,
            sync,
        };

        // 「作业活得比回合久」的资源回收钩子（见
        // `command_exec::CommandExecutionManager::set_task_drain_hook`）：
        // 任务收尾时名下还有作业在跑的自动拉起会话会先留着（关它会连坐杀掉
        // 作业），等末条作业结算时由这里断开。闭包自己捕获 AppState ——
        // command_exec 因此不必知道多机操控，也不必知道应用状态长什么样。
        {
            let drain_state = state.clone();
            state
                .command_exec
                .set_task_drain_hook(std::sync::Arc::new(move |task_id: &str| {
                    let state = drain_state.clone();
                    let task_id = task_id.to_string();
                    tokio::spawn(async move {
                        crate::multi_host::cleanup_task_targets(&state, &task_id).await;
                    });
                }));
        }

        state
    }
}

/// When a config file exists but cannot be deserialised (schema mismatch,
/// corruption, version drift), copy it to a backup so the incompatible
/// file is never silently overwritten by a subsequent save.
/// Timestamped backups grow unbounded if loading fails on every launch.
/// Keep at most this many historical copies; prune older ones.
/// Returns the path of the "latest" backup (`<name>.json.bak`) if it was
/// successfully created, for surfacing a warning to the user.
const MAX_TIMESTAMPED_CONFIG_BACKUPS: usize = 5;

/// 把加载失败的原文件隔离成备份，返回「最近一次失败」备份的路径（供 UI 提示）。
///
/// 命名沿用 settings 的既有做法：`<name>.json.bak`（每次失败覆盖，永远是最新
/// 现场）+ `<name>.json.<时间戳>.bak`（历史快照，最多保留
/// [`MAX_TIMESTAMPED_CONFIG_BACKUPS`] 份，避免连续失败时无限堆积）。
/// **启动期写盘（内置注入、补齐字段）与加载失败必须保住原文件**：不隔离就等于
/// 用户数据被后续保存静默覆盖。
fn backup_config_on_load_failure(file: &std::path::Path) -> Option<std::path::PathBuf> {
    let parent = file.parent().unwrap_or_else(|| std::path::Path::new("."));

    // Overwrite the most recent "last failure" backup (single file, always fresh).
    let bak_path = file.with_extension("json.bak");
    let bak_created = match std::fs::copy(file, &bak_path) {
        Ok(_) => {
            log::warn!("旧配置文件已备份到: {}", bak_path.display());
            true
        }
        Err(e) => {
            log::error!("无法备份旧配置文件: {} ({})", bak_path.display(), e);
            false
        }
    };

    // Timestamped snapshot — pruned so failures over many launches don't pile up.
    let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let ts_path = file.with_extension(format!("json.{}.bak", ts));
    let _ = std::fs::copy(file, &ts_path);

    // Prune excess timestamped backups (oldest first). 只清 `<name>.json.*`，
    // 不会碰到别的配置文件的快照。
    let prefix = file
        .file_name()
        .map(|n| format!("{}.", n.to_string_lossy()))
        .unwrap_or_default();
    if let Ok(dir) = std::fs::read_dir(parent) {
        let mut stamped: Vec<_> = dir
            .filter_map(|e| e.ok())
            .filter(|e| {
                !prefix.is_empty() && e.file_name().to_string_lossy().starts_with(prefix.as_str())
            })
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                Some((e.path(), m.modified().ok()?))
            })
            .collect();
        if stamped.len() > MAX_TIMESTAMPED_CONFIG_BACKUPS {
            stamped.sort_by_key(|(_, t)| *t);
            for (path, _) in stamped
                .iter()
                .take(stamped.len() - MAX_TIMESTAMPED_CONFIG_BACKUPS)
            {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    if bak_created {
        Some(bak_path)
    } else {
        None
    }
}

/// 追加一条非致命加载警告：settings 与 skills 可能同一次启动都失败，
/// 两个提示都要留住（[`AppState::settings_warning`] 只有一个槽位）。
fn append_load_warning(slot: &mut Option<String>, msg: String) {
    match slot {
        Some(prev) => {
            prev.push('\n');
            prev.push_str(&msg);
        }
        None => *slot = Some(msg),
    }
}

/// Build and run the Tauri application.
///
/// `mobile_entry_point` generates the JNI entry symbol Android needs to boot
/// the app from `libmarcel_ssh.so`; on desktop it's a no-op and `main.rs`
/// keeps calling `run()` directly.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let builder = tauri::Builder::default();

    // 单实例：配置目录（会话库、设置、known_hosts、插件注册表）与无感更新的
    // 「退出即装」都假定只有一个进程在用，多开会互相覆盖。第二次启动只把已运行
    // 实例的主窗口拉回前台，自己退出。必须最先注册（官方要求，否则第二个实例
    // 可能已经开始读写配置）。仅桌面发布版：开发版不拦，免得本机装着发布版时
    // `tauri dev` 一启动就退出；MCP Server 模式在 `main()` 里先于 `run()` 分流，
    // 不受影响。
    #[cfg(all(desktop, not(debug_assertions)))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            // 主窗口启动时是隐藏的，前端就绪（`app_ready`）才显示；那之前不要抢着
            // show，否则会闪一下白屏。
            if window.is_visible().unwrap_or(false) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    }));

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .register_uri_scheme_protocol("plugin", |app, request| {
            crate::commands::plugin_uri::handle_plugin_uri(app, request)
        })
        .on_window_event(|window, event| {
            // 主窗口真正销毁时同步关闭所有插件独立窗口：Tauri 只在最后一个窗口
            // 关闭后退出应用，悬浮的插件窗口（如桌宠）不关会挡住应用退出。
            //
            // 挂在 `Destroyed` 而不是 `CloseRequested`：前端的退出确认
            // （`QuitGuard`，还有任务在跑时拦住关闭并询问）可能把这次关闭否决掉，
            // 而 `CloseRequested` 是在前端有机会否决**之前**触发的 —— 挂在那里，
            // 用户点了「继续使用」之后插件窗口（桌宠等）已经被提前关光了。
            #[cfg(desktop)]
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    crate::commands::plugin_window::close_all_plugin_windows(&window.app_handle());
                }
            }
        })
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));

            log::info!("App config directory: {}", config_dir.display());
            // AppState::new is async — create a short-lived runtime to drive
            // the parallel initialization. Independent stores load via
            // spawn_blocking (thread pool) while KnownHostsStore::load runs
            // natively on the async runtime. The runtime is dropped as soon as
            // the state is ready, so no extra threads linger.
            let init_rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("Failed to create initialization runtime");
            let app_state = init_rt.block_on(AppState::new(config_dir));
            drop(init_rt);

            app.manage(app_state);

            // Load plugin manifests into the registry. Failure degrades to an
            // empty registry + log; the app still starts so the user can fix
            // the problem (e.g. bad plugin manifest) via the settings UI.
            {
                let state = app.state::<AppState>();
                let config_dir = state.config_dir.clone();
                let registry = state.plugin_registry.clone();
                let settings = state.settings.blocking_read().clone();
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let app_version = app_handle.package_info().version.to_string();
                    let diff = {
                        let mut reg = registry.write().await;
                        reg.reload(&config_dir, &settings, &app_version).await
                    };
                    log::info!(
                        "插件注册表已加载: {} 个插件, {} 个变更",
                        diff.all_ids.len(),
                        diff.changed.len()
                    );
                    use tauri::Emitter;
                    let _ = app_handle.emit("plugin-registry-changed", &diff);
                });
            }

            // Background: refresh MCP tools for enabled servers without blocking startup.
            let mcp_manager = app.state::<AppState>().mcp_manager.clone();
            let mcp_store = app.state::<AppState>().mcp_store.clone();
            tauri::async_runtime::spawn(async move {
                let servers = mcp_store.read().await;
                let enabled: Vec<_> = servers
                    .list()
                    .iter()
                    .filter(|s| s.enabled)
                    .cloned()
                    .collect();
                drop(servers);
                let mut set = tokio::task::JoinSet::new();
                for server in enabled {
                    let mgr = mcp_manager.clone();
                    set.spawn(async move {
                        // 与任务启动共用同一次在途发现：预热没回来时就开任务，不会再发一遍。
                        match mgr.ensure_refresh(&server).await {
                            Ok(tools) => {
                                log::info!("MCP [{}] 发现 {} 个工具", server.name, tools.len())
                            }
                            Err(err) => log::warn!("MCP [{}] 刷新失败: {}", server.name, err),
                        }
                    });
                }
                while let Some(_) = set.join_next().await {}
            });

            // Background: 异步预热系统密钥链中的各渠道 LLM API Key，不阻塞启动
            // 关键路径。解析时的兜底（registry.build_resolved）仍会在缺失时补读，
            // 预热只是优化首请求延迟。
            {
                let settings_arc = app.state::<AppState>().settings.clone();
                tauri::async_runtime::spawn(async move {
                    let channel_ids: Vec<String> = {
                        let settings = settings_arc.read().await;
                        settings
                            .llm_registry
                            .channels
                            .iter()
                            .map(|c| c.id.clone())
                            .collect()
                    };
                    for id in channel_ids {
                        let id_owned = id.clone();
                        let key_res = tokio::task::spawn_blocking(move || {
                            crate::config::keychain::get(
                                &crate::config::keychain::SecretSlot::LlmChannel(id_owned),
                            )
                        })
                        .await;
                        if let Ok(Ok(Some(key))) = key_res {
                            // `api_key` 不进序列化（skip_serializing），所以这一步走
                            // `mutate` 只会换入内存、**不会写盘也不会广播**。
                            let _ = settings_arc
                                .mutate(|settings| {
                                    if let Some(channel) = settings
                                        .llm_registry
                                        .channels
                                        .iter_mut()
                                        .find(|c| c.id == id)
                                    {
                                        if channel.api_key.is_empty() {
                                            channel.api_key = key;
                                        }
                                    }
                                    Ok(())
                                })
                                .await;
                        }
                    }
                    log::info!("已后台异步预热各渠道 LLM API Key");
                });
            }

            // 断连级联取消交互队列：注册 SshManager 断连观察者，无论主动 disconnect
            // 还是远端超时/断网断连，都同步取消属于该 session 的 pending 交互。
            {
                let state = app.state::<AppState>();
                let app_handle = app.handle();
                let interaction_mgr = state.agent_interaction.clone();
                let app_handle_for_disconnect = app_handle.clone();
                let ssh_mgr = state.ssh_manager.clone();
                tauri::async_runtime::spawn(async move {
                    ssh_mgr
                        .register_disconnect_observer(std::sync::Arc::new(move |session_id| {
                            interaction_mgr.cancel_session_interactions(
                                &app_handle_for_disconnect,
                                session_id,
                            );
                        }))
                        .await;
                });
            }

            // 断连级联停止 agent 任务：会话真正断开（主动 disconnect 或远端掉线）
            // 时，把绑在该会话上的任务按「点停止」同一套语义停掉（含全部子 agent）
            // —— 会话没了，它们依赖的工具一个也做不成；而前端在断连路径上会把
            // 任务就地收成「已取消」并拆掉事件通道，之后界面上既看不见、也没有
            // 入口再停（停止按钮只对运行中的任务亮）。
            {
                let state = app.state::<AppState>();
                let app_handle = app.handle().clone();
                let ssh_mgr = state.ssh_manager.clone();
                tauri::async_runtime::spawn(async move {
                    ssh_mgr
                        .register_disconnect_observer(std::sync::Arc::new(move |session_id| {
                            // 观察者在终端驱动的收尾路径上被**同步**调用，不能阻塞：
                            // 级联停止要 await 任务表、交互队列与命令取消，挪进运行时。
                            let app = app_handle.clone();
                            let sid = session_id.to_string();
                            tauri::async_runtime::spawn(async move {
                                let Some(state) = app.try_state::<AppState>() else {
                                    return;
                                };
                                let state: AppState = state.inner().clone();
                                crate::agent::manager::stop_tasks_for_disconnected_session(
                                    &app, &state, &sid,
                                )
                                .await;
                            });
                        }))
                        .await;
                });
            }

            // 长期记忆：挂上 AppHandle（各处钩子只拿得到 AppState，发事件要用它）、
            // 启动补复盘（最近几天上次没来得及复盘的会话），以及「会话断开 = 这段
            // 对话告一段落」的观察者。
            {
                let state = app.state::<AppState>();
                state.memory.attach_app(app.handle().clone());
                let st: AppState = state.inner().clone();
                tauri::async_runtime::spawn(async move {
                    crate::memory::reflect::spawn_catch_up(st);
                });
                let st: AppState = state.inner().clone();
                let ssh_mgr = state.ssh_manager.clone();
                tauri::async_runtime::spawn(async move {
                    ssh_mgr
                        .register_disconnect_observer(std::sync::Arc::new(move |session_id| {
                            st.memory.reflector.on_session_closed(&st, session_id);
                        }))
                        .await;
                });
            }

            // 无感更新器：启动清理 + 恢复未装上的安装包 + 后台检查循环。
            // 全平台启动；退出时静默安装只在 Windows 有意义（见下方 RunEvent::Exit）。
            crate::updater::init(app.handle());

            // 跨设备同步：清理旧版同步残留，起 actor。首轮同步要等前端订阅好事件后
            // 第一次调用 `sync_now`（或 15 秒兜底），启动期不做任何落地。
            app.state::<AppState>().sync.start(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_ready,
            commands::app_bootstrap::app_get_bootstrap,
            commands::mobile_set_app_foreground,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_connect_with_saved_password,
            commands::ssh::ssh_connect_with_saved_passphrase,
            commands::ssh::ssh_reconnect,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_send_input,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_list_sessions,
            commands::ssh::ssh_exec,
            commands::ssh::ssh_exec_long,
            commands::ssh::ssh_exec_long_cancel,
            commands::ssh_keys::ssh_key_import_file,
            commands::ssh_keys::ssh_key_import_text,
            commands::ssh_keys::ssh_key_list,
            commands::ssh_keys::ssh_key_rename,
            commands::ssh_keys::ssh_key_delete,
            commands::ssh_keys::ssh_key_origin_status,
            commands::ssh_keys::ssh_key_refresh_from_origin,
            commands::agent_lifecycle::agent_start_task,
            commands::agent_lifecycle::agent_stop_task,
            commands::agent_attachment::agent_read_local_file,
            commands::agent_attachment::agent_get_local_file_name,
            commands::job::job_list,
            commands::job::job_kill,
            commands::job::job_pending_notice,
            commands::job::job_ack_notice,
            commands::agent_lifecycle::agent_approve_operation,
            commands::agent_lifecycle::agent_reject_operation,
            commands::agent_lifecycle::agent_answer_question,
            commands::agent_compact::agent_compact_conversation,
            commands::agent_compact::agent_cancel_compaction,
            commands::agent_policy::agent_check_command,
            commands::agent_policy::agent_approval_overview,
            commands::agent_policy::agent_list_risk_rules,
            commands::agent_policy::agent_list_approvable_tools,
            commands::agent_policy::agent_default_approval_prompt,
            commands::agent_policy::agent_default_jev_prompt,
            commands::agent_conversation::agent_create_conversation,
            commands::agent_conversation::agent_rename_conversation,
            commands::agent_conversation::agent_set_conversation_pinned,
            commands::agent_conversation::agent_fork_conversation,
            commands::agent_conversation::agent_set_session_model,
            commands::agent_conversation::agent_get_session_model,
            commands::agent_conversation::agent_set_session_effort,
            commands::agent_conversation::agent_get_session_effort,
            commands::agent_conversation::agent_get_conversation,
            commands::agent_conversation::agent_list_conversations,
            commands::agent_conversation::agent_load_conversation,
            commands::agent_conversation::agent_load_active_messages,
            commands::agent_conversation::agent_load_earlier_messages,
            commands::agent_conversation::agent_archive_conversation,
            commands::agent_conversation::agent_unarchive_conversation,
            commands::agent_conversation::agent_list_archived_conversations,
            commands::agent_conversation::agent_purge_expired_archived,
            commands::agent_conversation::agent_delete_conversation,
            commands::agent_conversation::agent_save_message_images,
            commands::agent_conversation::agent_save_user_message,
            commands::agent_conversation::agent_resolve_image_path,
            commands::agent_conversation::agent_read_message_image,
            commands::agent_conversation::agent_delete_message_image,
            commands::agent_conversation::agent_truncate_conversation,
            commands::agent_conversation::agent_list_conversations_by_connection,
            commands::agent_conversation::agent_search_conversations,
            commands::agent_conversation::agent_delete_conversations_by_session,
            commands::agent_conversation::agent_load_plans_by_conversation,
            commands::connections::config_get_connections,
            commands::connections::config_save_connection,
            commands::connections::config_set_connection_remote_platform,
            commands::connections::config_apply_connection_order,
            commands::connections::config_delete_connection,
            commands::memory::memory_overview,
            commands::memory::memory_apply,
            commands::memory::memory_revert_op,
            commands::memory::memory_revert_batch,
            commands::memory::memory_batch_ops,
            commands::memory::memory_mark_seen,
            commands::memory::memory_reflection_notes,
            commands::memory::memory_conversation_injected,
            commands::memory::memory_count_for_connection,
            commands::memory::memory_delete_scope,
            commands::memory::memory_assistant_run,
            commands::memory::memory_assistant_cancel,
            commands::settings::config_get_settings,
            commands::settings::config_save_settings,
            commands::settings::config_validate_custom_protected_paths,
            commands::settings::llm_list_models,
            commands::keychain::config_save_password,
            commands::keychain::config_has_password,
            commands::keychain::config_delete_password,
            commands::keychain::config_save_passphrase,
            commands::keychain::config_has_passphrase,
            commands::keychain::config_delete_passphrase,
            commands::keychain::config_save_jump_password,
            commands::keychain::config_has_jump_password,
            commands::keychain::config_delete_jump_password,
            commands::market::market_list,
            commands::market::market_detail,
            commands::keychain::config_save_jump_passphrase,
            commands::keychain::config_has_jump_passphrase,
            commands::keychain::config_delete_jump_passphrase,
            commands::quick_command::quick_command_list,
            commands::quick_command::quick_command_add,
            commands::quick_command::quick_command_update,
            commands::quick_command::quick_command_delete,
            commands::keychain::config_save_llm_channel_api_key,
            commands::keychain::config_delete_llm_channel_api_key,
            commands::keychain::config_save_web_search_api_key,
            commands::keychain::config_delete_web_search_api_key,
            commands::keychain::config_save_custom_search_api_key,
            commands::keychain::config_delete_custom_search_api_key,
            commands::keychain::config_save_custom_fetch_api_key,
            commands::keychain::config_delete_custom_fetch_api_key,
            commands::keychain::config_save_tavily_fetch_api_key,
            commands::keychain::config_delete_tavily_fetch_api_key,
            commands::keychain::config_save_deepseek_tools_api_key,
            commands::keychain::config_delete_deepseek_tools_api_key,
            commands::keychain::config_save_jev_api_key,
            commands::keychain::config_delete_jev_api_key,
            commands::skill::skill_list,
            commands::skill::skill_add,
            commands::skill::skill_update,
            commands::skill::skill_toggle,
            commands::skill::skill_delete,
            commands::skill::skill_reorder,
            commands::skill::import_skill_file,
            commands::skill::skill_discover_from_url,
            commands::skill::skill_import_from_url,
            commands::skill::skill_import_cancel,
            commands::mcp::mcp_list_servers,
            commands::mcp::mcp_add_server,
            commands::mcp::mcp_update_server,
            commands::mcp::mcp_delete_server,
            commands::mcp::mcp_toggle_server,
            commands::mcp::mcp_refresh_tools,
            commands::mcp::mcp_call_tool,
            // MCP **server**（对外服务，与上面的 client 方向相反）。桌面与 Android 共用。
            commands::mcp_server::mcp_server_status,
            commands::mcp_server::mcp_server_start_http,
            commands::mcp_server::mcp_server_stop_http,
            commands::mcp_server::mcp_server_regenerate_token,
            commands::mcp_server::mcp_server_client_config,
            commands::mcp_server::mcp_server_defaults,
            commands::update::check_update,
            commands::update::open_external_url,
            commands::update::get_update_state,
            commands::update::install_update_now,
            commands::update::start_update_download,
            commands::update::update_capabilities,
            commands::sftp::sftp_list_dir,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_remove_via_shell,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_paste_entry,
            commands::sftp::sftp_extract_archive,
            commands::sftp::sftp_compress_archive,
            commands::sftp::sftp_read_file,
            commands::sftp::sftp_get_mtime,
            commands::sftp::sftp_home_dir,
            commands::sftp::sftp_write_file,
            commands::sftp::sftp_download_stream,
            commands::sftp::sftp_upload_stream,
            commands::sftp::sftp_local_file_name,
            commands::sftp::sftp_cancel_upload,
            commands::sftp::sftp_cancel_download,
            commands::sftp::sftp_upload_folder_stream,
            commands::sftp::sftp_prepare_drag_upload,
            commands::sftp::sftp_cleanup_temp_dir,
            commands::sftp::sftp_preview_image,
            commands::sftp::sftp_preview_cleanup,
            commands::sftp::sftp_open_with_system,
            commands::sftp::sftp_cancel_sysopen,
            commands::plugin_webview::plugin_webview_create,
            commands::plugin_webview::plugin_webview_set_bounds,
            commands::plugin_webview::plugin_webview_close,
            commands::plugin_window::plugin_window_create,
            commands::plugin_window::plugin_window_show,
            commands::plugin_window::plugin_window_hide,
            commands::plugin_window::plugin_window_close,
            commands::plugin_window::plugin_window_focus,
            commands::plugin_window::plugin_window_set_position,
            commands::plugin_window::plugin_window_set_size,
            commands::plugin_window::plugin_window_set_always_on_top,
            commands::plugin_window::plugin_window_set_ignore_cursor_events,
            commands::plugin_menu::plugin_menu_register,
            commands::plugin_menu::plugin_menu_update,
            commands::plugin_menu::plugin_menu_unregister,
            commands::plugin_menu::plugin_menu_popup,
            commands::plugin::plugin_list,
            commands::plugin::plugin_capability_map,
            commands::plugin::plugin_reload,
            commands::plugin::plugin_events_report_subscribers,
            commands::plugin::get_plugin_dir,
            commands::plugin::open_plugin_dir,
            commands::plugin_install::plugin_install,
            commands::plugin_install::plugin_update,
            commands::plugin_install::plugin_uninstall,
            commands::plugin_install::plugin_install_cancel,
            commands::plugin_fs::plugin_fs_read,
            commands::plugin_fs::plugin_fs_write,
            commands::plugin_http::plugin_http_request,
            commands::plugin_notification::plugin_send_notification,
            // 跨设备同步
            commands::sync::sync_get_status,
            commands::sync::sync_test_storage,
            commands::sync::sync_create,
            commands::sync::sync_join,
            commands::sync::sync_join_manual,
            commands::sync::sync_now,
            commands::sync::sync_get_sync_code,
            commands::sync::sync_get_recovery_key,
            commands::sync::sync_set_device_name,
            commands::sync::sync_list_devices,
            commands::sync::sync_list_history,
            commands::sync::sync_undo,
            commands::sync::sync_confirm_held,
            commands::sync::sync_set_tier,
            commands::sync::sync_tier_estimate,
            commands::sync::sync_disable,
        ])
        .build(tauri::generate_context!())
        .expect("Fatal: failed to start Tauri application")
        .run(|app, event| {
            // 应用完全退出且有待装更新包时，延迟静默运行 NSIS 安装器
            // （/S 静默 /UPDATE 更新模式 /R 装完自动重启应用）。用户正常
            // 关闭应用即完成无感升级；「立即安装」也走这一路径。
            // 仅 Windows：Android 的系统安装器必须由用户确认，没有「退出即装」。
            #[cfg(windows)]
            if let tauri::RunEvent::Exit = event {
                crate::updater::install_on_exit(app);
            }
            // 移动端生命周期兜底：Android 切前台时 Tauri 抛出 Resumed。
            // 桌面端此事件通常不触发，emit 出去前端也只在移动端监听，无副作用。
            // 前端 (src/mobile/App.tsx) 用 visibilitychange 作为主信号，本事件作兜底，
            // 确保 WebView 被冻结后恢复时至少有一次状态刷新机会。
            //
            // 注：Tauri 2.10.3 的 RunEvent 无 Suspended variant，切后台信号
            // 仅靠前端 visibilitychange 触发，不影响 SSH/Agent 后台运行（前台服务保活）。
            // Resumed 时同步「在前台」给 notification，避免恢复后仍按后台发系统通知。
            if let tauri::RunEvent::Resumed = event {
                #[cfg(mobile)]
                crate::notification::set_app_in_foreground(true);
                let _ = app.emit("mobile://lifecycle", "resumed");
            }
        });
}

#[cfg(test)]
mod config_backup_tests {
    use super::*;

    /// 每个测试独立临时目录，避免互相污染。
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "marcel-config-backup-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    /// 损坏的 skills.json：加载失败时先把原文件隔离成备份，且原文件保持原样
    /// （隔离是复制，不是移动/删除）—— 后续的内置注入落盘不得凭空白覆盖用户数据。
    #[test]
    fn corrupt_skills_file_is_backed_up_with_content_preserved() {
        let dir = temp_dir("skills");
        let path = dir.join("skills.json");
        // 缺 id / prompt / createdAt / updatedAt 的 skill 项 → 解析失败
        let corrupt = r#"{"skills":[{"name":"只有名字"}]}"#;
        std::fs::write(&path, corrupt).unwrap();

        assert!(
            crate::skills::store::SkillStore::load_from_path(&path).is_err(),
            "该内容必须被判为加载失败（测试前置条件）"
        );

        let bak = backup_config_on_load_failure(&path).expect("备份必须成功");
        assert_eq!(std::fs::read_to_string(&bak).unwrap(), corrupt);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            corrupt,
            "原文件保持原样"
        );
        let stamped = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.starts_with("skills.json.") && name != "skills.json.bak"
            })
            .count();
        assert!(stamped >= 1, "必须留下带时间戳的快照");
    }

    /// 时间戳快照按文件名各自成组：裁剪只针对自己那一族，别的配置文件的快照
    /// 不得被牵连删除；同一文件的快照数量有上限（连续启动失败不会无限堆积）。
    #[test]
    fn timestamped_snapshots_are_pruned_per_file_name() {
        let dir = temp_dir("prune");
        let skills = dir.join("skills.json");
        std::fs::write(&skills, "{ broken").unwrap();
        let other = dir.join("settings.json.20200101_000000.bak");
        std::fs::write(&other, "keep me").unwrap();

        for _ in 0..(MAX_TIMESTAMPED_CONFIG_BACKUPS + 3) {
            backup_config_on_load_failure(&skills);
        }

        let skills_snapshots = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                name.starts_with("skills.json.") && name != "skills.json.bak"
            })
            .count();
        assert!(
            skills_snapshots <= MAX_TIMESTAMPED_CONFIG_BACKUPS,
            "快照数量必须被裁剪，实际 {}",
            skills_snapshots
        );
        assert!(other.exists(), "别的配置文件的快照不得被删掉");
    }

    /// settings 与 skills 同一次启动都失败时两条提示都要留住
    /// （`settings_warning` 只有一个槽位，后写的不能把前一条顶掉）。
    #[test]
    fn load_warnings_append_instead_of_overwriting() {
        let mut slot = None;
        append_load_warning(&mut slot, "设置失败".into());
        append_load_warning(&mut slot, "技能失败".into());
        let text = slot.expect("至少有一条警告");
        assert!(
            text.contains("设置失败") && text.contains("技能失败"),
            "两条警告都必须保留: {}",
            text
        );
    }
}

#[cfg(test)]
mod emit_event_tests {
    use std::sync::Arc;

    use parking_lot::Mutex;
    use tauri::Listener;

    use super::emit_event_with_mirror;

    /// 镜像关 = 原通道照发、`plugin://events` 不发；镜像开 = 两条都发。
    /// 直测 `emit_event_with_mirror` 而不是拨全局计数：计数拨 0 会关掉并行
    /// 跑的 scripted_tests（靠 plugin://events 捕获事件总线）的镜像，制造 flake；
    /// 全局计数与命令的接线由 scripted 测试架的 `set_plugin_event_subscribers(1)`
    /// 真实使用覆盖。
    #[test]
    fn plugin_mirror_is_gated_on_the_mirror_flag() {
        let app = tauri::Builder::default()
            .any_thread()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("windowless Tauri host");
        let raw: Arc<Mutex<Vec<String>>> = Arc::default();
        let mirrored: Arc<Mutex<Vec<String>>> = Arc::default();
        let raw_cap = raw.clone();
        let mirror_cap = mirrored.clone();
        app.listen("unit://gated", move |e| {
            raw_cap.lock().push(e.payload().to_string())
        });
        app.listen("plugin://events", move |e| {
            mirror_cap.lock().push(e.payload().to_string())
        });

        emit_event_with_mirror(&app.handle(), "unit://gated", "quiet", false);
        assert_eq!(raw.lock().len(), 1, "原通道必须始终照发");
        assert!(
            mirrored.lock().is_empty(),
            "镜像关闭时不得发 plugin://events"
        );

        emit_event_with_mirror(&app.handle(), "unit://gated", "listening", true);
        assert_eq!(raw.lock().len(), 2, "原通道不受镜像开关影响");
        {
            let got = mirrored.lock();
            assert_eq!(got.len(), 1, "镜像开启时必须照发 plugin://events");
            assert!(
                got[0].contains("unit://gated") && got[0].contains("listening"),
                "镜像载荷应带事件名与数据: {}",
                got[0]
            );
        }
    }
}
