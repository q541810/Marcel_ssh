//! 生产 Agent 回路的本机脚本验证。
//!
//! 真实的 AgentManager / LlmManager / SSE 解析 / dispatcher / SQLite 全部保留，
//! 只把模型 HTTP 对端与命令 transport 换成可检查请求的脚本。不启动 WebView、
//! 不连接 SSH、不读写真实配置或密钥链。一个测试只建一个无窗口的 Wry 宿主，
//! 避免桌面 event loop 在多个并发测试间争用全局状态。
//! 本模块由 Windows 测试配置挂载；历史投影本身的跨平台契约另有独立测试。
//! 运行：`cargo test --lib scripted_production_loop -- --nocapture`。

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Value};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::{mpsc, watch};

use crate::agent::conversation::{ConversationDb, HistorySnapshot};
use crate::agent::conversation_persister::PromptOrigin;
use crate::agent::interaction::{AgentInteractionManager, AGENT_INTERACTION_EVENT};
use crate::agent::manager::{stop_task_cascade, AgentManager, AgentRole, AgentSpec};
use crate::agent::task::{AgentMode, AgentStatus, AgentTask};
use crate::command_exec::executor::{ExecExit, ExecOutcome, ExecTransport};
use crate::command_exec::{CancelReason, CommandExecutionManager, CommandTicket};
use crate::config::settings::{AppSettings, NotificationSettings};
use crate::error::AppError;
use crate::llm::registry::{ChannelConfig, LlmRegistry, ModelEntry, NetPolicy};
use crate::ssh::connection::SshManager;
use crate::ssh::known_hosts::KnownHostsStore;
use crate::AppState;

const DEADLINE: Duration = Duration::from_secs(15);
const MODEL_ID: &str = "scripted-model-entry";
const MODEL_NAME: &str = "scripted-model";
const COMMAND: &str = "Write-Output harness-probe";
const OUTPUT: &str = "harness-probe\n";
const PROMPT: &str = "运行一次检查并报告结果";
const FINAL_TEXT: &str = "检查结果是 harness-probe。";
const RELOAD_PROMPT: &str = "复用上轮检查结果继续总结";
const RELOAD_TEXT: &str = "已复用上轮检查结果，没有再次执行命令。";
const REASONING: &str = "scripted reasoning retained with the tool call";

type RequestCheck = Box<dyn Fn(&Value) -> Result<(), String> + Send + Sync>;

struct ModelStep {
    label: &'static str,
    check: RequestCheck,
    frames: Vec<Value>,
    /// Some(status) = 不回帧，直接以该 HTTP 状态码拒绝请求（首包前的 Probing
    /// 阶段失败；是否重试由 NetPolicy 的 max_retries / retry_http_statuses 决定）。
    error_status: Option<u16>,
    /// 帧发完后让 SSE 流带错误终止（首包已到达的 Streaming 阶段断流）。
    /// 生产客户端对这一档**从不重试**（`LlmError::is_retryable`），本类场景
    /// 专门断言断流后的历史无残留。
    abort_stream: bool,
}

#[derive(Default)]
struct ModelScript {
    steps: VecDeque<ModelStep>,
    requests: Vec<Value>,
    errors: Vec<String>,
}

struct ScriptedModel {
    base_url: String,
    script: Arc<Mutex<ModelScript>>,
    server: tokio::task::JoinHandle<()>,
}

impl ScriptedModel {
    async fn start(steps: Vec<ModelStep>) -> Self {
        let script = Arc::new(Mutex::new(ModelScript {
            steps: steps.into(),
            ..Default::default()
        }));
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("bind scripted model on loopback");
        let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/v1/chat/completions", post(scripted_completion))
            .with_state(script.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("scripted model server");
        });
        Self {
            base_url,
            script,
            server,
        }
    }

    fn assert_no_errors(&self) {
        let script = self.script.lock();
        assert!(
            script.errors.is_empty(),
            "model request mismatch: {:?}",
            script.errors
        );
    }

    fn assert_consumed(&self) {
        self.assert_no_errors();
        let script = self.script.lock();
        assert!(
            script.steps.is_empty(),
            "{} scripted model responses were never requested",
            script.steps.len()
        );
    }

    /// 已收到的全部请求（供跨步比对「重试是否重发了同一段历史」）。
    fn requests(&self) -> Vec<Value> {
        self.script.lock().requests.clone()
    }
}

impl Drop for ScriptedModel {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn scripted_completion(
    State(script): State<Arc<Mutex<ModelScript>>>,
    Json(request): Json<Value>,
) -> Response {
    let (frames, error_status, abort_stream) = {
        let mut script = script.lock();
        script.requests.push(request.clone());
        let Some(step) = script.steps.pop_front() else {
            script.errors.push("unexpected extra model request".into());
            return (StatusCode::BAD_REQUEST, "unexpected extra model request").into_response();
        };
        if let Err(error) = (step.check)(&request) {
            let error = format!("{}: {}", step.label, error);
            script.errors.push(error.clone());
            return (StatusCode::BAD_REQUEST, error).into_response();
        }
        (step.frames, step.error_status, step.abort_stream)
    };
    if let Some(status) = error_status {
        // Probing 阶段失败：请求根本没进流，客户端按 NetPolicy 决定是否重试。
        return (
            StatusCode::from_u16(status).expect("valid scripted status"),
            "scripted probing failure",
        )
            .into_response();
    }
    // SSE 条目统一用 io::Error 作错误侧：正常结尾是 [DONE]，abort_stream 时
    // **延迟一拍**再以错误条目终止 —— hyper 立即 RST 会连客户端内核缓冲里
    // 已收到但未读取的帧一起冲掉，延迟保证客户端先消费到前面的帧。
    let items: Vec<Result<Event, std::io::Error>> = frames
        .into_iter()
        .map(|frame| Ok(Event::default().data(frame.to_string())))
        .collect();
    use futures::StreamExt as _;
    let tail: futures::stream::BoxStream<'static, Result<Event, std::io::Error>> = if abort_stream {
        Box::pin(futures::stream::once(async {
            tokio::time::sleep(Duration::from_millis(120)).await;
            Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "scripted mid-stream abort",
            ))
        }))
    } else {
        Box::pin(futures::stream::once(async {
            Ok(Event::default().data("[DONE]"))
        }))
    };
    let events = futures::stream::iter(items).chain(tail);
    Sse::new(events).into_response()
}

fn require(condition: bool, message: &str) -> Result<(), String> {
    condition.then_some(()).ok_or_else(|| message.to_string())
}

fn request_messages(request: &Value) -> Result<&Vec<Value>, String> {
    require(request["model"] == MODEL_NAME, "wrong model")?;
    require(request["stream"] == true, "streaming was disabled")?;
    let messages = request["messages"].as_array().ok_or("missing messages")?;
    require(
        messages.first().is_some_and(|m| m["role"] == "system"),
        "production system prompt is missing",
    )?;
    require(
        request["tools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|t| t["function"]["name"] == "local_bash")),
        "production local tool registry is missing",
    )?;
    Ok(messages)
}

fn text_frames(text: &str) -> Vec<Value> {
    vec![
        json!({"choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": null}]}),
        json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}),
    ]
}

fn tool_frames(call_id: &str, command: &str) -> Vec<Value> {
    let arguments = json!({"command": command, "description": "检查脚本回路"}).to_string();
    // 在 JSON 字符边界拆成两片，让真实 SSE 解析器负责重新组装工具参数。
    let split = arguments.find(",").expect("two arguments");
    vec![
        json!({"choices": [{"index": 0, "delta": {"role": "assistant", "reasoning_content": REASONING, "tool_calls": [{
            "index": 0, "id": call_id, "type": "function",
            "function": {"name": "local_bash", "arguments": &arguments[..split]}
        }]}, "finish_reason": null}]}),
        json!({"choices": [{"index": 0, "delta": {"tool_calls": [{
            "index": 0, "function": {"arguments": &arguments[split..]}
        }]}, "finish_reason": null}]}),
        json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}),
    ]
}

#[derive(Default)]
struct ScriptedExec {
    commands: Mutex<Vec<String>>,
    /// 命令 → 预置输出。未登记的命令一律拒绝 —— 沙盒的全部意义就是
    /// 「无论模型说什么，真实命令都不会跑」。
    canned: Mutex<HashMap<String, String>>,
}

impl ScriptedExec {
    fn with_output(self, command: &str, output: &str) -> Self {
        self.canned
            .lock()
            .insert(command.to_string(), output.to_string());
        self
    }
}

#[async_trait]
impl ExecTransport for ScriptedExec {
    async fn exec(
        &self,
        ticket: &CommandTicket,
        _app: Option<&AppHandle>,
        _cancel: Option<&watch::Receiver<CancelReason>>,
    ) -> Result<ExecOutcome, AppError> {
        self.commands.lock().push(ticket.command.clone());
        if ticket.session_id != "local" {
            return Err(AppError::Agent("unexpected scripted session".into()));
        }
        let output = self
            .canned
            .lock()
            .get(ticket.command.as_str())
            .cloned()
            .ok_or_else(|| AppError::Agent("unexpected scripted command".into()))?;
        Ok(ExecOutcome::Completed {
            output,
            exit: ExecExit {
                code: Some(0),
                signal: None,
            },
        })
    }
}

/// 构造完整但隔离的宿主状态。不走 AppState::new：它会初始化全局图片/私钥目录，
/// 而测试只需要当前临时 SQLite 和可替换的执行器，不能污染其他测试或真实设置。
fn isolated_state(dir: &Path, model_url: &str, exec: Arc<ScriptedExec>) -> AppState {
    isolated_state_with(
        dir,
        model_url,
        exec,
        NetPolicy {
            max_retries: 0,
            first_byte_timeout_secs: 5,
            ..Default::default()
        },
    )
}

