//! 评测入口：用**生产 agent 循环**跑一道考题，产出一份成绩 JSON。
//!
//! 只存在于测试编译里（`#[cfg(test)]`），正式版二进制里一行都没有。外层调度器
//! （`evals/server.mjs`）先 `cargo test --lib --no-run` 编出测试程序，再对每道题
//! 起一个进程：
//!
//! ```text
//! MARCEL_EVAL_JOB=<job.json> <test-exe> eval_runner::run_job --ignored --exact --nocapture
//! ```
//!
//! 一个进程只跑一道题：Wry 宿主、SQLite、SSH 连接都随进程生灭，题与题之间
//! 不会串状态，也不会争用桌面 event loop 的全局状态（同 `scripted_tests.rs`）。
//!
//! # 与 App 里跑的是同一套东西
//!
//! AgentManager / LlmManager / SSE 解析 / 工具派发 / 风险评估 / 审批队列 / 上下文
//! 压缩 / 子 agent / SQLite 落库全部是生产代码；SSH 走 `SshManager::connect`（与
//! GUI 连接同一条路，带 PTY），主机密钥照常校验（调度器把靶机指纹交进来预先登记）。
//! 刻意不同的只有三处，每处都是「评测环境里没有真人、没有用户本机」的直接后果：
//!
//! 1. **配置是全新的空目录**：没有用户的长期记忆、附加指令、插件、技能、MCP。
//!    否则测出来的是某个人的个人配置，不是这个版本。要测某项设置，用 job 的
//!    `settingsPatch` 显式打开。
//! 2. **审批与提问自动应答**：所有「等用户回应」都经 `AgentInteractionManager`
//!    这一个口子，这里订阅它：审批一律放行（「直接拒绝」档在派发前就拦了，不会
//!    到这里——那是真实行为，正好要测），提问按考题预设回答。每次都记账。
//! 3. **作用在用户本机的工具被拦下**（[`host_side_block`]）：主 agent 能派本机子
//!    agent、在本机与远端之间搬文件，评测里这些会落到跑评测的这台电脑上。工具
//!    清单不变（提示词与生产一致），只是调用时返回明确的失败说明。
//!
//! 新增「等用户回应」的交互类型时：它若不走 `AgentInteractionManager`，评测会
//! 卡到超时；走了但 kind 不认识，这里会把这道题判为 harness 错误并报出名字。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::{mpsc, watch};

use crate::agent::conversation::ConversationDb;
use crate::agent::conversation_persister::PromptOrigin;
use crate::agent::interaction::{AgentInteractionManager, AGENT_INTERACTION_EVENT};
use crate::agent::manager::{stop_task_cascade, AgentManager, AgentRole, AgentSpec};
use crate::agent::task::AgentMode;
use crate::agent::tools::ToolSide;
use crate::command_exec::executor::{ExecOutcome, ExecTransport};
use crate::command_exec::{CancelReason, CommandExecutionManager, CommandTicket};
use crate::config::settings::AppSettings;
use crate::data::{DataChangeBus, DataSourceId, JsonStore};
use crate::error::AppError;
use crate::llm::registry::{ChannelConfig, ModelEntry, ModelSlots};
use crate::ssh::auth::AuthMethod;
use crate::ssh::connection::{ConnectionConfig, SshManager};
use crate::ssh::known_hosts::{KnownHostEntry, KnownHostsStore};
use crate::AppState;

const MODEL_ID: &str = "eval-model";
const CHANNEL_ID: &str = "eval-channel";
const MAIN_TASK_ID: &str = "eval-main";
/// 靶机在评测配置里的「已保存连接」id。
const EVAL_CONNECTION_ID: &str = "eval-target";

// ═══════════════════════ 本机侧工具拦截 ═══════════════════════

/// 本进程是否处于评测沙箱。只有 [`run_job`] 会打开它；普通单测永远是关的。
static SANDBOX: AtomicBool = AtomicBool::new(false);

