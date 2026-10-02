//! 无头 agent 任务：外部 MCP client 委派的复杂 SSH 任务。
//!
//! ## 与内置 agent 的区别（每一条都是刻意的）
//!
//! - **不持久化**：任务不进 SQLite、不进对话列表。外部调用的语义是一次性的活，
//!   落库只会往用户界面里塞一堆他不知道从哪来的会话。
//! - **不审批**：与 [`super::external_executor`] 的 SSH 执行同一信任模型——
//!   把调用方接进来的是用户自己，命令安全由调用方自负。内置 agent 要过风险
//!   评估，是因为它的模型可能被远端内容诱导；这条链路上没有那个前提。
//! - **无头**：不发 UI 事件、不要 `AppHandle`。会话、事件、审批弹窗全是 GUI 侧
//!   的东西，这里一件都不需要。
//!
//! ## 为什么不复用 `agent::agent_loop`
//!
//! 那条循环是为「带审批、带事件、带持久化、带上下文压缩、带子代理」的 GUI
//! agent 写的。要让它在无头场景可用，得把上面这些逐个变成可选——**其中包括
//! 审批那段安全关键代码**。为了省一个几百行的循环去动核心 agent 的审批语义，
//! 代价远大于收益。
//!
//! 无头任务的真实需求只是「LLM 调工具、跑几轮、把活干完」，所以这里自己写一条
//! 紧凑的循环，把确定性（步数上限、超时）捏在手里，核心 agent 一行不动。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex as TokioMutex;

use crate::config::persist::JsonPersistable;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::llm::manager::LlmManager;
use crate::llm::provider::{LlmMessage, LlmRole, ToolDefinition};
use crate::mcp_server::external_executor::ExternalExecutor;
use crate::mcp_server::protocol::{McpError, ToolCallResult};
use crate::mcp_server::tools::{self, ToolRegistry};

/// LLM 交互的最小抽象。
///
/// 存在的唯一理由是**可测**：循环的三种收尾（干完了 / 撞步数上限 / 出错）
/// 都取决于模型回什么，而真实 `LlmManager` 要联网、要 API Key。把它抽成
/// 一个方法宽的 trait，测试就能用脚本化的假模型离线验证循环逻辑本身
/// （终止条件、步数上限、工具失败留痕），不必去碰网络。
#[async_trait]
pub(crate) trait TaskLlm: Send + Sync {
    async fn complete(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
    ) -> Result<LlmMessage, AppError>;
}

#[async_trait]
impl TaskLlm for LlmManager {
    async fn complete(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
    ) -> Result<LlmMessage, AppError> {
        // 非流式：无头任务不需要逐 token 回调，只要最终组装结果。
        self.send_message(messages, tools, None).await
    }
}

/// 步数上限的默认值。
///
/// 这是**资源护栏**不是产品限制：模型卡在「查了再看、看了再查」的循环里时，
/// 没有这个上限就会一直烧 token 直到超时。25 步足够覆盖绝大多数运维任务
/// （部署、排障、批量操作）。
pub const DEFAULT_MAX_STEPS: usize = 25;

/// 总超时默认值（秒）。与 CLI 侧 `ssh_execute` 的默认 30s 不同——agent 任务
/// 是多轮 LLM + 多轮命令，量级本来就更大。
pub const DEFAULT_TIMEOUT_SECS: u64 = 300;

/// 单条工具输出写进「步骤记录」时的截断长度。
///
/// 给模型的**完整**输出不受影响（那要进对话）；这里截断的只是回给调用方的
/// 摘要，避免一次 `cat` 大文件把整个返回值撑爆。
const STEP_SUMMARY_MAX_CHARS: usize = 2000;

/// 一次工具调用的留痕。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepRecord {
    pub tool: String,
    pub arguments: Value,
    pub ok: bool,
    /// 输出摘要（截断；全文只给模型看）
    pub output_summary: String,
}

/// 一次委派任务的最终结果。
///
/// `status` 的四个取值对应四种收尾方式，调用方可以据此决定要不要重试：
/// - `completed`：模型自己认为干完了
/// - `max_steps`：撞到步数上限（可能没干完，`result` 是最后一次发言）
/// - `timeout`：撞到总超时
/// - `failed`：循环本身出错（LLM 调用失败等）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTaskResult {
    pub status: String,
    /// 模型的最终答复（`failed` 时为空）
    pub result: String,
    pub steps: Vec<StepRecord>,
    /// 实际执行的工具调用次数（= `steps.len()`，显式给出省得调用方数）
    pub tool_calls: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 无头 agent 任务的执行者。