/// 同上，但网络策略可定制（重试场景需要 max_retries ≥ 1）。
fn isolated_state_with(
    dir: &Path,
    model_url: &str,
    exec: Arc<ScriptedExec>,
    net_policy: NetPolicy,
) -> AppState {
    let settings = AppSettings {
        llm_registry: LlmRegistry {
            channels: vec![ChannelConfig {
                id: "scripted-channel".into(),
                name: "scripted channel".into(),
                base_url: model_url.into(),
                api_key: "scripted-test-token".into(),
                enabled: true,
            }],
            models: vec![ModelEntry {
                id: MODEL_ID.into(),
                channel_id: "scripted-channel".into(),
                model_name: MODEL_NAME.into(),
                ..Default::default()
            }],
            net_policy,
            ..Default::default()
        },
        notification_settings: NotificationSettings {
            agent_approval: false,
            agent_question: false,
            agent_task_done: false,
            agent_task_failed: false,
            notification_volume: 0,
        },
        ..Default::default()
    };
    // 两侧都使用 fake，即使目标侧接线出错也绝不会发起真实 SSH / 本机进程。
    let command_exec = CommandExecutionManager::with_transport_at(exec.clone(), dir.join("remote"));
    let local_command_exec = CommandExecutionManager::with_transport_at_prefixed(
        exec,
        dir.join("local"),
        CommandExecutionManager::LOCAL_JOB_ID_PREFIX,
    );
    AppState {
        ssh_manager: SshManager::with_known_hosts(KnownHostsStore::in_memory()),
        agent_tasks: Default::default(),
        plans: Default::default(),
        session_models: Default::default(),
        session_efforts: Default::default(),
        connection_store: Arc::new(tokio::sync::RwLock::new(
            crate::config::connections::ConnectionStore::new(),
        )),
        settings: Arc::new(tokio::sync::RwLock::new(settings)),
        quick_command_store: Arc::new(tokio::sync::RwLock::new(
            crate::config::quick_commands::QuickCommandStore::new(),
        )),
        conversation_db: Arc::new(
            ConversationDb::new(dir.join("conversations.db")).expect("temporary SQLite"),
        ),
        skill_store: Arc::new(tokio::sync::RwLock::new(
            crate::skills::store::SkillStore::new(),
        )),
        mcp_store: Arc::new(tokio::sync::RwLock::new(
            crate::mcp::store::McpServerStore::new(),
        )),
        mcp_manager: Arc::new(crate::mcp::manager::McpManager::new()),
        config_dir: dir.to_path_buf(),
        agent_interaction: AgentInteractionManager::new(),
        task_cancel: Default::default(),
        upload_cancel: Default::default(),
        download_cancel: Default::default(),
        plugin_install_cancel: Default::default(),
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
    }
}

fn local_spec(task_id: &str, conversation_id: &str, prompt: &str, mode: AgentMode) -> AgentSpec {
    AgentSpec {
        task_id: task_id.into(),
        mode,
        role: AgentRole::LocalSub {
            parent_task_id: "scripted-parent".into(),
        },
        session_id: "local".into(),
        conversation_id: conversation_id.into(),
        prompt: prompt.into(),
        history: Vec::new(),
        model_override: Some(MODEL_ID.into()),
        prompt_extra: Vec::new(),
        prompt_origin: PromptOrigin::User,
        user_input: None,
        approval_mode: None,
    }
}

#[test]
fn scripted_production_loop_roundtrip_reload_and_approval_cancel() {
    let scratch = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scratch");
    std::fs::create_dir_all(&scratch).expect("scratch directory");
    let dir = tempfile::Builder::new()
        .prefix("agent-scripted-")
        .tempdir_in(scratch)
        .expect("isolated scenario directory");
    let app = tauri::Builder::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("windowless Tauri host");
    assert!(
        app.webview_windows().is_empty(),
        "the scenario must never create a WebView"
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let model = ScriptedModel::start(vec![
            ModelStep {
                label: "initial user request",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .last()
                            .is_some_and(|m| m["role"] == "user" && m["content"] == PROMPT),
                        "missing user prompt",
                    )
                }),
                frames: tool_frames("scripted-call", COMMAND),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "tool result feedback",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages.iter().any(|m| {
                            m["role"] == "assistant" && m["tool_calls"][0]["id"] == "scripted-call"
                        }),
                        "assistant tool call was lost",
                    )?;
                    require(
                        messages.last().is_some_and(|m| {
                            m["role"] == "tool"
                                && m["tool_call_id"] == "scripted-call"
                                && m["content"] == OUTPUT
                        }),
                        "tool output did not reach the next model request",
                    )
                }),
                frames: text_frames(FINAL_TEXT),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "reloaded conversation request",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .iter()
                            .map(|m| m["role"].as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            == vec!["system", "user", "assistant", "tool", "assistant", "user"],
                        "reloaded history changed role order or duplicated a message",
                    )?;
                    require(
                        messages[1]["content"] == PROMPT,
                        "previous user prompt was lost",
                    )?;
                    require(
                        messages[2]["tool_calls"][0]["id"] == "scripted-call"
                            && messages[2]["reasoning_content"] == REASONING,
                        "reloaded assistant lost its tool call or reasoning",
                    )?;
                    require(
                        messages[3]["tool_call_id"] == "scripted-call"
                            && messages[3]["content"] == OUTPUT,
                        "reloaded tool result was lost or changed",
                    )?;
                    require(
                        messages[4]["content"] == FINAL_TEXT,
                        "previous final answer was lost",
                    )?;
                    require(
                        messages[5]["content"] == RELOAD_PROMPT,
                        "new prompt is not at the history tail",
                    )
                }),
                frames: text_frames(RELOAD_TEXT),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "approval cancellation request",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .last()
                            .is_some_and(|m| m["content"] == "在审批时停止"),
                        "missing cancellation scenario prompt",
                    )
                }),
                frames: tool_frames("cancelled-call", "Write-Output must-not-run"),
                error_status: None,
                abort_stream: false,
            },
        ])
        .await;
        let exec = Arc::new(ScriptedExec::default().with_output(COMMAND, OUTPUT));
        let state = isolated_state(dir.path(), &model.base_url, exec.clone());
        app.manage(state.clone());
        let parent = state
            .conversation_db
            .create_conversation("scripted-connection", "parent")
            .unwrap();
        state.agent_tasks.write().insert(
            "scripted-parent".into(),
            AgentTask {
                id: "scripted-parent".into(),
                session_id: "fixture-parent".into(),
                conversation_id: parent.id.clone(),
                prompt: "parent fixture".into(),
                mode: AgentMode::Agent,
                status: AgentStatus::Executing,
                has_plan: false,
                created_at: chrono::Utc::now(),
                parent_task_id: None,
                model_id: Some(MODEL_ID.into()),
                turn_anchor_id: None,
                parent_history_upto: None,
            },
        );
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let captured = events.clone();
        let event_listener = app.listen("plugin://events", move |event| {
            captured
                .lock()
                .push(serde_json::from_str(event.payload()).expect("event JSON"));
        });
        let manager = AgentManager::new(state.clone());
        let conversation = state
            .conversation_db
            .create_sub_conversation("scripted-connection", "roundtrip", &parent.id)
            .unwrap();
        let handle = manager
            .spawn(
                app.handle(),
                local_spec(
                    "scripted-roundtrip",
                    &conversation.id,
                    PROMPT,
                    AgentMode::Auto,
                ),
            )
            .await
            .unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("roundtrip completed within deadline");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(FINAL_TEXT));
        assert_eq!(*exec.commands.lock(), vec![COMMAND]);
        assert_eq!(
            state.agent_tasks.read()["scripted-roundtrip"].status,
            AgentStatus::Completed
        );
        let rows = state
            .conversation_db
            .load_messages(&conversation.id)
            .unwrap();
        assert_eq!(
            rows.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
            vec!["user", "assistant", "tool", "assistant"]
        );
        assert_eq!(rows[0].turn_state.as_deref(), Some("completed"));
        assert_eq!(rows[2].content, OUTPUT);
        assert!(events.lock().iter().any(|event| event["event"]
            == "agent://stream/scripted-roundtrip"
            && event["data"]["type"] == "done"));

        // 用新连接重新读取真实 SQLite；不借用内存里的 loop messages，也不在测试
        // 中重写一份转换逻辑。stored 引用按前端重载的同一契约交给生产 projector。
        let reopened = ConversationDb::new(dir.path().join("conversations.db")).unwrap();
        let reloaded_rows = reopened.load_messages(&conversation.id).unwrap();
        let snapshot: HistorySnapshot = serde_json::from_value(json!({
            "entries": reloaded_rows.iter().map(|row| json!({
                "kind": "stored", "id": row.id, "reasoningContent": row.reasoning_content,
            })).collect::<Vec<_>>()
        }))
        .unwrap();
        let mut spec = local_spec(
            "scripted-reload",
            &conversation.id,
            RELOAD_PROMPT,
            AgentMode::Auto,
        );
        spec.history = reopened
            .resolve_llm_history(&conversation.id, &snapshot)
            .unwrap();
        drop(reopened);
        let handle = manager.spawn(app.handle(), spec).await.unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("reloaded turn completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(RELOAD_TEXT));
        assert_eq!(
            *exec.commands.lock(),
            vec![COMMAND],
            "restoring history must not execute old calls again"
        );
        let rows = state
            .conversation_db
            .load_messages(&conversation.id)
            .unwrap();
        assert_eq!(
            rows.len(),
            6,
            "reload adds only the new user/assistant turn"
        );
        assert_eq!(rows[0].turn_state.as_deref(), Some("completed"));
        assert_eq!(rows[4].turn_state.as_deref(), Some("completed"));

        // 等队列确实接住审批后再停止：验证当前已支持的取消路径，不借这次迁移
        // 改写「模型审批尚未返回」这一独立的生命周期策略。
        let (approval_tx, mut approval_rx) = mpsc::unbounded_channel::<Value>();
        let approval_listener = app.listen(AGENT_INTERACTION_EVENT, move |event| {
            let _ = approval_tx.send(serde_json::from_str(event.payload()).expect("approval JSON"));
        });
        let cancelled = state
            .conversation_db
            .create_sub_conversation("scripted-connection", "cancel", &parent.id)
            .unwrap();
        let handle = manager
            .spawn(
                app.handle(),
                local_spec(
                    "scripted-cancel",
                    &cancelled.id,
                    "在审批时停止",
                    AgentMode::Agent,
                ),
            )
            .await
            .unwrap();
        let approval = tokio::time::timeout(DEADLINE, approval_rx.recv())
            .await
            .expect("approval arrived")
            .expect("approval channel");
        assert_eq!(approval["taskId"], "scripted-cancel");
        assert_eq!(approval["approval"]["toolCallId"], "cancelled-call");
        stop_task_cascade(app.handle(), &state, "scripted-cancel").await;
        assert!(tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("cancelled loop returned")
            .is_none());
        assert_eq!(
            *exec.commands.lock(),
            vec![COMMAND],
            "an unapproved command must never reach the transport"
        );
        assert_eq!(
            state.agent_tasks.read()["scripted-cancel"].status,
            AgentStatus::Cancelled
        );
        let rows = state.conversation_db.load_messages(&cancelled.id).unwrap();
        assert_eq!(rows[0].turn_state.as_deref(), Some("cancelled"));
        assert!(events
            .lock()
            .iter()
            .any(|event| event["event"] == "agent://stream/scripted-cancel"
                && event["data"]["type"] == "cancelled"));
        assert!(!events
            .lock()
            .iter()
            .any(|event| event["event"] == "agent://stream/scripted-cancel"
                && event["data"]["type"] == "done"));
        model.assert_consumed();
        app.unlisten(approval_listener);
        app.unlisten(event_listener);
    });
    // 三个 AgentTaskHandle 已 join、两个 listener 已 unlisten，block_on 内所有
    // AppState 借用/克隆已离开作用域；关闭 runtime 还会收掉 finalize_task 派生的
    // 清理任务和脚本模型 server，确保卸载时没有任何后台任务再借用托管状态。
    drop(runtime);
    // Tauri 2.10.3 的内置 PathResolver 持有 AppHandle，形成 managed state →
    // PathResolver → AppHandle → managed state 的强引用环。Exit/cleanup_before_exit
    // 不清 managed state，单纯 drop(app) 因而不能释放这里的 SQLite 文件句柄。
    // unmanage 的弃用原因是可能让既有 State 引用悬空；上面已结束全部借用和任务，
    // 且此后只销毁宿主、不再调用任何 Tauri API，因此仅在此测试卸载语句局部允许。
    #[allow(deprecated)]
    let managed_state = app
        .unmanage::<AppState>()
        .expect("unmanage isolated AppState");
    drop(managed_state);
    drop(app);
    dir.close().expect("remove the isolated scenario directory");
}

