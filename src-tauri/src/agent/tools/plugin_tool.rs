use async_trait::async_trait;
use serde_json::Value;
use tauri::Manager;

use crate::agent::risk::Disposition;
use crate::agent::tools::{local_handlers, truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::plugins::auth::{authorize, AuthResult};
use crate::plugins::context::{apply_to_string, apply_to_value, SessionContext};
use crate::plugins::manifest::{PluginAgentToolDef, PluginManifest, ToolKind};

/// `kind=ssh` 的工具与 IPC 的这条命令等价（同为"在远端执行一条命令"），
/// 所以它的 capability 从同一份「命令 → capability」映射里取，而不是在本文件
/// 写死 `"ssh.exec"` —— 见 [`PluginAgentTool::required_capability`]。
const SSH_EXEC_IPC_COMMAND: &str = "ssh_exec";

/// Extract session context from the ToolContext. Returns `None` if the
/// session does not exist (e.g. it was closed mid-task); callers fall back
/// to empty strings and log a warning.
async fn extract_session_context(ctx: &ToolContext) -> Option<SessionContext> {
    let info = ctx.ssh.get_session_info(&ctx.session_id).await?;
    Some(SessionContext::from_session(&info, &ctx.session_id))
}

pub struct PluginAgentTool {
    name: String,
    description: String,
    command_template: String,
    parameters: Value,
    disposition: Disposition,
    /// `"ssh"` (default) or `"local"`.
    kind: ToolKind,
    /// Required when `kind = "local"`. Names a kernel-registered handler.
    handler: Option<String>,
    /// Owning plugin id. Injected as `__plugin_id` into handler params so
    /// fs handlers can resolve paths under the plugin's own directory.
    plugin_id: String,
    /// For `kind=local`: a JSON object parsed from the `command` field,
    /// containing fixed params the model cannot override (e.g. `path`).
    /// Empty object for `kind=ssh` or when `command` is not valid JSON.
    fixed_params: Value,
}

impl PluginAgentTool {
    /// 授权不看注册时那份 `capabilities` 快照（会过期）：一律在调用时读当前的
    /// manifest 与设置（见 `authorize_now`），所以这里不需要它。
    pub fn new(def: &PluginAgentToolDef, plugin_id: &str) -> Self {
        let risk = def.risk_level;
        // For kind=local, the `command` field is repurposed as a JSON object
        // string of fixed params (e.g. `{"path":"memories/{{__host_port__}}.jsonl"}`).
        // This lets plugins inject path templates the model cannot override,
        // without adding a new manifest field. For kind=ssh the field is
        // used as the SSH command template and is NOT parsed as JSON.
        let fixed_params = if def.kind == ToolKind::Local && !def.command.is_empty() {
            match serde_json::from_str::<Value>(&def.command) {
                Ok(v) if v.is_object() => v,
                Ok(_) => {
                    log::warn!(
                        "插件工具 {} 的 command 字段不是 JSON 对象，忽略固定参数",
                        def.name
                    );
                    Value::Object(serde_json::Map::new())
                }
                Err(e) => {
                    log::warn!(
                        "插件工具 {} 的 command 字段解析失败 ({}): {}",
                        def.name,
                        def.command,
                        e
                    );
                    Value::Object(serde_json::Map::new())
                }
            }
        } else {
            Value::Object(serde_json::Map::new())
        };
        Self {
            name: def.name.clone(),
            description: def.description.clone(),
            command_template: def.command.clone(),
            parameters: if def.parameters.is_null() {
                serde_json::json!({ "type": "object", "properties": {} })
            } else {
                def.parameters.clone()
            },
            disposition: risk,
            kind: def.kind,
            handler: def.handler.clone(),
            plugin_id: plugin_id.to_string(),
            fixed_params,
        }
    }

    /// 本工具这次调用要求插件持有的 capability。
    ///
    /// 不去别处另写一份映射：`kind=ssh` 等价于 IPC 的 `ssh_exec`，`kind=local` 由
    /// handler 名决定 —— 两者都取自 [`crate::plugins::capability`]（唯一映射，
    /// IPC / HTTP / 本地 handler 三处共用）。
    ///
    /// `Err(...)` = 这次调用连"该要什么权限"都定不下来（handler 没配或没在内核注册），
    /// 直接失败并把话回给模型。
    fn required_capability(&self) -> Result<&'static str, ToolOutput> {
        match self.kind {
            ToolKind::Ssh => crate::plugins::capability::capability_for(SSH_EXEC_IPC_COMMAND)
                .ok_or_else(|| {
                    ToolOutput::fail(
                        "capability 未知",
                        format!(
                            "内核能力映射里没有 `{}`，无法判定工具 {} 需要什么权限",
                            SSH_EXEC_IPC_COMMAND, self.name
                        ),
                    )
                }),
            ToolKind::Local => match self.handler.as_deref() {
                Some(h) if !h.is_empty() => {
                    local_handlers::required_capability(h).ok_or_else(|| {
                        ToolOutput::fail("handler 未注册", format!("handler `{}` 未在内核注册", h))
                    })
                }
                _ => Err(ToolOutput::fail(
                    "handler 未配置",
                    format!("插件工具 {} 未配置 handler", self.name),
                )),
            },
        }
    }

    /// 三层授权判定：插件启用 / manifest 声明 / 用户授权。
    ///
    /// **唯一判据是 [`crate::plugins::auth::authorize`]**，与事件 IPC
    /// （`pluginIpc.ts`）、HTTP API（`commands/plugin_api.rs`）同源：第三层
    /// （`settings.authorized_capabilities`，插件不在表里 = 全部声明算授权）只在
    /// 那里有定义，自己复述一遍就会和设置页的开关漂移 —— 用户关掉 `fs.write`
    /// 之后 Agent 工具照样写，正是这么来的。
    fn check_authorized(
        &self,
        capability: &str,
        manifest: Option<&PluginManifest>,
        settings: &AppSettings,
    ) -> Result<(), ToolOutput> {
        match authorize(&self.plugin_id, capability, manifest, settings) {
            AuthResult::Authorized => Ok(()),
            AuthResult::Denied { reason } => Err(ToolOutput::fail(
                "capability 不足",
                format!(
                    "工具 {} 需要 capability `{}`：{}",
                    self.name, capability, reason
                ),
            )),
        }
    }

    /// 取**当前**的 manifest 与设置后做授权判定。
    ///
    /// 两样都必须是当下的：插件中途被禁用/更新、用户在设置页收回能力，都该立刻生效，
    /// 所以不能拿注册时那份声明快照当判据。取不到应用状态（理论上不会发生）时按
    /// **未授权**处理：确认不了用户授权就不放行。
    async fn authorize_now(&self, capability: &str, ctx: &ToolContext) -> Result<(), ToolOutput> {
        let Some(app_state) = ctx
            .app_handle
            .try_state::<crate::AppState>()
            .map(|state| state.inner().clone())
        else {
            return Err(ToolOutput::fail(
                "capability 不足",
                format!("工具 {} 无法校验插件授权：应用状态不可用", self.name),
            ));
        };
        let manifest =
            crate::plugins::enabled::manifest_for(&ctx.app_handle, &self.plugin_id).await;
        let settings = app_state.settings.read().await;
        self.check_authorized(capability, manifest.as_ref(), &settings)
    }

    /// Render the SSH command template by injecting context variables first
    /// (so the model cannot override `{{__host__}}` etc.), then substituting
    /// model-supplied params. `session_ctx=None` falls back to empty strings
    /// for all context variables.
    fn render_command(&self, params: &Value, session_ctx: Option<&SessionContext>) -> String {
        let mut cmd = self.command_template.clone();
        // 1. Inject context variables FIRST — model cannot override them.
        if let Some(sctx) = session_ctx {
            cmd = apply_to_string(&cmd, sctx);
        } else {
            cmd = cmd
                .replace("{{__host__}}", "")
                .replace("{{__port__}}", "")
                .replace("{{__host_port__}}", "")
                .replace("{{__session_id__}}", "")
                .replace("{{__connection_id__}}", "")
                .replace("{{__username__}}", "")
                .replace("{{__timestamp__}}", "");
        }
        // 2. Substitute model-supplied params (placeholders already consumed
        //    by step 1 won't match, so context variables are safe).
        if let Some(obj) = params.as_object() {
            for (key, val) in obj {
                let placeholder = format!("{{{{{}}}}}", key);
                let replacement = match val {
                    Value::String(s) => s.clone(),
                    _ => val.to_string(),
                };
                cmd = cmd.replace(&placeholder, &replacement);
            }
        }
        cmd
    }

    /// Execute a `kind=local` tool: handler lookup → fixed-params merge →
    /// context-variable substitution → handler call.
    ///
    /// 能力授权已由 `execute` 统一做掉（两条路径共用一套判定），这里只管执行。
    async fn execute_local(
        &self,
        mut params: Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let handler_name = match self.handler.as_deref() {
            Some(h) if !h.is_empty() => h,
            _ => {
                return Ok(ToolOutput::fail(
                    "handler 未配置",
                    format!("插件工具 {} 未配置 handler", self.name),
                ))
            }
        };

        // Look up the handler in the context's shared handler map.
        let handler = match ctx.local_handlers.get(handler_name) {
            Some(h) => h.clone(),
            None => {
                return Ok(ToolOutput::fail(
                    "handler 未注册",
                    format!("handler `{}` 未注册", handler_name),
                ))
            }
        };

        // Extract session context for variable substitution.
        let session_ctx = extract_session_context(ctx).await;
        if session_ctx.is_none() {
            log::warn!(
                "插件工具 {} 无法获取会话上下文，上下文变量替换为空字符串",
                self.name
            );
        }

        // Merge fixed params (from `command` template) into model params.
        // Fixed params take precedence — the model cannot override `path`
        // or other fields the plugin author chose to pin in the manifest.
        if let Some(model_obj) = params.as_object_mut() {
            if let Some(fixed_obj) = self.fixed_params.as_object() {
                for (k, v) in fixed_obj {
                    model_obj.insert(k.clone(), v.clone());
                }
            }
            // Inject __plugin_id so fs handlers can resolve plugin-relative paths.
            model_obj.insert(
                "__plugin_id".to_string(),
                Value::String(self.plugin_id.clone()),
            );
        }

        // Substitute context variables in all top-level string values.
        if let Some(sctx) = session_ctx.as_ref() {
            apply_to_value(&mut params, sctx);
        }

        // Invoke the handler.
        let result = handler.call(params, ctx).await?;
        let output = serde_json::to_string(&result).unwrap_or_default();
        Ok(ToolOutput::ok(
            format!("插件工具 {} 执行完成", self.name),
            output,
        ))
    }
}