/// 作用侧是本机、但只是「从本机发起网络请求」的工具：不碰用户电脑上的文件与进程，
/// 评测里照常可用。
const NETWORK_ONLY_LOCAL_TOOLS: &[&str] = &["http_get", "web_search"];

/// 评测沙箱里，作用在用户本机（或在本机与远端之间搬运）的工具一律拦下。
///
/// 判据取自内置工具声明表的 `side`，新增本机工具自动被拦，不用记得来这里加名字。
/// 由 `ToolDispatcher::resolve_call` 在测试编译里调用。
pub(crate) fn host_side_block(tool: &str) -> Option<String> {
    if !SANDBOX.load(Ordering::Relaxed) {
        return None;
    }
    block_reason(tool)
}

/// 纯判定（不看开关），单测直接测它：全局开关在并行单测里切换会误伤别的测试。
fn block_reason(tool: &str) -> Option<String> {
    let side = crate::agent::tools::builtin_tool_side(tool)?;
    if matches!(side, ToolSide::Local | ToolSide::Both) && !NETWORK_ONLY_LOCAL_TOOLS.contains(&tool)
    {
        return Some(format!(
            "当前环境没有可用的用户本机：{tool} 作用在用户本机（或在本机与远端之间搬运文件），\
             在这里不可用。请只在当前 SSH 服务器上完成任务。"
        ));
    }
    None
}

/// 本机命令执行器的替身：任何命令都拒绝。纵深防御——正常情况下本机工具在
/// 派发前就被 [`host_side_block`] 拦了，根本走不到执行器。
struct DeniedLocalExec;

#[async_trait]
impl ExecTransport for DeniedLocalExec {
    async fn exec(
        &self,
        _ticket: &CommandTicket,
        _app: Option<&AppHandle>,
        _cancel: Option<&watch::Receiver<CancelReason>>,
    ) -> Result<ExecOutcome, AppError> {
        Err(AppError::Agent("评测环境不提供本机命令执行".into()))
    }
}