// ═══════════════════════ 后续场景的共享小基建 ═══════════════════════
//
// 拆卸顺序与上面既有测试完全一致，逐字保留（不许重排，见既有测试尾部注释）：
// join 全部 handle、注销 listener → drop(runtime) → unmanage → drop(app) →
// dir.close()。构造器只负责「建」，拆卸留在每个测试结尾逐行显式写出。

struct Scenario {
    dir: tempfile::TempDir,
    app: tauri::App<tauri::Wry>,
    runtime: tokio::runtime::Runtime,
}

fn build_scenario() -> Scenario {
    let scratch = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scratch");
    std::fs::create_dir_all(&scratch).expect("scratch directory");
    let dir = tempfile::Builder::new()
        .prefix("agent-scripted-")
        .tempdir_in(scratch)
        .expect("isolated scenario directory");
    let app = tauri::Builder::default()
        .any_thread()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("windowless Tauri host");
    assert!(
        app.webview_windows().is_empty(),
        "the scenario must never create a WebView"
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    Scenario { dir, app, runtime }
}

fn capture_events(app: &tauri::App<tauri::Wry>) -> (Arc<Mutex<Vec<Value>>>, tauri::EventId) {
    let events: Arc<Mutex<Vec<Value>>> = Arc::default();
    let captured = events.clone();
    let listener = app.listen("plugin://events", move |event| {
        captured
            .lock()
            .push(serde_json::from_str(event.payload()).expect("event JSON"));
    });
    (events, listener)
}

/// 与前端重载同一契约的快照：只冻结顺序、原始字段与落库引用（含旧行为里的
/// reasoning 显式覆盖），投影交给生产 `resolve_llm_history`。
fn snapshot_from_rows(rows: &[crate::agent::conversation::StoredMessage]) -> HistorySnapshot {
    serde_json::from_value(json!({
        "entries": rows.iter().map(|row| json!({
            "kind": "stored", "id": row.id, "reasoningContent": row.reasoning_content,
        })).collect::<Vec<_>>()
    }))
    .expect("history snapshot from stored rows")
}

/// 通用单工具调用帧（一次 delta 携带完整参数）。
fn tool_call_frames(call_id: &str, tool_name: &str, arguments: &Value) -> Vec<Value> {
    let arguments = arguments.to_string();
    vec![
        json!({"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [
            {"index": 0, "id": call_id, "type": "function",
             "function": {"name": tool_name, "arguments": arguments}}
        ]}, "finish_reason": null}]}),
        json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}),
    ]
}

/// 一轮两个工具调用（分片下标 0/1，真实解析器按 index 重组）。
fn two_tool_frames(id_a: &str, cmd_a: &str, id_b: &str, cmd_b: &str) -> Vec<Value> {
    let args_a = json!({"command": cmd_a, "description": "多工具批次 A"}).to_string();
    let args_b = json!({"command": cmd_b, "description": "多工具批次 B"}).to_string();
    vec![
        json!({"choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [
            {"index": 0, "id": id_a, "type": "function",
             "function": {"name": "local_bash", "arguments": args_a}},
            {"index": 1, "id": id_b, "type": "function",
             "function": {"name": "local_bash", "arguments": args_b}}
        ]}, "finish_reason": null}]}),
        json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}),
    ]
}

/// 摘要响应：先写一段 `<analysis>` 草稿（验证剥离），再写压缩指令要求的
/// 八段结构（缺一段都会被 `sanitize_summary` 拒绝）。
fn summary_frames() -> Vec<Value> {
    let mut text = String::from(
        "<analysis>\n- 草稿只进模型的思考，绝不能进卡片 SCRIPTED-ANALYSIS-ONLY\n</analysis>\n\n",
    );
    for section in [
        "## Primary Request and Intent",
        "## Key Technical Concepts",
        "## Files and Code",
        "## Errors and Fixes",
        "## Pending Jobs",
        "## Current Work",
        "## Next Step",
        "## Critical Context",
    ] {
        text.push_str(&format!("{section}\n- SCRIPTED-SUMMARY-MARKER\n\n"));
    }
    text_frames(&text)
}

/// 哑火响应：只有思考内容、无正文、无工具调用（`is_effectively_empty_response`
/// 判空后由 LlmManager 消费同一重试预算自动重试）。
fn reasoning_only_frames() -> Vec<Value> {
    vec![
        json!({"choices": [{"index": 0, "delta": {"role": "assistant", "reasoning_content": "silent scripted reasoning"}, "finish_reason": null}]}),
        json!({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}),
    ]
}

fn parent_task_fixture(task_id: &str, conversation_id: &str) -> AgentTask {
    AgentTask {
        id: task_id.into(),
        session_id: "fixture-parent".into(),
        conversation_id: conversation_id.into(),
        prompt: "parent fixture".into(),
        mode: AgentMode::Agent,
        status: AgentStatus::Executing,
        has_plan: false,
        created_at: chrono::Utc::now(),
        parent_task_id: None,
        model_id: Some(MODEL_ID.into()),
        turn_anchor_id: None,
        parent_history_upto: None,
    }
}

/// 断言流事件里出现过 `type`（按通道过滤）。
fn events_contain(events: &[Value], channel: &str, event_type: &str) -> bool {
    events
        .iter()
        .any(|event| event["event"] == channel && event["data"]["type"] == event_type)
}

// ═══════════════════════════ 场景 1：真实压缩链路 ═══════════════════════════
//
// 正常工具往返 → 手动压缩（真实 agent_compact_conversation 命令 + 真实摘要调用
// + 真实 persist_compaction 落库）→ 压缩后重开一轮。验收：
// 压缩卡只有一张且在队尾；归档边界（load_active_messages / 投影同一条规则）
// 一致；续跑请求里不出现归档原文；分析块不落库；压缩事件实时转发。

const COMPACT_FILLER: &str =
    "部署脚本会先检查端口占用，再写入配置文件，最后重启服务并等待健康检查通过。";
const FILLER_MARKER: &str = "SCRIPTED-FILLER-MARKER";
const SUMMARY_MARKER: &str = "SCRIPTED-SUMMARY-MARKER";
const ANALYSIS_MARKER: &str = "SCRIPTED-ANALYSIS-ONLY";
const CONTINUE_PROMPT: &str = "压缩后的上下文里现在有什么？直接回答。";
const CONTINUE_TEXT: &str = "上下文只剩检查点摘要与本轮新消息。";

fn compact_long_prompt() -> String {
    // ~5700 字符（chars/4 ≈ 1400 tokens）：远超 MIN_COMPACTABLE_TOKENS(512)，
    // 也让「摘要必须比原文短」的 shrink 校验稳过。
    format!(
        "【{FILLER_MARKER}】{}\n读完后执行检查并汇报。",
        COMPACT_FILLER.repeat(150)
    )
}