#[async_trait]
impl AgentTool for PluginAgentTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters_schema(&self) -> Value {
        self.parameters.clone()
    }

    fn disposition(&self) -> Disposition {
        self.disposition
    }

    /// `kind=ssh` 的命令要先渲染模板才成型，参数里没有现成的字符串 —— 交给
    /// dispatcher 拿去评风险、走命令名单和模型审批，本工具自己不再评一遍。
    async fn rendered_command(&self, params: &Value, ctx: &ToolContext) -> Option<String> {
        if self.kind != ToolKind::Ssh {
            return None;
        }
        let session_ctx = extract_session_context(ctx).await;
        Some(self.render_command(params, session_ctx.as_ref()))
    }

    async fn execute(&self, params: Value, ctx: &ToolContext) -> Result<ToolOutput, AppError> {
        // 授权先行，两条路径共用（`execute_local` 里不再自己查一遍）：
        // 以前 `kind=local` 只查 manifest 声明、`kind=ssh` 连声明都不查，
        // 于是用户收回的能力和"根本没声明过的能力"都能从这里溜过去。
        let capability = match self.required_capability() {
            Ok(capability) => capability,
            Err(failure) => return Ok(failure),
        };
        if let Err(denied) = self.authorize_now(capability, ctx).await {
            return Ok(denied);
        }

        // kind=local: dispatch to the registered local handler.
        if self.kind == ToolKind::Local {
            return self.execute_local(params, ctx).await;
        }

        // kind=ssh: render the command template, then execute.
        let session_ctx = extract_session_context(ctx).await;
        if session_ctx.is_none() {
            log::warn!(
                "插件工具 {} 无法获取会话上下文，上下文变量替换为空字符串",
                self.name
            );
        }
        let command = self.render_command(&params, session_ctx.as_ref());

        let output = ctx.exec(&command).await?;
        let truncated = truncate_output(output, 8_000);
        Ok(ToolOutput::ok(
            format!("插件工具 {} 执行完成", self.name),
            truncated,
        ))
    }
}

