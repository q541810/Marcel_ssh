use async_trait::async_trait;
use serde_json::Value;

use crate::agent::sandbox::{RiskLevel, Sandbox};
use crate::agent::tools::{local_handlers, truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;
use crate::plugins::manifest::PluginAgentToolDef;

/// Current session context used for template-variable substitution.
/// Extracted from [`ToolContext`] once per tool call; missing values (e.g.
/// no active session) fall back to empty strings and emit a warn log.
struct SessionContext {
    host: String,
    port: String,
    /// `host_port` joined with `_` (e.g. `1.2.3.4_22`). Used as an isolation
    /// key for per-connection files. Distinct from the `host:port` form
    /// returned by the `host_port` handler (used for display).
    host_port: String,
    session_id: String,
    connection_id: String,
    username: String,
    timestamp: String,
}

/// Extract session context from the ToolContext. Returns `None` if the
/// session does not exist (e.g. it was closed mid-task); callers fall back
/// to empty strings and log a warning.
async fn extract_session_context(ctx: &ToolContext) -> Option<SessionContext> {
    let info = ctx.ssh.get_session_info(&ctx.session_id).await?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();
    Some(SessionContext {
        host: info.host.clone(),
        port: info.port.to_string(),
        host_port: format!("{}_{}", info.host, info.port),
        session_id: ctx.session_id.clone(),
        connection_id: info.connection_id.clone().unwrap_or_default(),
        username: info.username.clone(),
        timestamp,
    })
}

/// Replace all 7 context variables in the given string. Called after the
/// session context is known, before model-supplied params are substituted.
fn apply_context_variables(s: &str, ctx: &SessionContext) -> String {
    s.replace("{{__host__}}", &ctx.host)
        .replace("{{__port__}}", &ctx.port)
        .replace("{{__host_port__}}", &ctx.host_port)
        .replace("{{__session_id__}}", &ctx.session_id)
        .replace("{{__connection_id__}}", &ctx.connection_id)
        .replace("{{__username__}}", &ctx.username)
        .replace("{{__timestamp__}}", &ctx.timestamp)
}

/// Replace context variables in every string value of a JSON object (top-level
/// only). Used to preprocess `kind=local` handler params so that fixed path
/// templates like `memories/{{__host_port__}}.jsonl` are resolved before the
/// handler sees them.
fn apply_context_variables_to_params(params: &mut Value, ctx: &SessionContext) {
    if let Some(obj) = params.as_object_mut() {
        for (_, val) in obj.iter_mut() {
            if let Some(s) = val.as_str() {
                *val = Value::String(apply_context_variables(s, ctx));
            }
        }
    }
}

pub struct PluginAgentTool {
    name: String,
    description: String,
    command_template: String,
    parameters: Value,
    risk_level: RiskLevel,
    /// `"ssh"` (default) or `"local"`.
    kind: String,
    /// Required when `kind = "local"`. Names a kernel-registered handler.
    handler: Option<String>,
    /// Owning plugin id. Injected as `__plugin_id` into handler params so
    /// fs handlers can resolve paths under the plugin's own directory.
    plugin_id: String,
    /// Capabilities declared by the owning plugin. Used for capability
    /// checks before invoking a `kind=local` handler.
    plugin_capabilities: Vec<String>,
    /// For `kind=local`: a JSON object parsed from the `command` field,
    /// containing fixed params the model cannot override (e.g. `path`).
    /// Empty object for `kind=ssh` or when `command` is not valid JSON.
    fixed_params: Value,
}

impl PluginAgentTool {
    pub fn new(def: &PluginAgentToolDef, plugin_id: &str, plugin_capabilities: &[String]) -> Self {
        let risk = match def.risk_level.as_str() {
            "ReadOnly" => RiskLevel::ReadOnly,
            "LowRisk" => RiskLevel::LowRisk,
            "HighRisk" => RiskLevel::HighRisk,
            _ => RiskLevel::Moderate,
        };
        // For kind=local, the `command` field is repurposed as a JSON object
        // string of fixed params (e.g. `{"path":"memories/{{__host_port__}}.jsonl"}`).
        // This lets plugins inject path templates the model cannot override,
        // without adding a new manifest field. For kind=ssh the field is
        // used as the SSH command template and is NOT parsed as JSON.
        let fixed_params = if def.kind == "local" && !def.command.is_empty() {
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
            risk_level: risk,
            kind: def.kind.clone(),
            handler: def.handler.clone(),
            plugin_id: plugin_id.to_string(),
            plugin_capabilities: plugin_capabilities.to_vec(),
            fixed_params,
        }
    }

    /// Render the SSH command template by injecting context variables first
    /// (so the model cannot override `{{__host__}}` etc.), then substituting
    /// model-supplied params. `session_ctx=None` falls back to empty strings
    /// for all context variables.
    fn render_command(&self, params: &Value, session_ctx: Option<&SessionContext>) -> String {
        let mut cmd = self.command_template.clone();
        // 1. Inject context variables FIRST — model cannot override them.
        if let Some(sctx) = session_ctx {
            cmd = apply_context_variables(&cmd, sctx);
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

    /// Execute a `kind=local` tool: capability check → handler lookup →
    /// fixed-params merge → context-variable substitution → handler call.
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

        // Capability check: the plugin must declare the capability required
        // by the named handler. Unknown handler names are rejected here too.
        match local_handlers::required_capability(handler_name) {
            Some(required) => {
                if !self.plugin_capabilities.iter().any(|c| c == required) {
                    return Ok(ToolOutput::fail(
                        "capability 不足",
                        format!(
                            "工具 {} 需要 capability `{}` 但插件 {} 未声明",
                            self.name, required, self.plugin_id
                        ),
                    ));
                }
            }
            None => {
                return Ok(ToolOutput::fail(
                    "handler 未注册",
                    format!("handler `{}` 未在内核注册", handler_name),
                ));
            }
        }

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
            apply_context_variables_to_params(&mut params, sctx);
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

    fn risk_level(&self) -> RiskLevel {
        self.risk_level
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        // kind=local: dispatch to the registered local handler.
        if self.kind == "local" {
            return self.execute_local(params, ctx).await;
        }

        // kind=ssh: original logic — render template, sandbox-check, exec.
        let session_ctx = extract_session_context(ctx).await;
        if session_ctx.is_none() {
            log::warn!(
                "插件工具 {} 无法获取会话上下文，上下文变量替换为空字符串",
                self.name
            );
        }
        let command = self.render_command(&params, session_ctx.as_ref());

        let sandbox = ctx
            .policy
            .as_ref()
            .map(|p| Sandbox::new((**p).clone()))
            .unwrap_or_default();
        let risk = sandbox.check_command(&command)?;
        if risk == RiskLevel::HighRisk {
            return Ok(ToolOutput::fail(
                "Blocked by sandbox",
                format!(
                    "命令被安全沙箱拒绝（插件工具: {}）。\n命令: {}",
                    self.name, command
                ),
            ));
        }

        let output = ctx.exec(&command).await?;
        let truncated = truncate_output(output, 8_000);
        Ok(ToolOutput::ok(
            format!("插件工具 {} 执行完成", self.name),
            truncated,
        ))
    }
}

pub fn register_plugin_tools(
    registry: &mut crate::agent::tools::ToolRegistry,
    plugin_id: &str,
    plugin_capabilities: &[String],
    tools: &[PluginAgentToolDef],
) {
    for def in tools {
        registry.register(std::sync::Arc::new(PluginAgentTool::new(
            def,
            plugin_id,
            plugin_capabilities,
        )));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_def(name: &str, cmd: &str, risk: &str) -> PluginAgentToolDef {
        PluginAgentToolDef {
            name: name.into(),
            description: "test".into(),
            command: cmd.into(),
            kind: "ssh".into(),
            handler: None,
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "arg": { "type": "string" }
                }
            }),
            risk_level: risk.into(),
        }
    }

    fn make_local_def(name: &str, handler: &str, command: &str) -> PluginAgentToolDef {
        PluginAgentToolDef {
            name: name.into(),
            description: "test local".into(),
            command: command.into(),
            kind: "local".into(),
            handler: Some(handler.into()),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "entry": { "type": "string" }
                }
            }),
            risk_level: "LowRisk".into(),
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
        let tool = PluginAgentTool::new(&make_def("test", "echo {{arg}}", "ReadOnly"), "p", &[]);
        let cmd = tool.render_command(&serde_json::json!({ "arg": "hello" }), None);
        assert_eq!(cmd, "echo hello");
    }

    #[test]
    fn render_command_handles_missing_params() {
        let tool = PluginAgentTool::new(&make_def("test", "echo {{arg}}", "ReadOnly"), "p", &[]);
        let cmd = tool.render_command(&serde_json::json!({}), None);
        assert_eq!(cmd, "echo {{arg}}");
    }

    #[test]
    fn risk_level_parses_correctly() {
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", "ReadOnly"), "p", &[]).risk_level(),
            RiskLevel::ReadOnly
        );
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", "LowRisk"), "p", &[]).risk_level(),
            RiskLevel::LowRisk
        );
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", "HighRisk"), "p", &[]).risk_level(),
            RiskLevel::HighRisk
        );
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", "invalid"), "p", &[]).risk_level(),
            RiskLevel::Moderate
        );
    }

    #[test]
    fn null_parameters_defaults_to_empty_object() {
        let mut def = make_def("t", "cmd", "ReadOnly");
        def.parameters = Value::Null;
        let tool = PluginAgentTool::new(&def, "p", &[]);
        assert_eq!(tool.parameters_schema()["type"], "object");
    }

    // ── Context variable injection (Task 5) ──

    #[test]
    fn render_command_injects_context_variables() {
        let tool = PluginAgentTool::new(
            &make_def("test", "echo {{__host__}}:{{__port__}}", "ReadOnly"),
            "p",
            &[],
        );
        let sctx = make_session_ctx();
        let cmd = tool.render_command(&serde_json::json!({}), Some(&sctx));
        assert_eq!(cmd, "echo 1.2.3.4:22");
    }

    #[test]
    fn render_command_injects_host_port_with_underscore() {
        let tool = PluginAgentTool::new(
            &make_def("test", "cat {{__host_port__}}.log", "ReadOnly"),
            "p",
            &[],
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
            &make_def("test", "echo {{__host__}}", "ReadOnly"),
            "p",
            &[],
        );
        let sctx = make_session_ctx();
        let cmd = tool.render_command(
            &serde_json::json!({ "__host__": "evil.com" }),
            Some(&sctx),
        );
        assert_eq!(cmd, "echo 1.2.3.4");
    }

    #[test]
    fn render_command_no_session_replaces_with_empty() {
        let tool = PluginAgentTool::new(
            &make_def("test", "echo {{__host__}}:{{__port__}}", "ReadOnly"),
            "p",
            &[],
        );
        let cmd = tool.render_command(&serde_json::json!({}), None);
        assert_eq!(cmd, "echo :");
    }

    #[test]
    fn render_command_injects_timestamp() {
        let tool = PluginAgentTool::new(
            &make_def("test", "id mem_{{__timestamp__}}", "ReadOnly"),
            "p",
            &[],
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
        let tool = PluginAgentTool::new(&def, "mem-plugin", &[]);
        assert!(tool.fixed_params.is_object());
        assert_eq!(tool.fixed_params["path"], "memories/{{__host_port__}}.jsonl");
    }

    #[test]
    fn local_tool_invalid_json_command_yields_empty_fixed_params() {
        let def = make_local_def("bad", "fs.read", "not valid json");
        let tool = PluginAgentTool::new(&def, "p", &[]);
        assert!(tool
            .fixed_params
            .as_object()
            .is_some_and(|o| o.is_empty()));
    }

    #[test]
    fn local_tool_empty_command_yields_empty_fixed_params() {
        let def = make_local_def("empty", "fs.read", "");
        let tool = PluginAgentTool::new(&def, "p", &[]);
        assert!(tool
            .fixed_params
            .as_object()
            .is_some_and(|o| o.is_empty()));
    }

    #[test]
    fn ssh_tool_does_not_parse_command_as_json() {
        // kind=ssh: command is a shell template, not JSON. It must be stored
        // as command_template verbatim and fixed_params stays empty.
        let def = make_def("ssh_tool", "echo {{arg}}", "ReadOnly");
        let tool = PluginAgentTool::new(&def, "p", &[]);
        assert!(tool
            .fixed_params
            .as_object()
            .is_some_and(|o| o.is_empty()));
        assert_eq!(tool.command_template, "echo {{arg}}");
    }

    #[test]
    fn apply_context_variables_replaces_all_seven() {
        let sctx = make_session_ctx();
        let template = "{{__host__}} {{__port__}} {{__host_port__}} {{__session_id__}} {{__connection_id__}} {{__username__}} {{__timestamp__}}";
        let rendered = apply_context_variables(template, &sctx);
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
        apply_context_variables_to_params(&mut params, &sctx);
        assert_eq!(params["path"], "memories/1.2.3.4_22.jsonl");
        assert_eq!(params["content"], "id 1720000000");
        assert_eq!(params["count"], 42, "non-string values are not touched");
    }
}