///
/// 由 [`ToolRegistry`] 持有（`Arc`），自己反持一个 `Weak<ToolRegistry>` 用来
/// 分发基础工具。用 `Weak` 而不是 `Arc` 是为了**断开引用环**——两边都想拿对方，
/// 强引用会让这对结构永远不释放。
pub struct AgentTaskRunner {
    executor: Arc<ExternalExecutor>,
    config_dir: PathBuf,
    registry: Weak<ToolRegistry>,
    /// LLM 客户端缓存：按需构造，构造失败不缓存（下次调用会重试）。
    ///
    /// **按需**而不是启动时构造，是因为没配模型的用户仍然该能用
    /// `ssh_execute` / `sftp_*`——不能让「没配 LLM」把整个 MCP server 拖死。
    llm: TokioMutex<Option<Arc<LlmManager>>>,
}

impl AgentTaskRunner {
    pub fn new(
        executor: Arc<ExternalExecutor>,
        config_dir: PathBuf,
        registry: Weak<ToolRegistry>,
    ) -> Self {
        Self {
            executor,
            config_dir,
            registry,
            llm: TokioMutex::new(None),
        }
    }

    /// 取（必要时构造）LLM 客户端。
    async fn llm(&self) -> Result<Arc<LlmManager>, AppError> {
        let mut guard = self.llm.lock().await;
        if let Some(existing) = guard.as_ref() {
            return Ok(existing.clone());
        }
        let built = Arc::new(build_headless_llm(&self.config_dir).await?);
        *guard = Some(built.clone());
        Ok(built)
    }

    /// 执行一次委派任务（MCP 工具 `agent_task` 的入口）。
    pub async fn run(&self, arguments: Value) -> Result<ToolCallResult, McpError> {
        let connection_id = arguments
            .get("connection_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'connection_id'"))?
            .to_string();

        let task = arguments
            .get("task")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'task'"))?
            .trim()
            .to_string();

        if task.is_empty() {
            return Err(McpError::invalid_params("'task' 不能为空"));
        }

        let timeout_secs = arguments
            .get("timeout_seconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(10, 3600);

        let max_steps = arguments
            .get("max_steps")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(DEFAULT_MAX_STEPS)
            .clamp(1, 200);

        // 连接先验证一遍：与其让模型白跑两轮才发现连接写错了，不如当场拒绝。
        // 这里曾经只调了 `list_connections()`（它几乎不可能失败），等于没校验，
        // 注释却在承诺「当场拒绝」——现在真的查这个 id 在不在册。
        if !self.executor.connection_exists(&connection_id).await {
            return Err(McpError::invalid_params(format!(
                "连接不存在：{}。先用 list_connections 确认可用的 connection_id。",
                connection_id
            )));
        }

        let llm = match self.llm().await {
            Ok(llm) => llm,
            Err(e) => {
                // 没配模型不是「工具用错了」，而是一个可解释的失败结果——
                // 用 status=failed 的正文回报，而不是 JSON-RPC 错误，
                // 这样调用方能读到完整的原因与建议。
                let result = AgentTaskResult {
                    status: "failed".into(),
                    result: String::new(),
                    steps: Vec::new(),
                    tool_calls: 0,
                    error: Some(format!(
                        "无法初始化 LLM：{}。请先在 Marcel SSH 设置里配置模型渠道与 API Key。",
                        e
                    )),
                };
                return Ok(ToolCallResult::text(json_string(&result)));
            }
        };

        log::info!(
            "[MCP Agent] 任务开始: connection={}, max_steps={}, timeout={}s",
            connection_id,
            max_steps,
            timeout_secs
        );

        let outcome = tokio::time::timeout(
            Duration::from_secs(timeout_secs),
            self.run_loop(llm.as_ref(), &connection_id, &task, max_steps),
        )
        .await;

        let result = match outcome {
            Ok(Ok(result)) => result,
            Ok(Err(e)) => AgentTaskResult {
                status: "failed".into(),
                result: String::new(),
                steps: Vec::new(),
                tool_calls: 0,
                error: Some(e.to_string()),
            },
            Err(_) => AgentTaskResult {
                status: "timeout".into(),
                result: String::new(),
                steps: Vec::new(),
                tool_calls: 0,
                error: Some(format!("任务在 {} 秒后超时", timeout_secs)),
            },
        };

        log::info!(
            "[MCP Agent] 任务结束: status={}, tool_calls={}",
            result.status,
            result.tool_calls
        );

        Ok(ToolCallResult::text(json_string(&result)))
    }