#[test]
fn scripted_production_loop_manual_compaction_roundtrip() {
    let Scenario { dir, app, runtime } = build_scenario();
    runtime.block_on(async {
        let long_prompt = compact_long_prompt();
        let model = ScriptedModel::start(vec![
            ModelStep {
                label: "compaction round initial request",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages.last().is_some_and(|m| {
                            m["role"] == "user" && m["content"].as_str().is_some_and(|c| {
                                c.contains(FILLER_MARKER) && c.contains("执行检查并汇报")
                            })
                        }),
                        "the long user prompt must reach the first request",
                    )
                }),
                frames: tool_frames("compact-call", COMMAND),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "compaction round feedback",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .iter()
                            .map(|m| m["role"].as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            == vec!["system", "user", "assistant", "tool"],
                        "first round history shape drifted",
                    )?;
                    require(
                        messages[3]["tool_call_id"] == "compact-call"
                            && messages[3]["content"] == OUTPUT,
                        "tool output did not reach the next model request",
                    )
                }),
                frames: text_frames(FINAL_TEXT),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "summarizer request",
                check: Box::new(|request| {
                    require(request["model"] == MODEL_NAME, "wrong model")?;
                    require(request["stream"] == true, "summary must stream")?;
                    let messages = request["messages"].as_array().ok_or("missing messages")?;
                    require(
                        messages.iter().all(|m| m["role"] != "system"),
                        "摘要请求不得携带会话 system 提示",
                    )?;
                    require(
                        messages.len() == 5,
                        &format!("被压区间 4 条 + 一条摘要指令，实际 {}", messages.len()),
                    )?;
                    require(
                        messages[0]["content"]
                            .as_str()
                            .is_some_and(|c| c.contains(FILLER_MARKER)),
                        "被压区间必须包含待归档原文",
                    )?;
                    require(
                        messages.last().is_some_and(|m| {
                            m["role"] == "user"
                                && m["content"]
                                    .as_str()
                                    .is_some_and(|c| c.starts_with("STOP"))
                        }),
                        "摘要指令必须作为最后一条 user 消息",
                    )?;
                    require(
                        request["tools"]
                            .as_array()
                            .is_some_and(|tools| !tools.is_empty()),
                        "摘要请求必须携带真实的工具 schema（压缩命令按 Main 角色镜像下一次常规请求的 tools 段）",
                    )
                }),
                frames: summary_frames(),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "post-compaction continuation",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .iter()
                            .map(|m| m["role"].as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            == vec!["system", "user", "user"],
                        "续跑请求 = system + 压缩卡（user 形态）+ 新指令",
                    )?;
                    let card_text = messages[1]["content"].as_str().unwrap_or_default();
                    require(
                        card_text.contains("automatically generated checkpoint")
                            && card_text.contains("<compacted-summary>")
                            && card_text.contains(SUMMARY_MARKER),
                        "压缩卡必须带 checkpoint 前言、framing 标签与摘要正文",
                    )?;
                    for leaked in [
                        FILLER_MARKER,
                        "执行检查并汇报",
                        PROMPT,
                        COMMAND,
                        OUTPUT,
                        FINAL_TEXT,
                    ] {
                        require(
                            !messages.iter().any(|m| {
                                m["content"].as_str().is_some_and(|c| c.contains(leaked))
                            }),
                            "归档原文泄漏进续跑请求：{leaked}",
                        )?;
                    }
                    require(
                        messages[2]["content"] == CONTINUE_PROMPT,
                        "new prompt is not at the history tail",
                    )
                }),
                frames: text_frames(CONTINUE_TEXT),
                error_status: None,
                abort_stream: false,
            },
        ])
        .await;
        let exec = Arc::new(ScriptedExec::default().with_output(COMMAND, OUTPUT));
        let state = isolated_state(dir.path(), &model.base_url, exec.clone());
        app.manage(state.clone());
        let parent = state
            .conversation_db
            .create_conversation("scripted-connection", "parent")
            .unwrap();
        state
            .agent_tasks
            .write()
            .insert("scripted-parent".into(), parent_task_fixture("scripted-parent", &parent.id));
        let (events, event_listener) = capture_events(&app);
        let manager = AgentManager::new(state.clone());
        let conversation = state
            .conversation_db
            .create_sub_conversation("scripted-connection", "compaction", &parent.id)
            .unwrap();

        // ── 回合 1：正常工具往返，产生可压缩的历史 ──
        let handle = manager
            .spawn(
                app.handle(),
                local_spec(
                    "scripted-compact-rt",
                    &conversation.id,
                    &long_prompt,
                    AgentMode::Auto,
                ),
            )
            .await
            .unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("roundtrip completed within deadline");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(FINAL_TEXT));
        assert_eq!(*exec.commands.lock(), vec![COMMAND]);
        let rows = state
            .conversation_db
            .load_messages(&conversation.id)
            .unwrap();
        assert_eq!(
            rows.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
            vec!["user", "assistant", "tool", "assistant"]
        );

        // ── 手动压缩：真实的命令入口 + 真实的摘要调用 + 真实的结构化落库 ──
        let compact = crate::commands::agent_compact::agent_compact_conversation(
            app.handle().clone(),
            app.state::<AppState>(),
            conversation.id.clone(),
            "scripted-compact-cmd".into(),
            snapshot_from_rows(&rows),
        )
        .await
        .expect("manual compaction command");
        model.assert_no_errors();
        assert!(compact.compacted);
        assert_eq!(compact.shadowed_messages, 4);
        assert!(
            compact
                .summary
                .as_deref()
                .is_some_and(|s| s.contains(SUMMARY_MARKER))
        );
        assert!(
            compact.tail_db_id.is_none(),
            "手动压缩 = 队尾语义：tail_db_id 恒为 None"
        );

        let rows = state
            .conversation_db
            .load_messages(&conversation.id)
            .unwrap();
        assert_eq!(rows.len(), 5, "原文全保留 + 一张卡");
        let cards: Vec<_> = rows.iter().filter(|m| m.role == "system").collect();
        assert_eq!(cards.len(), 1, "压缩卡必须只有一张");
        assert!(
            cards[0]
                .content
                .starts_with(crate::agent::conversation_persister::COMPACTION_CARD_PREFIX)
        );
        assert!(cards[0].content.contains(SUMMARY_MARKER));
        assert!(
            !cards[0].content.contains(ANALYSIS_MARKER),
            "分析块是模型的思考草稿，不得落库"
        );
        assert_eq!(
            cards[0].id, rows[4].id,
            "手动压缩的卡片就是最后一行（队尾语义）"
        );

        // 归档边界一致性：活跃段只剩卡片本身（load_active_messages 与
        // `read_history` 的 boundary_card 是同一条定位 SQL 的两份等价实现）。
        let active = state
            .conversation_db
            .load_active_messages(&conversation.id)
            .unwrap();
        assert_eq!(active.messages.len(), 1);
        assert_eq!(active.messages[0].id, cards[0].id);
        assert!(active.has_earlier);

        // ── 续跑：新快照经生产投影，归档原文不得出现 ──
        let reopened = ConversationDb::new(dir.path().join("conversations.db")).unwrap();
        let reloaded_rows = reopened.load_messages(&conversation.id).unwrap();
        let mut spec = local_spec(
            "scripted-compact-cont",
            &conversation.id,
            CONTINUE_PROMPT,
            AgentMode::Auto,
        );
        spec.history = reopened
            .resolve_llm_history(&conversation.id, &snapshot_from_rows(&reloaded_rows))
            .unwrap();
        drop(reopened);
        let handle = manager.spawn(app.handle(), spec).await.unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("continuation completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(CONTINUE_TEXT));
        assert_eq!(
            *exec.commands.lock(),
            vec![COMMAND],
            "续跑不得重跑压缩前的命令"
        );
        let rows = state
            .conversation_db
            .load_messages(&conversation.id)
            .unwrap();
        assert_eq!(rows.len(), 7, "卡片 + 新回合两行");
        assert_eq!(
            rows.iter().filter(|m| m.role == "system").count(),
            1,
            "续跑不得再压出第二张卡"
        );
        assert_eq!(rows[5].turn_state.as_deref(), Some("completed"));

        // 压缩事件实时转发到了命令的 stream 通道（前端据此显示进行中卡片）
        {
            let events = events.lock();
            assert!(events_contain(
                &events,
                "agent://stream/scripted-compact-cmd",
                "compactionStart"
            ));
            assert!(events_contain(
                &events,
                "agent://stream/scripted-compact-cmd",
                "compactionDone"
            ));
        }
        model.assert_consumed();
        app.unlisten(event_listener);
    });
    drop(runtime);
    #[allow(deprecated)]
    let managed_state = app
        .unmanage::<AppState>()
        .expect("unmanage isolated AppState");
    drop(managed_state);
    drop(app);
    dir.close().expect("remove the isolated scenario directory");
}

// ═══════════════════════════ 场景 2：流式失败与重试 ═══════════════════════════
//
// 三条互不相同的失败路径，验收全部落在「历史拼装不脏」上：
// a. Probing 阶段 HTTP 500 → LlmManager 按预算重试，重试请求与首发逐字节相同；
// b. Streaming 阶段断流（首包已到）→ 生产语义**从不重试**：任务失败、半截正文
//    已到达前端事件流但库里没有任何 assistant/tool 行；重开一轮的历史无重复
//    assistant、无孤儿 tool 结果；
// c. 哑火（只有思考无正文）→ 消费同一重试预算，重试请求同历史；哑火尝试的
//    思考内容不得落库。

const RETRY_PROMPT: &str = "先拒绝一次再重试的场景";
const RETRY_FINAL: &str = "重试后已正常完成。";
const DISCONNECT_PROMPT: &str = "在断流场景中回答";
const DISCONNECT_PARTIAL: &str = "断流前的半截文本";
const RECOVERY_PROMPT: &str = "断流后重开一轮总结";
const RECOVERY_TEXT: &str = "断流后已重开并正常回答。";
const SILENCE_PROMPT: &str = "先哑火再重试的场景";
const SILENCE_FINAL: &str = "哑火重试后给出正文。";

fn retry_net_policy() -> NetPolicy {
    NetPolicy {
        max_retries: 1,
        retry_delay_secs: 0.01,
        retry_http_statuses: "500-599".into(),
        first_byte_timeout_secs: 5,
        ..Default::default()
    }
}