/// 注册某个插件的全部 agent 工具。
///
/// 不需要调用方传 manifest 的 `capabilities`：授权读的是**当前**的 manifest 与
/// 设置（见 `PluginAgentTool::authorize_now`），注册时那份声明快照不参与判定。
pub fn register_plugin_tools(
    registry: &mut crate::agent::tools::ToolRegistry,
    plugin_id: &str,
    tools: &[PluginAgentToolDef],
) {
    for def in tools {
        registry.register(std::sync::Arc::new(PluginAgentTool::new(def, plugin_id)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_def(name: &str, cmd: &str, risk: Disposition) -> PluginAgentToolDef {
        PluginAgentToolDef {
            name: name.into(),
            description: "test".into(),
            command: cmd.into(),
            kind: ToolKind::Ssh,
            handler: None,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "arg": { "type": "string" }
                }
            }),
            risk_level: risk,
        }
    }

    fn make_local_def(name: &str, handler: &str, command: &str) -> PluginAgentToolDef {
        PluginAgentToolDef {
            name: name.into(),
            description: "test local".into(),
            command: command.into(),
            kind: ToolKind::Local,
            handler: Some(handler.into()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "entry": { "type": "string" }
                }
            }),
            risk_level: Disposition::Approval,
        }
    }

    fn make_session_ctx() -> SessionContext {
        SessionContext {
            host: "1.2.3.4".into(),
            port: "22".into(),
            host_port: "1.2.3.4_22".into(),
            session_id: "sess-1".into(),
            connection_id: "conn-1".into(),
            username: "root".into(),
            timestamp: "1720000000".into(),
        }
    }

    #[test]
    fn render_command_replaces_placeholders() {
        let tool = PluginAgentTool::new(&make_def("test", "echo {{arg}}", Disposition::Allow), "p");
        let cmd = tool.render_command(&serde_json::json!({ "arg": "hello" }), None);
        assert_eq!(cmd, "echo hello");
    }

    #[test]
    fn render_command_handles_missing_params() {
        let tool = PluginAgentTool::new(&make_def("test", "echo {{arg}}", Disposition::Allow), "p");
        let cmd = tool.render_command(&serde_json::json!({}), None);
        assert_eq!(cmd, "echo {{arg}}");
    }

    #[test]
    fn disposition_passthrough() {
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", Disposition::Allow), "p").disposition(),
            Disposition::Allow
        );
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", Disposition::Approval), "p").disposition(),
            Disposition::Approval
        );
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", Disposition::ForceApproval), "p")
                .disposition(),
            Disposition::ForceApproval
        );
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", Disposition::Approval), "p").disposition(),
            Disposition::Approval
        );
    }

    #[test]
    fn null_parameters_defaults_to_empty_object() {
        let mut def = make_def("t", "cmd", Disposition::Allow);
        def.parameters = Value::Null;
        let tool = PluginAgentTool::new(&def, "p");
        assert_eq!(tool.parameters_schema()["type"], "object");
    }

    // ── Context variable injection (Task 5) ──

    #[test]
    fn render_command_injects_context_variables() {
        let tool = PluginAgentTool::new(
            &make_def("test", "echo {{__host__}}:{{__port__}}", Disposition::Allow),
            "p",
        );
        let sctx = make_session_ctx();
        let cmd = tool.render_command(&serde_json::json!({}), Some(&sctx));
        assert_eq!(cmd, "echo 1.2.3.4:22");
    }

    #[test]
    fn render_command_injects_host_port_with_underscore() {
        let tool = PluginAgentTool::new(
            &make_def("test", "cat {{__host_port__}}.log", Disposition::Allow),
            "p",
        );
        let sctx = make_session_ctx();
        let cmd = tool.render_command(&serde_json::json!({}), Some(&sctx));
        assert_eq!(cmd, "cat 1.2.3.4_22.log");
    }

    #[test]
    fn render_command_model_cannot_override_context_variable() {
        // Model tries to pass __host__ = "evil.com"; the context variable
        // is injected FIRST so the placeholder is already consumed.
        let tool = PluginAgentTool::new(
            &make_def("test", "echo {{__host__}}", Disposition::Allow),
            "p",
        );
        let sctx = make_session_ctx();
        let cmd = tool.render_command(&serde_json::json!({ "__host__": "evil.com" }), Some(&sctx));
        assert_eq!(cmd, "echo 1.2.3.4");
    }

    #[test]
    fn render_command_no_session_replaces_with_empty() {
        let tool = PluginAgentTool::new(
            &make_def("test", "echo {{__host__}}:{{__port__}}", Disposition::Allow),
            "p",
        );
        let cmd = tool.render_command(&serde_json::json!({}), None);
        assert_eq!(cmd, "echo :");
    }

    #[test]
    fn render_command_injects_timestamp() {
        let tool = PluginAgentTool::new(
            &make_def("test", "id mem_{{__timestamp__}}", Disposition::Allow),
            "p",
        );
        let sctx = make_session_ctx();
        let cmd = tool.render_command(&serde_json::json!({}), Some(&sctx));
        assert_eq!(cmd, "id mem_1720000000");
    }

    // ── kind=local fixed params parsing (Task 3) ──

    #[test]
    fn local_tool_parses_fixed_params_from_command() {
        let def = make_local_def(
            "memory_save",
            "fs.append",
            r#"{"path":"memories/{{__host_port__}}.jsonl"}"#,
        );
        let tool = PluginAgentTool::new(&def, "mem-plugin");
        assert!(tool.fixed_params.is_object());
        assert_eq!(
            tool.fixed_params["path"],
            "memories/{{__host_port__}}.jsonl"
        );
    }

    #[test]
    fn local_tool_invalid_json_command_yields_empty_fixed_params() {
        let def = make_local_def("bad", "fs.read", "not valid json");
        let tool = PluginAgentTool::new(&def, "p");
        assert!(tool.fixed_params.as_object().is_some_and(|o| o.is_empty()));
    }

    #[test]
    fn local_tool_empty_command_yields_empty_fixed_params() {
        let def = make_local_def("empty", "fs.read", "");
        let tool = PluginAgentTool::new(&def, "p");
        assert!(tool.fixed_params.as_object().is_some_and(|o| o.is_empty()));
    }

    #[test]
    fn ssh_tool_does_not_parse_command_as_json() {
        // kind=ssh: command is a shell template, not JSON. It must be stored
        // as command_template verbatim and fixed_params stays empty.
        let def = make_def("ssh_tool", "echo {{arg}}", Disposition::Allow);
        let tool = PluginAgentTool::new(&def, "p");
        assert!(tool.fixed_params.as_object().is_some_and(|o| o.is_empty()));
        assert_eq!(tool.command_template, "echo {{arg}}");
    }

    #[test]
    fn apply_context_variables_replaces_all_seven() {
        let sctx = make_session_ctx();
        let template = "{{__host__}} {{__port__}} {{__host_port__}} {{__session_id__}} {{__connection_id__}} {{__username__}} {{__timestamp__}}";
        let rendered = apply_to_string(template, &sctx);
        assert_eq!(
            rendered,
            "1.2.3.4 22 1.2.3.4_22 sess-1 conn-1 root 1720000000"
        );
    }

    #[test]
    fn apply_context_variables_to_params_replaces_strings_only() {
        let sctx = make_session_ctx();
        let mut params = serde_json::json!({
            "path": "memories/{{__host_port__}}.jsonl",
            "content": "id {{__timestamp__}}",
            "count": 42
        });
        apply_to_value(&mut params, &sctx);
        assert_eq!(params["path"], "memories/1.2.3.4_22.jsonl");
        assert_eq!(params["content"], "id 1720000000");
        assert_eq!(params["count"], 42, "non-string values are not touched");
    }

    // ── 能力授权（agent 工具路径） ──

    /// 构造一份只关心 `capabilities` 的 manifest —— 授权判定只读这一个字段。
    fn manifest_with(caps: &[&str]) -> PluginManifest {
        PluginManifest {
            id: "p".into(),
            name: "Test".into(),
            version: "1.0.0".into(),
            publisher: String::new(),
            description: "test".into(),
            capabilities: caps.iter().map(|s| s.to_string()).collect(),
            views: vec![],
            agent_tools: vec![],
            injections: vec![],
            config_view: None,
            system_prompt_section: None,
            min_app_version: None,
            preserve_paths: vec![],
        }
    }

    /// `kind=ssh` 工具要求的能力来自**同一份**「命令 → capability」映射
    /// （`ssh_exec` → `ssh.exec`），不是本文件另写的一个常量。
    #[test]
    fn ssh_tool_requires_the_mapped_ssh_exec_capability() {
        let tool = PluginAgentTool::new(&make_def("t", "top -bn1", Disposition::Allow), "p");
        assert_eq!(tool.required_capability().unwrap(), "ssh.exec");
    }

    /// `kind=local` 的要求由 handler 决定，同样取自那份唯一映射；未知 handler
    /// （以及没配 handler）直接失败，不进入执行。
    #[test]
    fn local_tool_takes_its_capability_from_the_handler_map() {
        let read = PluginAgentTool::new(&make_local_def("r", "fs.read", ""), "p");
        assert_eq!(read.required_capability().unwrap(), "fs.read");
        let append = PluginAgentTool::new(&make_local_def("a", "fs.append", ""), "p");
        assert_eq!(append.required_capability().unwrap(), "fs.write");

        let unknown = PluginAgentTool::new(&make_local_def("u", "nope.handler", ""), "p");
        assert!(
            unknown.required_capability().is_err(),
            "未在内核注册的 handler 不该执行"
        );
    }

    /// **回归：agent 工具路径曾漏掉「用户授权」这一层。**
    ///
    /// `kind=local` 只查 manifest 声明（用户在设置页收回的能力对它无效），
    /// `kind=ssh` 连声明都不查。`check_authorized` 就是 `execute` 走的那一步
    /// （`authorize_now` 只负责把实时的 manifest + 设置喂进来），三层缺一不可。
    #[test]
    fn agent_tool_path_enforces_all_three_authorization_layers() {
        let tool = PluginAgentTool::new(&make_local_def("memory_save", "fs.append", ""), "p");
        let capability = tool.required_capability().unwrap();
        let manifest = manifest_with(&["fs.read", "fs.write"]);

        // 第二层：声明里没有 → 拒绝。
        assert!(tool
            .check_authorized(
                capability,
                Some(&manifest_with(&[])),
                &AppSettings::default()
            )
            .is_err());

        // 声明齐全、用户没收回（插件不在授权表里 = 全部声明都算授权）→ 放行。
        assert!(tool
            .check_authorized(capability, Some(&manifest), &AppSettings::default())
            .is_ok());

        // 第三层：用户在设置页只留下 fs.read → 必须拒绝（本次修复的主场景）。
        let mut revoked = AppSettings::default();
        revoked
            .authorized_capabilities
            .insert("p".into(), vec!["fs.read".into()]);
        let denied = tool.check_authorized(capability, Some(&manifest), &revoked);
        assert!(denied.is_err(), "用户收回 fs.write 后，写入工具必须被拒");
        assert!(
            denied.unwrap_err().output.contains("fs.write"),
            "失败原因要指出缺的是哪个 capability"
        );

        // 第一层：插件被禁用 → 拒绝。
        let mut disabled = AppSettings::default();
        disabled.disabled_plugins.push("p".into());
        assert!(tool
            .check_authorized(capability, Some(&manifest), &disabled)
            .is_err());

        // manifest 整个找不到 → 拒绝（确认不了就不放行）。
        assert!(tool
            .check_authorized(capability, None, &AppSettings::default())
            .is_err());
    }

    /// `kind=ssh` 的具体场景：没有 `ssh.exec` 的授权时，远端起命令的能力一点
    /// 都不能给 —— 未声明、以及被用户收回，两种都要拦住。
    #[test]
    fn ssh_tool_denied_without_the_ssh_exec_capability() {
        let tool = PluginAgentTool::new(&make_def("t", "top -bn1", Disposition::Allow), "p");
        let capability = tool.required_capability().unwrap();

        // 只声明了查询类能力 → 拒绝。
        assert!(tool
            .check_authorized(
                capability,
                Some(&manifest_with(&["ssh.list"])),
                &AppSettings::default()
            )
            .is_err());

        // 声明了 ssh.exec，但用户在设置页把它收回 → 同样拒绝。
        let mut revoked = AppSettings::default();
        revoked
            .authorized_capabilities
            .insert("p".into(), vec!["ssh.list".into()]);
        assert!(tool
            .check_authorized(
                capability,
                Some(&manifest_with(&["ssh.list", "ssh.exec"])),
                &revoked
            )
            .is_err());

        // 声明 + 授权齐全 → 放行（两条路径的共同前置条件）。
        assert!(tool
            .check_authorized(
                capability,
                Some(&manifest_with(&["ssh.exec"])),
                &AppSettings::default()
            )
            .is_ok());
    }
}