// ═══════════════════════ 输入 ═══════════════════════

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalJob {
    /// OpenAI 兼容端点（调度器的本地限流中转站，形如 `http://127.0.0.1:port/v1`）。
    model_base_url: String,
    /// 发给端点的 Bearer。指向中转站时它只是本次考试的标识，不是真实密钥——
    /// 真实密钥只在中转站里，不进 job 文件、不进成绩。
    model_token: String,
    /// 模型条目（`ModelEntry` 的字段子集：modelName / contextWindow / temperature /
    /// extraBody / reasoningEfforts / vision …），与 App 设置里的模型条目同形。
    model: Value,
    ssh: EvalSsh,
    prompt: String,
    #[serde(default = "default_mode")]
    mode: AgentMode,
    #[serde(default)]
    answers: Vec<AnswerRule>,
    #[serde(default)]
    default_answer: Option<String>,
    #[serde(default = "default_timeout")]
    timeout_secs: u64,
    /// 深合并到默认 `AppSettings` 上（JSON 形状与设置文件一致），用来测某项设置。
    #[serde(default)]
    settings_patch: Option<Value>,
    result_path: PathBuf,
    /// 本次考试的私有工作目录（SQLite、作业溢出文件）。调度器负责清理。
    work_dir: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvalSsh {
    /// 连接在列表里的名字（agent 经连接信息、记忆作用域能看到它）。
    #[serde(default = "default_connection_name")]
    name: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    /// 靶机主机密钥（`ssh-keygen -lf` 的算法与 `SHA256:…` 指纹）。预先登记进
    /// known_hosts，连接时照常校验——不是跳过校验。
    host_key_algorithm: String,
    host_key_fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AnswerRule {
    #[serde(rename = "match")]
    pattern: String,
    answer: String,
}

fn default_connection_name() -> String {
    "web-01".into()
}

fn default_mode() -> AgentMode {
    AgentMode::Agent
}

fn default_timeout() -> u64 {
    600
}

// ═══════════════════════ 输出 ═══════════════════════

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct EvalResult {
    /// completed / failed / timeout / cancelled / harness_error
    status: String,
    final_text: Option<String>,
    failure: Option<String>,
    harness_error: Option<String>,
    duration_ms: u128,
    usage: UsageTotals,
    /// 主 agent 的 assistant 回复条数（≈ 模型轮数）。
    main_rounds: usize,
    /// 全部会话（含子 agent）的 assistant 回复条数。
    total_rounds: usize,
    tool_calls: Vec<ToolCallRecord>,
    interactions: Vec<InteractionRecord>,
    subagents: usize,
    compactions: usize,
    /// 事件总线上各类流事件的计数（`agent://stream/*` 的 data.type）。
    event_counts: BTreeMap<String, usize>,
    transcript: Vec<TranscriptConversation>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageTotals {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
    reasoning_tokens: u64,
    cached_read_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallRecord {
    conversation_id: String,
    name: String,
    arguments: Value,
    /// 远端命令文本（命令类工具才有），调度器拿它做 forbidden 判定。
    command: Option<String>,
    success: Option<bool>,
    blocked: Option<bool>,
    disposition: Option<Value>,
    summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InteractionRecord {
    kind: String,
    task_id: String,
    tool_name: Option<String>,
    arguments: Option<Value>,
    questions: Option<Value>,
    answer: Option<String>,
    at_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptConversation {
    id: String,
    title: String,
    parent_id: Option<String>,
    messages: Vec<TranscriptMessage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptMessage {
    role: String,
    content: String,
    reasoning: Option<String>,
    tool_calls: Option<Value>,
    created_at: String,
}

// ═══════════════════════ 宿主状态 ═══════════════════════

fn merge_json(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            for (key, value) in patch {
                merge_json(base.entry(key.clone()).or_insert(Value::Null), value);
            }
        }
        (base, patch) => *base = patch.clone(),
    }
}

fn build_settings(job: &EvalJob) -> Result<AppSettings, String> {
    let mut settings = AppSettings::default();
    if let Some(patch) = &job.settings_patch {
        let mut value = serde_json::to_value(&settings).map_err(|e| e.to_string())?;
        merge_json(&mut value, patch);
        settings = serde_json::from_value(value).map_err(|e| format!("settingsPatch 无效：{e}"))?;
    }
    let mut model = job.model.clone();
    if !model.is_object() {
        return Err("model 必须是对象".into());
    }
    model["id"] = json!(MODEL_ID);
    model["channelId"] = json!(CHANNEL_ID);
    let model: ModelEntry =
        serde_json::from_value(model).map_err(|e| format!("model 条目无效：{e}"))?;
    if model.model_name.trim().is_empty() {
        return Err("model.modelName 不能为空".into());
    }
    let registry = &mut settings.llm_registry;
    registry.channels = vec![ChannelConfig {
        id: CHANNEL_ID.into(),
        name: "eval".into(),
        base_url: job.model_base_url.clone(),
        api_key: job.model_token.clone(),
        enabled: true,
    }];
    registry.models = vec![model];
    registry.slots = ModelSlots {
        default_model_id: MODEL_ID.into(),
        ..registry.slots.clone()
    };
    registry.last_used_model_id = MODEL_ID.into();
    // 没有真人，系统通知只会在跑评测的电脑上乱弹。
    settings.notification_settings.agent_approval = false;
    settings.notification_settings.agent_question = false;
    settings.notification_settings.agent_task_done = false;
    settings.notification_settings.agent_task_failed = false;
    settings.notification_settings.notification_volume = 0;
    Ok(settings)
}

/// 与 `AppState::new` 同构、但完全隔离的宿主状态：不读用户配置目录、不碰密钥链、
/// 不初始化全局图片/私钥目录。远端执行器是真的（经 SSH），本机执行器是拒绝替身。
async fn eval_state(dir: &Path, settings: AppSettings, known_hosts: Arc<KnownHostsStore>) -> AppState {
    let ssh_manager = SshManager::with_known_hosts(known_hosts.clone());
    let command_exec = CommandExecutionManager::new(
        ssh_manager.clone(),
        DataSourceId::JobsTemp.path(dir),
        DataSourceId::JobLedger.path(dir),
    )
    .await;
    let local_command_exec = CommandExecutionManager::with_transport_at_prefixed(
        Arc::new(DeniedLocalExec),
        DataSourceId::LocalCommand.path(dir),
        CommandExecutionManager::LOCAL_JOB_ID_PREFIX,
    );
    let connection_store = JsonStore::new(
        dir,
        crate::config::connections::ConnectionStore::new(),
        None,
    );
    let settings_store = JsonStore::new(dir, settings, None);
    let quick_command_store = JsonStore::new(
        dir,
        crate::config::quick_commands::QuickCommandStore::new(),
        None,
    );
    let skill_store = JsonStore::new(dir, crate::skills::store::SkillStore::new(), None);
    let mcp_store = JsonStore::new(dir, crate::mcp::store::McpServerStore::new(), None);
    let mcp_manager = Arc::new(crate::mcp::manager::McpManager::new());
    let data_changes = DataChangeBus::new();
    let conversation_db = Arc::new(
        ConversationDb::new(DataSourceId::Conversations.path(dir)).expect("eval SQLite"),
    );
    let sync = crate::sync::SyncManager::new(crate::sync::SyncWiring {
        config_dir: dir.to_path_buf(),
        stores: crate::sync::sources::SourceStores {
            settings: settings_store.clone(),
            connections: connection_store.clone(),
            quick_commands: quick_command_store.clone(),
            skills: skill_store.clone(),
            mcp_servers: mcp_store.clone(),
            known_hosts,
            mcp_manager: mcp_manager.clone(),
        },
        ssh_manager: ssh_manager.clone(),
        data_changes: data_changes.clone(),
        load_failures: Vec::new(),
        secret_catalog: None,
        conversation_db: conversation_db.clone(),
        memory_store: Arc::new(crate::memory::MemoryStore::in_memory()),
        running_conversations: Arc::new(|_| false),
    });
    AppState {
        ssh_manager,
        agent_tasks: Default::default(),
        plans: Default::default(),
        session_models: Default::default(),
        session_efforts: Default::default(),
        connection_store,
        settings: settings_store,
        quick_command_store,
        conversation_db,
        skill_store,
        mcp_store,
        data_changes,
        mcp_manager,
        config_dir: dir.to_path_buf(),
        agent_interaction: AgentInteractionManager::new(),
        task_cancel: Default::default(),
        upload_cancel: Default::default(),
        download_cancel: Default::default(),
        plugin_install_cancel: Default::default(),
        skill_import_cancel: Default::default(),
        compactions: Default::default(),
        command_exec,
        local_command_exec,
        sysopen_watchers: Default::default(),
        sysopen_active_paths: Default::default(),
        settings_warning: Arc::new(RwLock::new(None)),
        plugin_registry: crate::plugins::registry::new_shared(),
        multi_host_targets: Default::default(),
        agent_transfer_mutex: Default::default(),
        agent_transfer_by_task: Default::default(),
        memory: Arc::new(crate::memory::MemoryManager::with_store(
            crate::memory::MemoryStore::in_memory(),
        )),
        sync,
    }
}

// ═══════════════════════ 自动应答 ═══════════════════════

fn pick_answer(job_answers: &[AnswerRule], default: Option<&str>, question_text: &str) -> String {
    let lower = question_text.to_lowercase();
    job_answers
        .iter()
        .find(|rule| lower.contains(&rule.pattern.to_lowercase()))
        .map(|rule| rule.answer.clone())
        .or_else(|| default.map(str::to_string))
        .unwrap_or_else(|| "按你的判断来就行。".to_string())
}

/// 处理一条「交互激活」事件：审批放行、提问按预设回答。同一交互可能被重复激活
/// （队头重发），用 `seen` 去重。返回 Err = 不认识的交互类型（harness 缺口）。
fn respond(
    app: &AppHandle,
    state: &AppState,
    payload: &Value,
    answers: &[AnswerRule],
    default_answer: Option<&str>,
    started: Instant,
    seen: &mut HashSet<String>,
) -> Result<Option<InteractionRecord>, String> {
    let interaction_id = payload["interactionId"].as_str().unwrap_or_default().to_string();
    if !seen.insert(interaction_id.clone()) {
        return Ok(None);
    }
    let task_id = payload["taskId"].as_str().unwrap_or_default().to_string();
    let at_ms = started.elapsed().as_millis();
    match payload["kind"].as_str() {
        Some("approval") => {
            let approval = &payload["approval"];
            let tool_call_id = approval["toolCallId"].as_str().unwrap_or_default();
            state
                .agent_interaction
                .respond_approval(app, &task_id, tool_call_id, true, None);
            Ok(Some(InteractionRecord {
                kind: "approval".into(),
                task_id,
                tool_name: approval["toolName"].as_str().map(str::to_string),
                arguments: Some(approval["arguments"].clone()),
                questions: None,
                answer: None,
                at_ms,
            }))
        }
        Some("question") => {
            let question = &payload["question"];
            let question_id = question["questionId"].as_str().unwrap_or_default();
            let items = question["questions"].as_array().cloned().unwrap_or_default();
            let mut replies = Vec::new();
            let mut joined = Vec::new();
            for item in &items {
                let text = format!(
                    "{} {}",
                    item["header"].as_str().unwrap_or_default(),
                    item["question"].as_str().unwrap_or_default()
                );
                let reply = pick_answer(answers, default_answer, &text);
                joined.push(reply.clone());
                replies.push(json!({ "selected": [], "custom": reply }));
            }
            state
                .agent_interaction
                .respond_question(app, &task_id, question_id, replies);
            Ok(Some(InteractionRecord {
                kind: "question".into(),
                task_id,
                tool_name: None,
                arguments: None,
                questions: Some(Value::Array(items)),
                answer: Some(joined.join(" / ")),
                at_ms,
            }))
        }
        other => Err(format!(
            "评测入口不认识的交互类型 {:?}：新增的「等用户回应」交互需要在 eval_runner::respond 里补一条默认应答",
            other
        )),
    }
}

// ═══════════════════════ 结果收集 ═══════════════════════

fn collect(state: &AppState, main_conversation_id: &str, result: &mut EvalResult) {
    let db = &state.conversation_db;
    let ids = db.list_all_conversation_ids().unwrap_or_default();
    // 主会话排第一，子会话按创建顺序跟在后面。
    let mut conversations: Vec<_> = ids
        .iter()
        .filter_map(|id| db.get_conversation(id).ok().flatten())
        .collect();
    conversations.sort_by_key(|c| (c.id != main_conversation_id, c.created_at));
    for conversation in conversations {
        let usage = &conversation.usage;
        result.usage.prompt_tokens += usage.prompt_tokens;
        result.usage.completion_tokens += usage.completion_tokens;
        result.usage.total_tokens += usage.total_tokens;
        result.usage.reasoning_tokens += usage.reasoning_tokens.unwrap_or(0);
        result.usage.cached_read_tokens += usage.cached_read_tokens.unwrap_or(0);
        if conversation.parent_conversation_id.is_some() {
            result.subagents += 1;
        }
        let rows = db.load_messages(&conversation.id).unwrap_or_default();
        let mut messages = Vec::new();
        // 调用 id → 结果行里的执行事实（成功 / 被拦 / 档位 / 摘要）。
        let mut outcomes: HashMap<String, Value> = HashMap::new();
        for row in &rows {
            if row.role == "tool" {
                if let Some(meta) = row
                    .tool_calls_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<Value>(s).ok())
                {
                    if let Some(id) = meta["id"].as_str() {
                        outcomes.insert(id.to_string(), meta.clone());
                    }
                }
            }
        }
        for row in &rows {
            let tool_calls = row
                .tool_calls_json
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok());
            if row.role == "assistant" {
                if conversation.id == main_conversation_id {
                    result.main_rounds += 1;
                }
                result.total_rounds += 1;
                for call in tool_calls.as_ref().and_then(Value::as_array).into_iter().flatten() {
                    let name = call["name"].as_str().unwrap_or_default().to_string();
                    let outcome = call["id"].as_str().and_then(|id| outcomes.get(id));
                    result.tool_calls.push(ToolCallRecord {
                        conversation_id: conversation.id.clone(),
                        command: call["arguments"]["command"].as_str().map(str::to_string),
                        name,
                        arguments: call["arguments"].clone(),
                        success: outcome.and_then(|o| o["success"].as_bool()),
                        blocked: outcome.and_then(|o| o["blocked"].as_bool()),
                        disposition: outcome.map(|o| o["disposition"].clone()),
                        summary: outcome.and_then(|o| o["summary"].as_str().map(str::to_string)),
                    });
                }
            }
            if row.content.starts_with(crate::agent::conversation_persister::COMPACTION_CARD_PREFIX) {
                result.compactions += 1;
            }
            messages.push(TranscriptMessage {
                role: row.role.clone(),
                content: row.content.clone(),
                reasoning: row.reasoning_content.clone(),
                tool_calls,
                created_at: row.created_at.to_rfc3339(),
            });
        }
        result.transcript.push(TranscriptConversation {
            id: conversation.id.clone(),
            title: conversation.title.clone(),
            parent_id: conversation.parent_conversation_id.clone(),
            messages,
        });
    }
}

// ═══════════════════════ 主流程 ═══════════════════════

fn write_result(path: &Path, result: &EvalResult) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(result).expect("serialize eval result");
    std::fs::write(path, text).expect("write eval result");
}

/// 调度器通过 `MARCEL_EVAL_JOB` 指定 job 文件后调用；平时 `cargo test` 不跑它。
#[test]
#[ignore = "评测入口：由 evals/server.mjs 带 MARCEL_EVAL_JOB 调起"]
fn run_job() {
    let job_path = std::env::var("MARCEL_EVAL_JOB").expect("MARCEL_EVAL_JOB 未设置");
    let job: EvalJob = serde_json::from_str(
        &std::fs::read_to_string(&job_path).expect("读取 job 文件"),
    )
    .expect("解析 job 文件");
    let result_path = job.result_path.clone();
    let mut result = EvalResult::default();
    let settings = match build_settings(&job) {
        Ok(s) => s,
        Err(error) => {
            result.status = "harness_error".into();
            result.harness_error = Some(error);
            write_result(&result_path, &result);
            return;
        }
    };
    std::fs::create_dir_all(&job.work_dir).expect("work dir");
    SANDBOX.store(true, Ordering::Relaxed);

    let app = tauri::Builder::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("windowless Tauri host");
    assert!(app.webview_windows().is_empty());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();

    let started = Instant::now();
    runtime.block_on(async {
        let known_hosts = KnownHostsStore::in_memory();
        let now = chrono::Utc::now().to_rfc3339();
        known_hosts
            .record(
                &job.ssh.host,
                job.ssh.port,
                KnownHostEntry {
                    algorithm: job.ssh.host_key_algorithm.clone(),
                    fingerprint_sha256: job.ssh.host_key_fingerprint.clone(),
                    first_seen: now.clone(),
                    last_seen: now,
                },
            )
            .await
            .expect("登记靶机主机密钥");
        let state = eval_state(&job.work_dir, settings, known_hosts).await;
        app.manage(state.clone());

        // 靶机登记成「已保存的机器」再按 id 连：真实用户连的都是已保存连接，按机器记的
        // 长期记忆、连接信息等都靠这个 id。不登记的话 agent 会被当成临时连接，
        // `memory(scope=host)` 失败、白多一轮，测出来的不是生产行为。
        if let Err(error) = state
            .connection_store
            .mutate(|store| {
                store.add(crate::config::connections::SavedConnection {
                    id: EVAL_CONNECTION_ID.into(),
                    name: job.ssh.name.clone(),
                    host: job.ssh.host.clone(),
                    port: job.ssh.port,
                    username: job.ssh.username.clone(),
                    auth_method: "Password".into(),
                    key_path: None,
                    key_id: None,
                    group: None,
                    last_connected: None,
                    use_jump: false,
                    jump_host: None,
                    jump_port: None,
                    jump_username: None,
                    jump_auth_method: None,
                    jump_key_path: None,
                    jump_key_id: None,
                    remote_platform: None,
                });
                Ok(())
            })
            .await
        {
            result.status = "harness_error".into();
            result.harness_error = Some(format!("登记靶机连接失败：{error}"));
            return;
        }

        let session_id = match state
            .ssh_manager
            .connect(
                ConnectionConfig {
                    host: job.ssh.host.clone(),
                    port: job.ssh.port,
                    username: job.ssh.username.clone(),
                    auth_method: AuthMethod::Password {
                        password: job.ssh.password.clone(),
                    },
                    connection_id: Some(EVAL_CONNECTION_ID.into()),
                    trust_new_host_key: false,
                    jump: None,
                },
                app.handle().clone(),
            )
            .await
        {
            Ok(id) => id,
            Err(error) => {
                result.status = "harness_error".into();
                result.harness_error = Some(format!("SSH 连接靶机失败：{error}"));
                return;
            }
        };

        // 事件总线镜像：数流事件类型（同 scripted_tests 的订阅方式）。
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let captured = events.clone();
        crate::set_plugin_event_subscribers(1);
        let event_listener = app.listen("plugin://events", move |event| {
            if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
                captured.lock().push(value);
            }
        });

        // 交互事件进通道，由一个任务按序应答（listener 回调里不做阻塞操作）。
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        let interaction_listener = app.listen(AGENT_INTERACTION_EVENT, move |event| {
            if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
                let _ = tx.send(value);
            }
        });
        let interactions: Arc<Mutex<Vec<InteractionRecord>>> = Arc::default();
        let responder_error: Arc<Mutex<Option<String>>> = Arc::default();
        let responder = {
            let app = app.handle().clone();
            let state = state.clone();
            let answers = job.answers.clone();
            let default_answer = job.default_answer.clone();
            let interactions = interactions.clone();
            let responder_error = responder_error.clone();
            tokio::spawn(async move {
                let mut seen = HashSet::new();
                while let Some(payload) = rx.recv().await {
                    match respond(
                        &app,
                        &state,
                        &payload,
                        &answers,
                        default_answer.as_deref(),
                        started,
                        &mut seen,
                    ) {
                        Ok(Some(record)) => interactions.lock().push(record),
                        Ok(None) => {}
                        Err(error) => {
                            *responder_error.lock() = Some(error);
                            stop_task_cascade(&app, &state, MAIN_TASK_ID).await;
                        }
                    }
                }
            })
        };

        let conversation = state
            .conversation_db
            .create_conversation("eval-connection", "eval")
            .expect("create conversation");
        let manager = AgentManager::new(state.clone());
        let spec = AgentSpec {
            task_id: MAIN_TASK_ID.into(),
            mode: job.mode.clone(),
            role: AgentRole::Main,
            session_id: session_id.clone(),
            conversation_id: conversation.id.clone(),
            prompt: job.prompt.clone(),
            history: Vec::new(),
            model_override: Some(MODEL_ID.into()),
            prompt_extra: Vec::new(),
            prompt_origin: PromptOrigin::User,
            user_input: None,
            approval_mode: None,
        };
        match manager.spawn(app.handle(), spec).await {
            Ok(handle) => {
                let deadline = Duration::from_secs(job.timeout_secs.max(1));
                let joined = tokio::time::timeout(deadline, handle.join()).await;
                let timed_out = joined.is_err();
                if timed_out {
                    stop_task_cascade(app.handle(), &state, MAIN_TASK_ID).await;
                }
                let final_text = joined.ok().flatten();
                let task = state.agent_tasks.read().get(MAIN_TASK_ID).cloned();
                result.final_text = final_text;
                result.failure = task.as_ref().and_then(|t| t.failure.clone());
                result.status = if timed_out {
                    "timeout".into()
                } else {
                    match task.as_ref().map(|t| format!("{:?}", t.status).to_lowercase()) {
                        Some(s) => s,
                        None => "failed".into(),
                    }
                };
            }
            Err(error) => {
                result.status = "harness_error".into();
                result.harness_error = Some(format!("启动 agent 失败：{error}"));
            }
        }
        if let Some(error) = responder_error.lock().take() {
            result.status = "harness_error".into();
            result.harness_error = Some(error);
        }
        // 等落库收尾（finalize_task 是派生任务）稳定后再读。
        tokio::time::sleep(Duration::from_millis(300)).await;
        result.duration_ms = started.elapsed().as_millis();
        collect(&state, &conversation.id, &mut result);
        result.interactions = interactions.lock().clone();
        for event in events.lock().iter() {
            if event["event"]
                .as_str()
                .is_some_and(|name| name.starts_with("agent://stream/"))
            {
                if let Some(kind) = event["data"]["type"].as_str() {
                    *result.event_counts.entry(kind.to_string()).or_default() += 1;
                }
            }
        }

        app.unlisten(interaction_listener);
        app.unlisten(event_listener);
        responder.abort();
        let _ = state.ssh_manager.disconnect(&session_id).await;
    });
    // 拆卸顺序照 scripted_tests：runtime → unmanage → app。
    drop(runtime);
    #[allow(deprecated)]
    if let Some(managed) = app.unmanage::<AppState>() {
        drop(managed);
    }
    drop(app);
    SANDBOX.store(false, Ordering::Relaxed);
    if result.status.is_empty() {
        result.status = "harness_error".into();
    }
    write_result(&result_path, &result);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拦截判据跟着工具声明表走：每个作用在本机（或两端搬运）的内置工具，要么被
    /// 拦，要么在「只发网络请求」白名单里——新增本机工具不会悄悄漏进评测。
    #[test]
    fn every_host_side_tool_is_blocked_or_network_only() {
        for (name, side) in crate::agent::tools::builtin_tool_sides() {
            let blocked = block_reason(name).is_some();
            match side {
                ToolSide::Local | ToolSide::Both => assert!(
                    blocked || NETWORK_ONLY_LOCAL_TOOLS.contains(&name),
                    "{name} 作用在本机却没被评测沙箱拦下"
                ),
                ToolSide::Remote | ToolSide::App => {
                    assert!(!blocked, "{name} 不作用在本机，不该被拦")
                }
            }
        }
    }

    #[test]
    fn answers_match_case_insensitively_and_fall_back() {
        let rules = vec![AnswerRule {
            pattern: "API".into(),
            answer: "改 api 那个".into(),
        }];
        assert_eq!(pick_answer(&rules, None, "改哪个 api 服务？"), "改 api 那个");
        assert_eq!(pick_answer(&rules, Some("随意"), "装到哪个目录？"), "随意");
        assert_eq!(pick_answer(&rules, None, "装到哪？"), "按你的判断来就行。");
    }

    #[test]
    fn settings_patch_deep_merges() {
        let mut base = json!({"a": {"b": 1, "c": 2}, "d": 3});
        merge_json(&mut base, &json!({"a": {"b": 9}}));
        assert_eq!(base, json!({"a": {"b": 9, "c": 2}, "d": 3}));
    }
}