#[test]
fn scripted_production_loop_stream_failures_keep_history_clean() {
    let Scenario { dir, app, runtime } = build_scenario();
    runtime.block_on(async {
        let model = ScriptedModel::start(vec![
            // ── a. Probing 阶段 500 → 重试 ──
            ModelStep {
                label: "probing failure (HTTP 500)",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .last()
                            .is_some_and(|m| m["role"] == "user" && m["content"] == RETRY_PROMPT),
                        "missing retry scenario prompt",
                    )
                }),
                frames: vec![],
                error_status: Some(500),
                abort_stream: false,
            },
            ModelStep {
                label: "probing retry succeeds",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .last()
                            .is_some_and(|m| m["role"] == "user" && m["content"] == RETRY_PROMPT),
                        "retry request lost the prompt",
                    )
                }),
                frames: tool_frames("retry-call", COMMAND),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "retry round feedback",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages.last().is_some_and(|m| {
                            m["role"] == "tool"
                                && m["tool_call_id"] == "retry-call"
                                && m["content"] == OUTPUT
                        }),
                        "tool output missing after retried tool call",
                    )
                }),
                frames: text_frames(RETRY_FINAL),
                error_status: None,
                abort_stream: false,
            },
            // ── b. Streaming 阶段断流（从不重试）──
            ModelStep {
                label: "partial stream then abort",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages.last().is_some_and(|m| m["content"] == DISCONNECT_PROMPT),
                        "missing disconnect scenario prompt",
                    )
                }),
                frames: vec![
                    json!({"choices": [{"index": 0, "delta": {"role": "assistant", "content": DISCONNECT_PARTIAL}, "finish_reason": null}]}),
                    json!({"choices": [{"index": 0, "delta": {}, "finish_reason": null}]}),
                ],
                error_status: None,
                abort_stream: true,
            },
            ModelStep {
                label: "reload after disconnect",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .iter()
                            .map(|m| m["role"].as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            == vec!["system", "user", "user"],
                        "重载后的历史不得出现重复 assistant 行或孤儿 tool 结果",
                    )?;
                    require(
                        messages[1]["content"] == DISCONNECT_PROMPT
                            && messages[2]["content"] == RECOVERY_PROMPT,
                        "断流前后的两条用户消息必须原样保留",
                    )
                }),
                frames: text_frames(RECOVERY_TEXT),
                error_status: None,
                abort_stream: false,
            },
            // ── c. 哑火（仅思考无正文）→ 重试 ──
            ModelStep {
                label: "silent attempt",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .last()
                            .is_some_and(|m| m["role"] == "user" && m["content"] == SILENCE_PROMPT),
                        "missing silence scenario prompt",
                    )
                }),
                frames: reasoning_only_frames(),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "silence retry succeeds",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .last()
                            .is_some_and(|m| m["role"] == "user" && m["content"] == SILENCE_PROMPT),
                        "silence retry lost the prompt",
                    )
                }),
                frames: text_frames(SILENCE_FINAL),
                error_status: None,
                abort_stream: false,
            },
        ])
        .await;
        let exec = Arc::new(ScriptedExec::default().with_output(COMMAND, OUTPUT));
        let state = isolated_state_with(
            dir.path(),
            &model.base_url,
            exec.clone(),
            retry_net_policy(),
        );
        app.manage(state.clone());
        let parent = state
            .conversation_db
            .create_conversation("scripted-connection", "parent")
            .unwrap();
        state
            .agent_tasks
            .write()
            .insert("scripted-parent".into(), parent_task_fixture("scripted-parent", &parent.id));
        let (events, event_listener) = capture_events(&app);
        let manager = AgentManager::new(state.clone());

        // ── a. Probing 500 → 重试原样重发同一段历史 ──
        let conv_retry = state
            .conversation_db
            .create_sub_conversation("scripted-connection", "retry-probing", &parent.id)
            .unwrap();
        let first_idx = model.requests().len();
        let handle = manager
            .spawn(
                app.handle(),
                local_spec("scripted-retry", &conv_retry.id, RETRY_PROMPT, AgentMode::Auto),
            )
            .await
            .unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("retry round completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(RETRY_FINAL));
        assert_eq!(*exec.commands.lock(), vec![COMMAND]);
        let requests = model.requests();
        assert_eq!(
            requests[first_idx]["messages"], requests[first_idx + 1]["messages"],
            "重试必须原样重发同一段历史（不得重复 assistant、不得夹带半截内容）"
        );
        {
            let events = events.lock();
            let retrying: Vec<&Value> = events
                .iter()
                .filter(|e| {
                    e["event"] == "agent://stream/scripted-retry"
                        && e["data"]["type"] == "retrying"
                })
                .collect();
            assert_eq!(retrying.len(), 1, "Probing 500 恰好触发一次重试事件");
            assert_eq!(retrying[0]["data"]["attempt"], 1);
            assert_eq!(retrying[0]["data"]["maxAttempts"], 2);
        }
        let rows = state.conversation_db.load_messages(&conv_retry.id).unwrap();
        assert_eq!(
            rows.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
            vec!["user", "assistant", "tool", "assistant"],
            "重试成功后库里只有一条 assistant 工具组，没有重复行"
        );
        assert_eq!(rows[0].turn_state.as_deref(), Some("completed"));

        // ── b. 断流：任务失败、无持久化残留、重开历史干净 ──
        let conv_abort = state
            .conversation_db
            .create_sub_conversation("scripted-connection", "disconnect", &parent.id)
            .unwrap();
        let handle = manager
            .spawn(
                app.handle(),
                local_spec(
                    "scripted-disconnect",
                    &conv_abort.id,
                    DISCONNECT_PROMPT,
                    AgentMode::Auto,
                ),
            )
            .await
            .unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("failed loop must still return");
        assert_eq!(result, None, "Streaming 阶段的失败不产出最终文本");
        assert_eq!(
            state.agent_tasks.read()["scripted-disconnect"].status,
            AgentStatus::Failed
        );
        {
            let rows = state.conversation_db.load_messages(&conv_abort.id).unwrap();
            assert_eq!(
                rows.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
                vec!["user"],
                "断流后库里只有用户锚点行：半截 assistant 与孤儿 tool 结果一律不落库"
            );
            assert_eq!(rows[0].content, DISCONNECT_PROMPT);
            assert_eq!(
                rows[0].turn_state.as_deref(),
                Some("failed"),
                "锚点行必须留下「未正常收尾」的持久证据"
            );
        }
        {
            let events = events.lock();
            let stream_events: Vec<&Value> = events
                .iter()
                .filter(|e| e["event"] == "agent://stream/scripted-disconnect")
                .collect();
            assert!(
                stream_events.iter().any(|e| {
                    e["data"]["type"] == "textDelta" && e["data"]["text"] == DISCONNECT_PARTIAL
                }),
                "断流前的半截正文已经实时到达前端事件流"
            );
            assert!(
                stream_events.iter().any(|e| e["data"]["type"] == "error"),
                "断流必须以 error 事件收场"
            );
            assert!(
                !stream_events.iter().any(|e| e["data"]["type"] == "retrying"),
                "Streaming 阶段的错误从不重试"
            );
            assert!(!events_contain(
                &events,
                "agent://stream/scripted-disconnect",
                "done"
            ));
        }
        // 重开一轮：库里的历史 = [user]，投影后无重复 assistant、无孤儿 tool
        let reopened = ConversationDb::new(dir.path().join("conversations.db")).unwrap();
        let reloaded_rows = reopened.load_messages(&conv_abort.id).unwrap();
        let mut spec = local_spec(
            "scripted-recover",
            &conv_abort.id,
            RECOVERY_PROMPT,
            AgentMode::Auto,
        );
        spec.history = reopened
            .resolve_llm_history(&conv_abort.id, &snapshot_from_rows(&reloaded_rows))
            .unwrap();
        drop(reopened);
        let handle = manager.spawn(app.handle(), spec).await.unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("recovery round completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(RECOVERY_TEXT));
        let rows = state.conversation_db.load_messages(&conv_abort.id).unwrap();
        assert_eq!(
            rows.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
            vec!["user", "user", "assistant"]
        );
        assert_eq!(rows[0].turn_state.as_deref(), Some("failed"));
        assert_eq!(rows[1].turn_state.as_deref(), Some("completed"));

        // ── c. 哑火：思考不算正文，自动重试且思考不落库 ──
        let conv_silence = state
            .conversation_db
            .create_sub_conversation("scripted-connection", "silence", &parent.id)
            .unwrap();
        let silence_idx = model.requests().len();
        let handle = manager
            .spawn(
                app.handle(),
                local_spec(
                    "scripted-silence",
                    &conv_silence.id,
                    SILENCE_PROMPT,
                    AgentMode::Auto,
                ),
            )
            .await
            .unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("silence round completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(SILENCE_FINAL));
        let requests = model.requests();
        assert_eq!(
            requests[silence_idx]["messages"], requests[silence_idx + 1]["messages"],
            "哑火重试必须重发同一段历史"
        );
        assert!(events_contain(
            &events.lock(),
            "agent://stream/scripted-silence",
            "retrying"
        ));
        let rows = state.conversation_db.load_messages(&conv_silence.id).unwrap();
        assert_eq!(
            rows.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
            vec!["user", "assistant"],
            "哑火尝试的思考内容不得落库"
        );
        assert_eq!(rows[1].content, SILENCE_FINAL);

        model.assert_consumed();
        app.unlisten(event_listener);
    });
    drop(runtime);
    #[allow(deprecated)]
    let managed_state = app
        .unmanage::<AppState>()
        .expect("unmanage isolated AppState");
    drop(managed_state);
    drop(app);
    dir.close().expect("remove the isolated scenario directory");
}

// ═══════════════════════════ 场景 3：持久化失败降级 ═══════════════════════════
//
// 写失败注入 = messages 表上的 INSERT 触发器 RAISE(ABORT)（立即失败，不依赖
// busy 等待）。验收：
// a. 回合照常跑完：任务 Completed、事件流完整（toolResult / done）、
//    库里零新增行、旧历史连回合状态原样保留（不清空、不写半截行）；
// b. 读失败（另一连接 BEGIN EXCLUSIVE）：真实压缩命令以结构化
//    AppError::Agent（「读取会话历史失败」前缀）返回，库不动、不落卡；
// c. 解除注入后可恢复：照常落库、行序与回合状态正确。

const PERSIST_PROMPT: &str = "持久化降级场景的一轮";
const PERSIST_FINAL: &str = "写库失败时任务仍然完成。";
const RECOVER_PROMPT: &str = "恢复后继续补一轮";
const RECOVER_FINAL: &str = "锁释放后写入恢复。";