    /// 主循环：LLM → 执行工具 → 回灌结果 → 再问，直到模型不再要工具或撞上限。
    async fn run_loop(
        &self,
        llm: &dyn TaskLlm,
        connection_id: &str,
        task: &str,
        max_steps: usize,
    ) -> Result<AgentTaskResult, AppError> {
        let registry = self
            .registry
            .upgrade()
            .ok_or_else(|| AppError::Agent("工具注册表已释放".into()))?;

        // 给模型的工具清单**不含 agent_task**：不让它自己再派一个 agent 任务
        // （递归委派会让步数上限形同虚设，两边的超时也互相叠加）。
        let tools = base_tool_definitions(&registry);

        let mut messages = vec![
            LlmMessage::system(system_prompt(connection_id)),
            LlmMessage::user(task),
        ];
        let mut steps: Vec<StepRecord> = Vec::new();
        // 循环结束后用作 result 的「最后一次发言」
        let mut last_content = String::new();

        for step_index in 0..max_steps {
            let reply = llm.complete(&messages, &tools).await?;

            if !reply.content.trim().is_empty() {
                last_content = reply.content.clone();
            }

            let calls = reply.tool_calls.clone().unwrap_or_default();
            if calls.is_empty() {
                // 模型不再要工具 = 它认为干完了
                return Ok(AgentTaskResult {
                    status: "completed".into(),
                    result: reply.content,
                    tool_calls: steps.len(),
                    steps,
                    error: None,
                });
            }

            // assistant 消息要原样回灌（含 tool_calls 与 reasoning_content——
            // 思考模型的 reasoning 必须原样带回，否则后续请求会被拒）。
            messages.push(reply);

            for call in calls {
                let outcome = registry.dispatch_base(&call.name, call.arguments.clone()).await;

                let (ok, text) = match outcome {
                    Ok(result) => (true, content_text(&result)),
                    Err(err) => (
                        false,
                        format!("工具调用失败 [{}] {}", err.code, err.message),
                    ),
                };

                log::debug!(
                    "[MCP Agent] step {}/{}: {} → {}",
                    step_index + 1,
                    max_steps,
                    call.name,
                    if ok { "ok" } else { "error" }
                );

                steps.push(StepRecord {
                    tool: call.name.clone(),
                    arguments: call.arguments.clone(),
                    ok,
                    output_summary: truncate_chars(&text, STEP_SUMMARY_MAX_CHARS),
                });

                messages.push(tool_message(&call.id, text));
            }
        }

        // 撞到上限：如实说是撞了上限，而不是假装完成——
        // 「没干完」和「干完了」对调用方是两回事。
        Ok(AgentTaskResult {
            status: "max_steps".into(),
            result: last_content,
            error: Some(format!(
                "已达到步数上限 {} 步，任务可能未完成",
                max_steps
            )),
            tool_calls: steps.len(),
            steps,
        })
    }
}

/// 无头引导一个 LLM 客户端：`settings.json` + 系统密钥链，**不依赖 `AppState`**。
///
/// 与 GUI 启动路径（`lib.rs` 里的渠道 key 预热）同规则：设置文件里渠道的
/// `api_key` 通常是空的，真正的密钥在系统密钥链里，按渠道 id 取。
pub async fn build_headless_llm(config_dir: &Path) -> Result<LlmManager, AppError> {
    let settings_file = AppSettings::default_file(config_dir);

    let mut settings = tokio::task::spawn_blocking(move || {
        AppSettings::load_from_path(&settings_file)
    })
    .await
    .map_err(|e| AppError::Config(format!("加载设置任务失败：{}", e)))??;

    // 先收集 id 再逐个回填：密钥链读取是阻塞调用，要 spawn_blocking，
    // 而 `&mut settings` 不能跨 await 持有。
    let channel_ids: Vec<String> = settings
        .llm_registry
        .channels
        .iter()
        .map(|c| c.id.clone())
        .collect();

    let mut fetched: Vec<Option<String>> = Vec::with_capacity(channel_ids.len());
    for id in channel_ids {
        let key = tokio::task::spawn_blocking(move || crate::config::keychain::get_llm_channel_key(&id))
            .await
            .ok()
            .and_then(|res| res.ok())
            .flatten();
        fetched.push(key);
    }

    for (channel, key) in settings.llm_registry.channels.iter_mut().zip(fetched) {
        if channel.api_key.is_empty() {
            if let Some(key) = key {
                channel.api_key = key;
            }
        }
    }

    let resolved = settings.llm_registry.resolve_default()?;
    LlmManager::new(resolved.config)
}