#[test]
fn scripted_production_loop_persistence_failure_degrades_safely() {
    let Scenario { dir, app, runtime } = build_scenario();
    runtime.block_on(async {
        let model = ScriptedModel::start(vec![
            ModelStep {
                label: "baseline initial",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .last()
                            .is_some_and(|m| m["role"] == "user" && m["content"] == PROMPT),
                        "missing baseline prompt",
                    )
                }),
                frames: tool_frames("persist-call", COMMAND),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "baseline feedback",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages.last().is_some_and(|m| {
                            m["role"] == "tool"
                                && m["tool_call_id"] == "persist-call"
                                && m["content"] == OUTPUT
                        }),
                        "baseline tool result missing",
                    )
                }),
                frames: text_frames(FINAL_TEXT),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "degraded turn initial",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .iter()
                            .map(|m| m["role"].as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            == vec!["system", "user", "assistant", "tool", "assistant", "user"],
                        "降级回合的历史 = 回合 1 全量 + 新指令",
                    )?;
                    require(
                        messages.last().is_some_and(|m| m["content"] == PERSIST_PROMPT),
                        "missing degraded prompt",
                    )
                }),
                frames: tool_frames("degraded-call", COMMAND),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "degraded turn feedback",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages.last().is_some_and(|m| {
                            m["role"] == "tool"
                                && m["tool_call_id"] == "degraded-call"
                                && m["content"] == OUTPUT
                        }),
                        "degraded tool result missing",
                    )
                }),
                frames: text_frames(PERSIST_FINAL),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "recovery turn initial",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .iter()
                            .map(|m| m["role"].as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            == vec!["system", "user", "assistant", "tool", "assistant", "user"],
                        "恢复回合的历史必须只含已落库的回合 1 + 新指令（降级回合未写入的内容不得 phantom 复现）",
                    )?;
                    require(
                        messages.last().is_some_and(|m| m["content"] == RECOVER_PROMPT),
                        "missing recovery prompt",
                    )
                }),
                frames: tool_frames("recover-call", COMMAND),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "recovery turn feedback",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages.last().is_some_and(|m| {
                            m["role"] == "tool"
                                && m["tool_call_id"] == "recover-call"
                                && m["content"] == OUTPUT
                        }),
                        "recovery tool result missing",
                    )
                }),
                frames: text_frames(RECOVER_FINAL),
                error_status: None,
                abort_stream: false,
            },
        ])
        .await;
        let exec = Arc::new(ScriptedExec::default().with_output(COMMAND, OUTPUT));
        let state = isolated_state(dir.path(), &model.base_url, exec.clone());
        app.manage(state.clone());
        let parent = state
            .conversation_db
            .create_conversation("scripted-connection", "parent")
            .unwrap();
        state
            .agent_tasks
            .write()
            .insert("scripted-parent".into(), parent_task_fixture("scripted-parent", &parent.id));
        let (events, event_listener) = capture_events(&app);
        let manager = AgentManager::new(state.clone());
        let conversation = state
            .conversation_db
            .create_sub_conversation("scripted-connection", "persistence", &parent.id)
            .unwrap();

        // ── 基线：正常回合，产生 4 行历史 ──
        let handle = manager
            .spawn(
                app.handle(),
                local_spec(
                    "scripted-persist-base",
                    &conversation.id,
                    PROMPT,
                    AgentMode::Auto,
                ),
            )
            .await
            .unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("baseline round completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(FINAL_TEXT));
        let rows = state
            .conversation_db
            .load_messages(&conversation.id)
            .unwrap();
        assert_eq!(rows.len(), 4);

        // ── 注入写失败：messages 表的 INSERT 一律 RAISE(ABORT)（读路径不受影响）──
        let injector = rusqlite::Connection::open(dir.path().join("conversations.db")).unwrap();
        injector
            .execute_batch(
                "CREATE TRIGGER scripted_fail_message_insert BEFORE INSERT ON messages
                 BEGIN SELECT RAISE(ABORT, 'injected message write failure'); END;",
            )
            .unwrap();

        // ── a. 降级回合：照常跑完，库里零新增 ──
        let mut spec = local_spec(
            "scripted-persist-degraded",
            &conversation.id,
            PERSIST_PROMPT,
            AgentMode::Auto,
        );
        spec.history = state
            .conversation_db
            .resolve_llm_history(&conversation.id, &snapshot_from_rows(&rows))
            .unwrap();
        let handle = manager.spawn(app.handle(), spec).await.unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("degraded round completed");
        model.assert_no_errors();
        assert_eq!(
            result.as_deref(),
            Some(PERSIST_FINAL),
            "消息写入失败不阻断任务"
        );
        assert_eq!(
            state.agent_tasks.read()["scripted-persist-degraded"].status,
            AgentStatus::Completed
        );
        assert!(events_contain(
            &events.lock(),
            "agent://stream/scripted-persist-degraded",
            "toolResult"
        ));
        assert!(events_contain(
            &events.lock(),
            "agent://stream/scripted-persist-degraded",
            "done"
        ));
        let rows_after = state
            .conversation_db
            .load_messages(&conversation.id)
            .unwrap();
        assert_eq!(
            rows_after.len(),
            4,
            "降级回合不得在库里留下任何新行或半截行"
        );
        assert_eq!(
            rows_after.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(),
            rows.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(),
            "旧历史原样保留"
        );
        assert_eq!(
            rows_after[0].turn_state.as_deref(),
            Some("completed"),
            "回合 2 没有锚点，不得动回合 1 的收尾状态"
        );
        let resolved_after = state
            .conversation_db
            .resolve_llm_history(&conversation.id, &snapshot_from_rows(&rows_after))
            .unwrap();
        assert_eq!(
            resolved_after.len(),
            4,
            "写失败后的重投影仍是完整旧历史（历史不丢）"
        );

        injector
            .execute_batch("DROP TRIGGER scripted_fail_message_insert;")
            .unwrap();
        drop(injector);

        // ── b. 读失败：压缩命令以结构化 AppError 返回，库不动 ──
        // 快照先取（锁内连读都会 BUSY），锁只罩住命令执行本身。
        let snapshot = snapshot_from_rows(
            &state.conversation_db.load_messages(&conversation.id).unwrap(),
        );
        let lock = rusqlite::Connection::open(dir.path().join("conversations.db")).unwrap();
        lock.execute_batch("BEGIN EXCLUSIVE;").unwrap();
        let compact_error = crate::commands::agent_compact::agent_compact_conversation(
            app.handle().clone(),
            app.state::<AppState>(),
            conversation.id.clone(),
            "scripted-compact-fail".into(),
            snapshot,
        )
        .await;
        drop(lock);
        let Err(compact_error) = compact_error else {
            panic!("expected the compaction command to fail while the DB is locked");
        };
        match compact_error {
            AppError::Agent(message) => assert!(
                message.starts_with("读取会话历史失败"),
                "结构化错误必须说明是读取历史失败：{message}"
            ),
            other => panic!("expected structured AppError::Agent, got: {other:?}"),
        }
        let rows_locked = state
            .conversation_db
            .load_messages(&conversation.id)
            .unwrap();
        assert_eq!(rows_locked.len(), 4, "失败的压缩不得动库");
        assert!(
            !rows_locked.iter().any(|m| m.role == "system"),
            "不得落下任何压缩卡"
        );

        // ── c. 解除后可恢复 ──
        let mut spec = local_spec(
            "scripted-persist-recover",
            &conversation.id,
            RECOVER_PROMPT,
            AgentMode::Auto,
        );
        spec.history = state
            .conversation_db
            .resolve_llm_history(&conversation.id, &snapshot_from_rows(&rows_locked))
            .unwrap();
        let handle = manager.spawn(app.handle(), spec).await.unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("recovery round completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(RECOVER_FINAL));
        let rows = state
            .conversation_db
            .load_messages(&conversation.id)
            .unwrap();
        assert_eq!(
            rows.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
            vec![
                "user", "assistant", "tool", "assistant", "user", "assistant", "tool", "assistant"
            ],
            "恢复回合照常跑完整工具组（降级回合留下的缺口不 phantom 复现）"
        );
        assert_eq!(rows[4].content, RECOVER_PROMPT);
        assert_eq!(rows[7].content, RECOVER_FINAL);
        assert_eq!(rows[4].turn_state.as_deref(), Some("completed"));

        model.assert_consumed();
        app.unlisten(event_listener);
    });
    drop(runtime);
    #[allow(deprecated)]
    let managed_state = app
        .unmanage::<AppState>()
        .expect("unmanage isolated AppState");
    drop(managed_state);
    drop(app);
    dir.close().expect("remove the isolated scenario directory");
}

// ═══════════════════════════ 场景 4：审批的其它既有路径 ═══════════════════════════
//
// Agent 模式（逐条人审）。两条路径：
// a. 批准 → 命令真实到达 transport、结果回灌、回合完成；
// b. 一轮两个调用：批准第一个、**带理由**拒绝第二个 —— 被拒的命令不得到达
//    transport，拒绝理由原文转达给模型；两个调用保留在同一条 assistant 行上。
// （「模型审批尚未返回时的取消」是已知独立竞态，修它会改行为，仍不在本场景。）

const COMMAND_A: &str = "Write-Output approved-path";
const OUTPUT_A: &str = "approved-path\n";
const COMMAND_B: &str = "Write-Output denied-path";
const APPROVAL_PROMPT: &str = "审批通过后继续执行的场景";
const APPROVAL_FINAL: &str = "审批后已执行并汇总。";
const MIXED_PROMPT: &str = "一轮里两个调用：一个批一个拒";
const MIXED_FINAL: &str = "混合审批轮已完成。";
const REJECT_REASON: &str = "第二条现在不要跑";