/// 基础工具（9 个）转成给 LLM 的工具声明，**剔除 `agent_task`**。
fn base_tool_definitions(registry: &ToolRegistry) -> Vec<ToolDefinition> {
    registry
        .list_tools()
        .into_iter()
        .filter(|schema| schema.get("name").and_then(|v| v.as_str()) != Some(tools::AGENT_TASK_TOOL))
        .filter_map(|schema| {
            let name = schema.get("name")?.as_str()?.to_string();
            let description = schema
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let parameters = schema
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({ "type": "object" }));
            Some(ToolDefinition {
                name,
                description,
                parameters,
            })
        })
        .collect()
}

/// 系统提示词。
///
/// 三条是这个场景独有、必须说明白的：
/// 1. **没人能回答问题**——它不能反问，只能自己判断或如实报告做不到；
/// 2. **每条命令都是新 shell**——`cd` 不保持，这是初学远程操作最常见的错；
/// 3. **没有审批闸门**——所以破坏性操作要它自己先掂量。
fn system_prompt(connection_id: &str) -> String {
    format!(
        r#"你是 Marcel SSH 的无头 SSH 任务执行者。你收到一个任务描述，通过工具在远程服务器上把它做完，最后用一段话汇报结果。

## 目标机器
本次任务固定作用在 SSH 连接 `{connection_id}` 上——所有工具的 `connection_id` 参数都传这个值，不要换成别的。

## 工作方式
1. **先看再动**：动手改任何东西之前，先查清现状（系统、路径、权限、服务状态）。凭印象写命令是远程操作翻车的主要原因。
2. **小步验证**：每步做完看结果，再决定下一步。不要一口气串十条命令然后一起看输出。
3. **改完要验证**：重启服务就确认它真的起来了（`systemctl is-active`、看日志），不要止步于「命令没报错」。

## 你必须知道的硬约束

**每条命令都是全新的 shell，不保持状态。** `cd` 不会留到下一次调用：
- 错误：先 `cd /opt/app`，再下一条 `ls`
- 正确：`cd /opt/app && ls`，或者直接 `ls /opt/app`

**没有人能回答你的问题。** 你无法向用户提问。遇到需要决策的地方，自己基于现状做最合理的选择，并在最终汇报里说明你做了什么假设。如果任务根本做不了，如实说明原因，不要编造成功。

**没有审批闸门。** 你执行的命令不会有人复核。所以破坏性操作（删除、覆盖、重启服务、改配置）你必须自己先确认：目标对不对？有没有备份？失败了能不能回退？拿不准就选更保守的做法，并在汇报里说明。

## 汇报
结束时用中文给出简明汇报：做了什么、结果如何、有没有遗留问题或需要用户注意的地方。不要罗列每一步的命令，说清楚结论和影响即可。"#,
        connection_id = connection_id
    )
}

/// 构造一条 tool 角色的消息（把工具执行结果回灌给模型）。
fn tool_message(tool_call_id: &str, content: String) -> LlmMessage {
    LlmMessage {
        role: LlmRole::Tool,
        content,
        tool_calls: None,
        tool_call_id: Some(tool_call_id.to_string()),
        reasoning_content: None,
        image_paths: None,
        finish_reason: None,
        db_id: None,
        db_id_known: false,
    }
}