#[test]
fn scripted_production_loop_approval_paths() {
    let Scenario { dir, app, runtime } = build_scenario();
    runtime.block_on(async {
        let model = ScriptedModel::start(vec![
            ModelStep {
                label: "approve initial",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages.last().is_some_and(|m| {
                            m["role"] == "user" && m["content"] == APPROVAL_PROMPT
                        }),
                        "missing approval scenario prompt",
                    )
                }),
                frames: tool_frames("approved-call", COMMAND_A),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "approve feedback",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages.last().is_some_and(|m| {
                            m["role"] == "tool"
                                && m["tool_call_id"] == "approved-call"
                                && m["content"] == OUTPUT_A
                        }),
                        "approved command output must reach the model",
                    )
                }),
                frames: text_frames(APPROVAL_FINAL),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "mixed initial",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .last()
                            .is_some_and(|m| m["role"] == "user" && m["content"] == MIXED_PROMPT),
                        "missing mixed scenario prompt",
                    )
                }),
                frames: two_tool_frames("mixed-a", COMMAND_A, "mixed-b", COMMAND_B),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "mixed feedback",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .iter()
                            .map(|m| m["role"].as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            == vec!["system", "user", "assistant", "tool", "tool"],
                        "一轮两个调用 = 一条 assistant + 两条 tool",
                    )?;
                    let calls = messages[2]["tool_calls"]
                        .as_array()
                        .ok_or("missing calls")?;
                    require(
                        calls.len() == 2
                            && calls[0]["id"] == "mixed-a"
                            && calls[1]["id"] == "mixed-b",
                        "两个调用必须保留在同一条 assistant 上且顺序不变",
                    )?;
                    require(
                        messages[3]["tool_call_id"] == "mixed-a"
                            && messages[3]["content"] == OUTPUT_A,
                        "approved result missing",
                    )?;
                    let rejection = messages[4]["content"].as_str().unwrap_or_default();
                    require(
                        messages[4]["tool_call_id"] == "mixed-b"
                            && rejection.contains("用户拒绝了这次调用")
                            && rejection.contains(REJECT_REASON),
                        "拒绝理由必须原样转达给模型",
                    )
                }),
                frames: text_frames(MIXED_FINAL),
                error_status: None,
                abort_stream: false,
            },
        ])
        .await;
        let exec = Arc::new(
            ScriptedExec::default()
                .with_output(COMMAND_A, OUTPUT_A)
                .with_output(COMMAND, OUTPUT),
        );
        let state = isolated_state(dir.path(), &model.base_url, exec.clone());
        app.manage(state.clone());
        let parent = state
            .conversation_db
            .create_conversation("scripted-connection", "parent")
            .unwrap();
        state.agent_tasks.write().insert(
            "scripted-parent".into(),
            parent_task_fixture("scripted-parent", &parent.id),
        );
        let (events, event_listener) = capture_events(&app);
        let (interaction_tx, mut interaction_rx) = mpsc::unbounded_channel::<Value>();
        let interaction_listener = app.listen(AGENT_INTERACTION_EVENT, move |event| {
            let _ = interaction_tx
                .send(serde_json::from_str(event.payload()).expect("interaction JSON"));
        });
        let manager = AgentManager::new(state.clone());

        // ── a. 批准 → 继续执行 ──
        let conv_approve = state
            .conversation_db
            .create_sub_conversation("scripted-connection", "approve", &parent.id)
            .unwrap();
        let handle = manager
            .spawn(
                app.handle(),
                local_spec(
                    "scripted-approve",
                    &conv_approve.id,
                    APPROVAL_PROMPT,
                    AgentMode::Agent,
                ),
            )
            .await
            .unwrap();
        let approval = tokio::time::timeout(DEADLINE, interaction_rx.recv())
            .await
            .expect("approval arrived")
            .expect("approval channel");
        assert_eq!(approval["taskId"], "scripted-approve");
        assert_eq!(approval["kind"], "approval");
        assert_eq!(approval["approval"]["toolCallId"], "approved-call");
        assert_eq!(approval["approval"]["toolName"], "local_bash");
        assert_eq!(approval["approval"]["arguments"]["command"], COMMAND_A);
        crate::commands::agent_lifecycle::agent_approve_operation(
            app.handle().clone(),
            app.state::<AppState>(),
            "scripted-approve".into(),
            "approved-call".into(),
        )
        .await
        .unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("approved round completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(APPROVAL_FINAL));
        assert_eq!(*exec.commands.lock(), vec![COMMAND_A]);
        let rows = state
            .conversation_db
            .load_messages(&conv_approve.id)
            .unwrap();
        assert_eq!(
            rows.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
            vec!["user", "assistant", "tool", "assistant"]
        );
        assert_eq!(rows[2].content, OUTPUT_A);
        assert_eq!(rows[0].turn_state.as_deref(), Some("completed"));

        // ── b. 一轮两调用：批一个、带理由拒一个 ──
        let conv_mixed = state
            .conversation_db
            .create_sub_conversation("scripted-connection", "mixed", &parent.id)
            .unwrap();
        let handle = manager
            .spawn(
                app.handle(),
                local_spec(
                    "scripted-mixed",
                    &conv_mixed.id,
                    MIXED_PROMPT,
                    AgentMode::Agent,
                ),
            )
            .await
            .unwrap();
        let first = tokio::time::timeout(DEADLINE, interaction_rx.recv())
            .await
            .expect("first approval arrived")
            .expect("first approval channel");
        assert_eq!(first["approval"]["toolCallId"], "mixed-a");
        crate::commands::agent_lifecycle::agent_approve_operation(
            app.handle().clone(),
            app.state::<AppState>(),
            "scripted-mixed".into(),
            "mixed-a".into(),
        )
        .await
        .unwrap();
        let second = tokio::time::timeout(DEADLINE, interaction_rx.recv())
            .await
            .expect("second approval arrived")
            .expect("second approval channel");
        assert_eq!(second["approval"]["toolCallId"], "mixed-b");
        crate::commands::agent_lifecycle::agent_reject_operation(
            app.handle().clone(),
            app.state::<AppState>(),
            "scripted-mixed".into(),
            "mixed-b".into(),
            Some(REJECT_REASON.into()),
        )
        .await
        .unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("mixed round completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(MIXED_FINAL));
        let commands = exec.commands.lock();
        assert_eq!(
            commands.iter().filter(|c| **c == COMMAND_A).count(),
            2,
            "两次批准的调用都真实执行"
        );
        assert!(
            !commands.iter().any(|c| c == COMMAND_B),
            "被拒的命令绝不到达 transport"
        );
        drop(commands);
        let rows = state.conversation_db.load_messages(&conv_mixed.id).unwrap();
        assert_eq!(
            rows.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
            vec!["user", "assistant", "tool", "tool", "assistant"]
        );
        let calls: Vec<Value> = serde_json::from_str(rows[1].tool_calls_json.as_deref().unwrap())
            .expect("assistant tool calls json");
        assert_eq!(
            calls
                .iter()
                .map(|c| c["id"].as_str().unwrap_or_default())
                .collect::<Vec<_>>(),
            vec!["mixed-a", "mixed-b"],
            "并行调用保留在同一条 assistant 行（跨 task 重建历史靠它）"
        );
        let result_a: Value =
            serde_json::from_str(rows[2].tool_calls_json.as_deref().unwrap()).unwrap();
        assert_eq!(result_a["success"], true);
        assert_eq!(result_a["blocked"], false);
        let result_b: Value =
            serde_json::from_str(rows[3].tool_calls_json.as_deref().unwrap()).unwrap();
        assert_eq!(result_b["success"], false);
        assert_eq!(result_b["blocked"], true);
        assert!(rows[3].content.contains(REJECT_REASON));
        assert_eq!(rows[0].turn_state.as_deref(), Some("completed"));
        // 两条路径都要以自然结束收场（前端按 done 事件落「已完成」）
        assert!(events_contain(
            &events.lock(),
            "agent://stream/scripted-approve",
            "done"
        ));
        assert!(events_contain(
            &events.lock(),
            "agent://stream/scripted-mixed",
            "done"
        ));

        model.assert_consumed();
        app.unlisten(interaction_listener);
        app.unlisten(event_listener);
    });
    drop(runtime);
    #[allow(deprecated)]
    let managed_state = app
        .unmanage::<AppState>()
        .expect("unmanage isolated AppState");
    drop(managed_state);
    drop(app);
    dir.close().expect("remove the isolated scenario directory");
}

// ═══════════════════════════ 场景 5：多工具批次 ═══════════════════════════
//
// 一轮多个 tool call（Auto，无人审）。验收：结果按原始调用顺序回灌；
// 库里两个调用保留在同一条 assistant 行上；重载后投影重建的工具组
// 顺序不变、在下一个 user 之前闭合（无孤儿 tool 结果）。

const SEQ_CMD_A: &str = "Write-Output batch-first";
const SEQ_OUT_A: &str = "batch-first\n";
const SEQ_CMD_B: &str = "Write-Output batch-second";
const SEQ_OUT_B: &str = "batch-second\n";
const BATCH_PROMPT: &str = "一轮里跑两个顺序命令";
const BATCH_FINAL: &str = "两个结果都已收到。";
const BATCH_RELOAD_PROMPT: &str = "按批次结果继续总结";
const BATCH_RELOAD_TEXT: &str = "已按批次顺序复核。";

#[test]
fn scripted_production_loop_multi_tool_round_and_reload_closure() {
    let Scenario { dir, app, runtime } = build_scenario();
    runtime.block_on(async {
        let model = ScriptedModel::start(vec![
            ModelStep {
                label: "batch initial",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .last()
                            .is_some_and(|m| m["role"] == "user" && m["content"] == BATCH_PROMPT),
                        "missing batch scenario prompt",
                    )
                }),
                frames: two_tool_frames("batch-a", SEQ_CMD_A, "batch-b", SEQ_CMD_B),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "batch feedback",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .iter()
                            .map(|m| m["role"].as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            == vec!["system", "user", "assistant", "tool", "tool"],
                        "两个工具结果必须按序回灌",
                    )?;
                    require(
                        messages[3]["tool_call_id"] == "batch-a"
                            && messages[3]["content"] == SEQ_OUT_A,
                        "first result missing or out of order",
                    )?;
                    require(
                        messages[4]["tool_call_id"] == "batch-b"
                            && messages[4]["content"] == SEQ_OUT_B,
                        "second result missing or out of order",
                    )
                }),
                frames: text_frames(BATCH_FINAL),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "batch reload",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .iter()
                            .map(|m| m["role"].as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            == vec![
                                "system",
                                "user",
                                "assistant",
                                "tool",
                                "tool",
                                "assistant",
                                "user",
                            ],
                        "重载后的历史必须在新 user 之前闭合工具组",
                    )?;
                    let calls = messages[2]["tool_calls"]
                        .as_array()
                        .ok_or("missing calls")?;
                    require(
                        calls.len() == 2
                            && calls[0]["id"] == "batch-a"
                            && calls[1]["id"] == "batch-b",
                        "投影必须把两个调用重建在同一条 assistant 上且保序",
                    )?;
                    require(
                        messages[3]["tool_call_id"] == "batch-a"
                            && messages[3]["content"] == SEQ_OUT_A,
                        "reloaded first result drifted",
                    )?;
                    require(
                        messages[4]["tool_call_id"] == "batch-b"
                            && messages[4]["content"] == SEQ_OUT_B,
                        "reloaded second result drifted",
                    )?;
                    require(
                        messages[5]["content"] == BATCH_FINAL,
                        "previous final answer was lost",
                    )?;
                    require(
                        messages[6]["content"] == BATCH_RELOAD_PROMPT,
                        "new prompt is not at the history tail",
                    )
                }),
                frames: text_frames(BATCH_RELOAD_TEXT),
                error_status: None,
                abort_stream: false,
            },
        ])
        .await;
        let exec = Arc::new(
            ScriptedExec::default()
                .with_output(SEQ_CMD_A, SEQ_OUT_A)
                .with_output(SEQ_CMD_B, SEQ_OUT_B),
        );
        let state = isolated_state(dir.path(), &model.base_url, exec.clone());
        app.manage(state.clone());
        let parent = state
            .conversation_db
            .create_conversation("scripted-connection", "parent")
            .unwrap();
        state.agent_tasks.write().insert(
            "scripted-parent".into(),
            parent_task_fixture("scripted-parent", &parent.id),
        );
        let (events, event_listener) = capture_events(&app);
        let manager = AgentManager::new(state.clone());
        let conversation = state
            .conversation_db
            .create_sub_conversation("scripted-connection", "batch", &parent.id)
            .unwrap();

        let handle = manager
            .spawn(
                app.handle(),
                local_spec(
                    "scripted-batch",
                    &conversation.id,
                    BATCH_PROMPT,
                    AgentMode::Auto,
                ),
            )
            .await
            .unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("batch round completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(BATCH_FINAL));
        assert_eq!(
            *exec.commands.lock(),
            vec![SEQ_CMD_A, SEQ_CMD_B],
            "顺序执行且按调用顺序到达 transport"
        );
        let rows = state
            .conversation_db
            .load_messages(&conversation.id)
            .unwrap();
        assert_eq!(
            rows.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
            vec!["user", "assistant", "tool", "tool", "assistant"]
        );
        let calls: Vec<Value> = serde_json::from_str(rows[1].tool_calls_json.as_deref().unwrap())
            .expect("assistant tool calls json");
        assert_eq!(
            calls
                .iter()
                .map(|c| c["id"].as_str().unwrap_or_default())
                .collect::<Vec<_>>(),
            vec!["batch-a", "batch-b"]
        );
        assert_eq!(rows[0].turn_state.as_deref(), Some("completed"));

        // 重载：投影重建的工具组必须闭合且保序
        let reopened = ConversationDb::new(dir.path().join("conversations.db")).unwrap();
        let reloaded_rows = reopened.load_messages(&conversation.id).unwrap();
        let mut spec = local_spec(
            "scripted-batch-reload",
            &conversation.id,
            BATCH_RELOAD_PROMPT,
            AgentMode::Auto,
        );
        spec.history = reopened
            .resolve_llm_history(&conversation.id, &snapshot_from_rows(&reloaded_rows))
            .unwrap();
        drop(reopened);
        let handle = manager.spawn(app.handle(), spec).await.unwrap();
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("batch reload completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(BATCH_RELOAD_TEXT));
        assert_eq!(
            *exec.commands.lock(),
            vec![SEQ_CMD_A, SEQ_CMD_B],
            "重载不得重放旧调用"
        );
        let rows = state
            .conversation_db
            .load_messages(&conversation.id)
            .unwrap();
        assert_eq!(rows.len(), 7);
        assert!(events_contain(
            &events.lock(),
            "agent://stream/scripted-batch",
            "done"
        ));

        model.assert_consumed();
        app.unlisten(event_listener);
    });
    drop(runtime);
    #[allow(deprecated)]
    let managed_state = app
        .unmanage::<AppState>()
        .expect("unmanage isolated AppState");
    drop(managed_state);
    drop(app);
    dir.close().expect("remove the isolated scenario directory");
}

// ═══════════════════════════ 场景 6：子代理回读窗口 ═══════════════════════════
//
// spawn 冻结 `parent_history_upto`（派发那一刻父会话最后一条已落库消息）→
// **冻结之后**父会话压缩 → 子代理经真实 dispatcher 调 `read_history(scope=parent)`。
// 验收：窗口下界在读取时现取（最新卡），归档原文不漏进子代理；窗口内恰好
// 是「卡片 + 卡后活跃消息」，上界仍是冻结的那条。（压缩链路本身由场景 1
// 覆盖，这里直接 `commit_compaction` 造出归档边界。）

const ARCHIVED_USER: &str = "父会话早期指令 SCRIPTED-ARCHIVED-USER-MARKER";
const ARCHIVED_TOOL: &str = "早期命令输出 SCRIPTED-ARCHIVED-TOOL-MARKER";
const ACTIVE_USER: &str = "父会话后续指令 SCRIPTED-ACTIVE-USER-MARKER";
const ACTIVE_ASSISTANT: &str = "父会话的结论 SCRIPTED-ACTIVE-ASSISTANT-MARKER";
const CARD_TOPIC: &str = "早期检查与部署的背景 SCRIPTED-CARD-TOPIC";
const SUB_PROMPT: &str = "读主 agent 派发你时的上下文并复述最近的用户指令与结论";
const SUB_FINAL: &str = "已按窗口读取父会话上下文。";

#[test]
fn scripted_production_loop_subagent_parent_window_excludes_archived() {
    let Scenario { dir, app, runtime } = build_scenario();
    runtime.block_on(async {
        // 先用独立连接种子父会话：模型脚本（read_history 的锚点参数）依赖
        // 冻结行的 id。state 里的 ConversationDb 打开同一个文件，行照常可见。
        let seed_db = ConversationDb::new(dir.path().join("conversations.db")).unwrap();
        let parent_conv = seed_db
            .create_conversation("scripted-connection", "subagent-parent")
            .unwrap();

        // 种子父会话 5 行。created_at 由 save_message 取 Utc::now()，紧凑循环里
        // 可能同值，而归档边界按 (created_at, rowid) 定位 —— 逐行 sleep 保证单调。
        let seed = |db: &ConversationDb,
                    role: &str,
                    content: &str,
                    tool_calls_json: Option<String>|
         -> crate::agent::conversation::StoredMessage {
            std::thread::sleep(Duration::from_millis(3));
            db.save_message(
                &parent_conv.id,
                role,
                content,
                "2026-01-01T00:00:00Z",
                tool_calls_json.as_deref(),
                None,
            )
            .expect("seed parent row")
        };
        let _m1 = seed(&seed_db, "user", ARCHIVED_USER, None);
        let _m2 = seed(
            &seed_db,
            "assistant",
            "执行早期检查",
            Some(r#"[{"id":"seed-call","name":"local_bash","arguments":{}}]"#.into()),
        );
        let m3 = seed(
            &seed_db,
            "tool",
            ARCHIVED_TOOL,
            Some(
                r#"{"id":"seed-call","name":"local_bash","summary":"早期检查","success":true,"blocked":false}"#
                    .into(),
            ),
        );
        let _m4 = seed(&seed_db, "user", ACTIVE_USER, None);
        let m5 = seed(&seed_db, "assistant", ACTIVE_ASSISTANT, None);
        drop(seed_db);

        let model = ScriptedModel::start(vec![
            ModelStep {
                label: "subagent reads parent context",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .last()
                            .is_some_and(|m| m["role"] == "user" && m["content"] == SUB_PROMPT),
                        "missing subagent prompt",
                    )?;
                    require(
                        request["tools"].as_array().is_some_and(|tools| {
                            tools.iter().any(|t| t["function"]["name"] == "read_history")
                        }),
                        "子代理必须拿到 read_history（状态门控对子代理恒开）",
                    )
                }),
                frames: tool_call_frames(
                    "sub-read",
                    "read_history",
                    &json!({
                        "action": "read",
                        "scope": "parent",
                        "anchor_id": m5.id.clone(),
                        "before": 10,
                        "after": 0
                    }),
                ),
                error_status: None,
                abort_stream: false,
            },
            ModelStep {
                label: "subagent concludes from the window",
                check: Box::new(|request| {
                    let messages = request_messages(request)?;
                    require(
                        messages
                            .iter()
                            .map(|m| m["role"].as_str().unwrap_or_default())
                            .collect::<Vec<_>>()
                            == vec!["system", "user", "assistant", "tool"],
                        "子代理回合的请求形态漂移",
                    )?;
                    let read_output = messages[3]["content"].as_str().unwrap_or_default();
                    require(
                        read_output.contains("主 agent 的上下文")
                            && read_output.contains("历史原文 3 条"),
                        "窗口内必须恰好是卡片 + 卡后两条活跃消息：{read_output}",
                    )?;
                    for expected in [CARD_TOPIC, ACTIVE_USER, ACTIVE_ASSISTANT] {
                        require(
                            read_output.contains(expected),
                            "窗口内缺少活跃内容：{expected}",
                        )?;
                    }
                    for leaked in [ARCHIVED_USER, ARCHIVED_TOOL, "执行早期检查"] {
                        require(
                            !read_output.contains(leaked),
                            "归档原文漏进子代理回读：{leaked}",
                        )?;
                    }
                    Ok(())
                }),
                frames: text_frames(SUB_FINAL),
                error_status: None,
                abort_stream: false,
            },
        ])
        .await;
        let exec = Arc::new(ScriptedExec::default());
        let state = isolated_state(dir.path(), &model.base_url, exec.clone());
        app.manage(state.clone());
        // 父任务记录：spawn 冻结上界靠它找到父会话
        state
            .agent_tasks
            .write()
            .insert("scripted-parent".into(), parent_task_fixture("scripted-parent", &parent_conv.id));
        let manager = AgentManager::new(state.clone());
        let (events, event_listener) = capture_events(&app);

        // ── 派发：上界在此刻冻结 ──
        let child_conv = state
            .conversation_db
            .create_sub_conversation("scripted-connection", "subagent-window", &parent_conv.id)
            .unwrap();
        let handle = manager
            .spawn(
                app.handle(),
                local_spec(
                    "scripted-sub-window",
                    &child_conv.id,
                    SUB_PROMPT,
                    AgentMode::Auto,
                ),
            )
            .await
            .unwrap();
        assert_eq!(
            state.agent_tasks.read()["scripted-sub-window"]
                .parent_history_upto
                .as_deref(),
            Some(m5.id.as_str()),
            "上界必须冻结在派发那一刻父会话最后一条已落库消息"
        );

        // ── 冻结之后父会话压缩：m1..m3 归档，卡片贴在 m3 之后 ──
        state
            .conversation_db
            .commit_compaction(
                &parent_conv.id,
                &[],
                &format!(
                    "{}已整理 3 条历史消息（约 100 tokens）\n\n{}",
                    crate::agent::conversation_persister::COMPACTION_CARD_PREFIX,
                    CARD_TOPIC
                ),
                &m3.created_at.to_rfc3339(),
                &m3.timestamp,
            )
            .expect("seed parent compaction card");
        let parent_rows = state
            .conversation_db
            .load_messages(&parent_conv.id)
            .unwrap();
        assert_eq!(parent_rows.len(), 6, "5 行原文 + 1 张卡");
        assert_eq!(
            parent_rows[3].role, "system",
            "卡片必须落在 m3（归档段末行）之后、活跃段之前"
        );

        // ── 子代理跑完：真实 dispatcher 执行 read_history，结果回灌 ──
        let result = tokio::time::timeout(DEADLINE, handle.join())
            .await
            .expect("subagent round completed");
        model.assert_no_errors();
        assert_eq!(result.as_deref(), Some(SUB_FINAL));
        assert!(
            exec.commands.lock().is_empty(),
            "本场景不执行任何命令"
        );
        let child_rows = state.conversation_db.load_messages(&child_conv.id).unwrap();
        assert_eq!(
            child_rows.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(),
            vec!["user", "assistant", "tool", "assistant"]
        );
        assert!(events_contain(
            &events.lock(),
            "agent://stream/scripted-sub-window",
            "done"
        ));

        model.assert_consumed();
        app.unlisten(event_listener);
    });
    drop(runtime);
    #[allow(deprecated)]
    let managed_state = app
        .unmanage::<AppState>()
        .expect("unmanage isolated AppState");
    drop(managed_state);
    drop(app);
    dir.close().expect("remove the isolated scenario directory");
}