/// 把 MCP 工具结果里的文本内容拼起来。
fn content_text(result: &ToolCallResult) -> String {
    result
        .content
        .iter()
        .map(|item| match item {
            crate::mcp_server::protocol::ContentItem::Text { text } => text.clone(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 按**字符**（不是字节）截断，避免在 UTF-8 中间切断。
fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut out: String = value.chars().take(max_chars).collect();
    if value.chars().count() > max_chars {
        out.push_str("…（已截断）");
    }
    out
}

/// 序列化结果。序列化失败理论上不可达（都是普通数据结构），
/// 但不能 panic——退回一个手工拼的字符串总比让整个 MCP 请求崩掉好。
fn json_string<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|e| {
        format!("{{\"status\":\"failed\",\"result\":\"\",\"steps\":[],\"tool_calls\":0,\"error\":\"结果序列化失败: {}\"}}", e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_pins_connection_and_warns_about_stateless_shell() {
        let prompt = system_prompt("conn-42");
        // 连接 id 必须出现在提示词里（模型靠它填参数）
        assert!(prompt.contains("conn-42"));
        // 两条最容易踩的坑必须写明
        assert!(prompt.contains("全新的 shell"));
        assert!(prompt.contains("没有人能回答你的问题"));
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        // 中文按字符截断，不能切出半个字符
        let s = "一二三四五";
        assert_eq!(truncate_chars(s, 3), "一二三…（已截断）");
        assert_eq!(truncate_chars(s, 10), "一二三四五");
        assert_eq!(truncate_chars("", 5), "");
    }

    #[test]
    fn tool_message_carries_call_id() {
        let msg = tool_message("call_1", "输出".into());
        assert_eq!(msg.role, LlmRole::Tool);
        assert_eq!(msg.tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(msg.content, "输出");
        // tool 消息不该带 tool_calls（那会构成畸形的请求体）
        assert!(msg.tool_calls.is_none());
    }

    #[test]
    fn content_text_joins_multiple_items() {
        let result = ToolCallResult::text("hello");
        assert_eq!(content_text(&result), "hello");
    }

    #[test]
    fn json_string_falls_back_instead_of_panicking() {
        // 正常路径
        let result = AgentTaskResult {
            status: "completed".into(),
            result: "done".into(),
            steps: vec![],
            tool_calls: 0,
            error: None,
        };
        let text = json_string(&result);
        assert!(text.contains("\"status\":\"completed\""));
        // error 为 None 时不该出现在 JSON 里
        assert!(!text.contains("\"error\""));
    }

    #[test]
    fn step_record_serializes_arguments_and_summary() {
        let step = StepRecord {
            tool: "ssh_execute".into(),
            arguments: serde_json::json!({ "command": "ls" }),
            ok: true,
            output_summary: "file1\nfile2".into(),
        };
        let value = serde_json::to_value(&step).unwrap();
        assert_eq!(value["tool"], "ssh_execute");
        assert_eq!(value["arguments"]["command"], "ls");
        assert_eq!(value["ok"], true);
    }

    // ───────── 任务循环：用脚本化的假模型离线验证 ─────────
    //
    // 循环的收尾分支（干完 / 撞上限 / 工具失败 / 模型报错）全取决于模型回什么。
    // 真实 `LlmManager` 要联网要 Key，所以这里用 `TaskLlm` 假实现把整条循环跑通。

    use crate::llm::provider::ToolCall;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// 按脚本依次返回回复的假模型。
    ///
    /// 脚本用尽后**返回错误**而不是空回复——后者会让循环静默「完成」，
    /// 于是「循环该停没停」这种 bug 会被测成绿的。
    struct ScriptedLlm {
        replies: Mutex<VecDeque<LlmMessage>>,
        seen_tools: Mutex<Vec<Vec<String>>>,
    }

    impl ScriptedLlm {
        fn new(replies: Vec<LlmMessage>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
                seen_tools: Mutex::new(Vec::new()),
            }
        }

        /// 每次调用时下发给模型的工具名（用于断言 agent_task 被剔除）。
        fn tools_seen(&self) -> Vec<Vec<String>> {
            self.seen_tools.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl TaskLlm for ScriptedLlm {
        async fn complete(
            &self,
            _messages: &[LlmMessage],
            tools: &[ToolDefinition],
        ) -> Result<LlmMessage, AppError> {
            self.seen_tools
                .lock()
                .unwrap()
                .push(tools.iter().map(|t| t.name.clone()).collect());
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| AppError::Agent("脚本已用尽：循环没有按预期停下".into()))
        }
    }

    fn calls_tool(id: &str, name: &str, args: serde_json::Value) -> LlmMessage {
        let mut m = LlmMessage::assistant("");
        m.tool_calls = Some(vec![ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args,
        }]);
        m
    }

    /// 造一个 runner（registry 必须活着，runner 里拿的是它的 Weak）。
    async fn test_runner() -> (Arc<ToolRegistry>, Arc<AgentTaskRunner>) {
        let ssh = crate::SshManager::new();
        let dir =
            std::env::temp_dir().join(format!("marcel-agent-test-{}", uuid::Uuid::new_v4()));
        let exec_mgr = Arc::new(
            crate::command_exec::CommandExecutionManager::new(
                ssh.clone(),
                dir.join("jobs_temp"),
                dir.join("ledger.jsonl"),
            )
            .await,
        );
        let store = Arc::new(tokio::sync::RwLock::new(
            crate::config::connections::ConnectionStore::new(),
        ));
        let executor = Arc::new(ExternalExecutor::new(store, exec_mgr, Arc::new(ssh)));
        let registry = ToolRegistry::new_with_agent_tasks(executor, dir);
        let runner = registry
            .agent_task_runner()
            .expect("new_with_agent_tasks 应带 runner")
            .clone();
        (registry, runner)
    }

    #[tokio::test]
    async fn loop_completes_when_model_stops_calling_tools() {
        let (_registry, runner) = test_runner().await;
        let llm = ScriptedLlm::new(vec![
            calls_tool("c1", "list_connections", serde_json::json!({})),
            LlmMessage::assistant("干完了"),
        ]);

        let result = runner
            .run_loop(&llm, "conn-x", "看看有哪些连接", 10)
            .await
            .expect("循环不该报错");

        assert_eq!(result.status, "completed");
        assert_eq!(result.result, "干完了");
        assert_eq!(result.tool_calls, 1);
        assert_eq!(result.steps.len(), 1);
        assert_eq!(result.steps[0].tool, "list_connections");
        assert!(result.steps[0].ok, "这步应当成功");
        assert!(result.error.is_none());
    }

    #[tokio::test]
    async fn loop_stops_at_max_steps_and_says_so() {
        let (_registry, runner) = test_runner().await;
        // 模型一直要工具，永不收手
        let llm = ScriptedLlm::new(vec![
            calls_tool("c1", "list_connections", serde_json::json!({})),
            calls_tool("c2", "list_connections", serde_json::json!({})),
            calls_tool("c3", "list_connections", serde_json::json!({})),
            calls_tool("c4", "list_connections", serde_json::json!({})),
        ]);

        let result = runner
            .run_loop(&llm, "conn-x", "无休止", 3)
            .await
            .expect("撞上限不是错误，是一个结果");

        // 「没干完」必须与「干完了」区分开——调用方据此决定要不要继续
        assert_eq!(result.status, "max_steps");
        assert_eq!(result.steps.len(), 3, "恰好跑满上限，不多不少");
        assert!(result.error.as_deref().unwrap_or("").contains("步数上限"));
    }

    #[tokio::test]
    async fn loop_records_failed_tool_call_without_aborting() {
        let (_registry, runner) = test_runner().await;
        let llm = ScriptedLlm::new(vec![
            // 连接不存在 → dispatch 会返回错误
            calls_tool(
                "c1",
                "ssh_execute",
                serde_json::json!({ "connection_id": "nope", "command": "ls" }),
            ),
            LlmMessage::assistant("工具报错了，我停下来说明情况"),
        ]);

        let result = runner
            .run_loop(&llm, "conn-x", "跑个命令", 10)
            .await
            .expect("工具失败不该炸掉整个循环");

        assert_eq!(result.status, "completed");
        assert_eq!(result.steps.len(), 1);
        assert!(!result.steps[0].ok, "失败的一步要如实记为失败");
        // 失败的痕迹要留下来给调用方看，而不是被悄悄吞掉
        assert!(result.steps[0].output_summary.contains("1001")
            || result.steps[0].output_summary.contains("Connection not found"));
    }

    #[tokio::test]
    async fn loop_hides_agent_task_from_the_model() {
        let (_registry, runner) = test_runner().await;
        let llm = ScriptedLlm::new(vec![LlmMessage::assistant("不用工具")]);

        runner.run_loop(&llm, "conn-x", "随便", 5).await.unwrap();

        let seen = llm.tools_seen();
        assert!(!seen.is_empty(), "应至少下发过一次工具清单");
        for names in &seen {
            assert!(
                !names.iter().any(|n| n == tools::AGENT_TASK_TOOL),
                "不得把 agent_task 给模型：递归委派会让步数上限形同虚设"
            );
            assert!(
                names.iter().any(|n| n == "ssh_execute"),
                "基础工具应当都在"
            );
        }
    }

    #[tokio::test]
    async fn loop_propagates_llm_error() {
        let (_registry, runner) = test_runner().await;
        // 空脚本 → 假模型立刻报错
        let llm = ScriptedLlm::new(vec![]);

        let err = runner
            .run_loop(&llm, "conn-x", "任务", 5)
            .await
            .expect_err("模型报错必须冒泡出来");
        assert!(err.to_string().contains("脚本已用尽"));
    }
}
