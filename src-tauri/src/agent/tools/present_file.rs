//! `present_file` / `local_present_file` —— 把产出的文件「交付」给用户。
//!
//! agent 做完一份要给用户看的东西（报告、导出、文档……）后调用一次，界面据工具结果的
//! metadata 画一张「交付文件」卡片，带「打开 / 在文件管理器中显示 / 复制路径」等按钮。
//! 工具本身只做两件事：**核实路径真的存在**（避免 agent 凭空报一个不存在的文件），
//! 并把「这是哪一侧的哪个路径」结构化地交给前端。它不读内容、不改任何东西，所以
//! `Disposition::Allow`、Plan 模式也可用。
//!
//! ## 两个工具，同一套纯逻辑
//!
//! - `present_file`：远端（SSH 会话所在机器），可选 `host` 指向多机选集里的另一台机器
//!   （解析口径与 `bash` 一致：[`crate::multi_host::resolve_target`]）；
//! - `local_present_file`：用户自己这台电脑，只给本机子 agent（桌面专属，
//!   声明表里 `LocalSubOnly`，与其余 `local_*` 同族）。
//!
//! ## metadata（前端契约）
//!
//! ```json
//! { "kind": "presentFile", "path": "/data/out.csv", "isDir": false, "size": 1234,
//!   "side": "remote", "host": null, "title": "导出结果", "note": "共 12 行" }
//! ```
//!
//! - `path`：agent 给的绝对路径，只去掉末尾斜杠（根目录除外），不做符号链接解析；
//! - `host`：远端时 = 目标机器的**连接名**（与多机提示词里的机器名同一个标识符，
//!   即 `remote://<连接名>/...` 链接里的那个）；没传 `host`（= 当前会话机器）与
//!   本机一律 `null`；
//! - `size`：目录为 `null`。

use async_trait::async_trait;
use serde::Serialize;
use serde_json::json;

use crate::agent::risk::Disposition;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

/// 交付卡片的 metadata，字段即前端契约（camelCase）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentFileMeta {
    /// 恒为 `"presentFile"`，前端据此认出这是交付卡片。
    pub kind: &'static str,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    /// `"remote"` / `"local"`。
    pub side: &'static str,
    pub host: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
}

/// 解析后的调用参数。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PresentArgs {
    pub path: String,
    pub title: Option<String>,
    pub note: Option<String>,
}

fn non_empty(params: &serde_json::Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 去掉末尾的路径分隔符（根目录 `/`、盘符根 `C:/` 保留）。`backslash` 为真时
/// 把 `\` 也当分隔符（本机 Windows 路径）。
pub(crate) fn normalize_display_path(path: &str, backslash: bool) -> String {
    let is_sep = |c: char| c == '/' || (backslash && c == '\\');
    let trimmed = path.trim_end_matches(is_sep);
    if trimmed.is_empty() {
        // 全是分隔符（或空）：根目录。
        return if path.is_empty() {
            String::new()
        } else {
            "/".into()
        };
    }
    let bytes = trimmed.as_bytes();
    if backslash && bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return format!("{trimmed}/");
    }
    trimmed.to_string()
}

/// 解析并校验参数。`local` 决定「绝对路径」的判据与分隔符口径。
pub(crate) fn parse_args(params: &serde_json::Value, local: bool) -> Result<PresentArgs, String> {
    let raw = params
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if raw.is_empty() {
        return Err("缺少 path 参数".into());
    }
    let absolute = if local {
        std::path::Path::new(raw).is_absolute()
    } else {
        raw.starts_with('/')
    };
    if !absolute {
        return Err(format!("path 必须是绝对路径：{raw}"));
    }
    Ok(PresentArgs {
        path: normalize_display_path(raw, local),
        title: non_empty(params, "title"),
        note: non_empty(params, "note"),
    })
}

fn build_output(meta: PresentFileMeta) -> ToolOutput {
    let what = if meta.is_dir { "目录" } else { "文件" };
    let summary = format!("交付{what} {}", meta.path);
    let output = format!(
        "已在界面上向用户展示{what}卡片：{}。用户可直接打开，无需再把内容复述一遍。",
        meta.path
    );
    // 序列化纯数据结构不会失败。
    let value = serde_json::to_value(&meta).unwrap_or_else(|_| json!({}));
    ToolOutput::ok(summary, output).with_metadata(value)
}

fn missing_path_failure(path: &str, detail: &str) -> ToolOutput {
    ToolOutput::fail(
        format!("交付 {path}"),
        format!("路径不存在或无法访问：{path}（{detail}）。请确认文件已经生成、路径写对后再调用。"),
    )
}

fn parameters_schema(with_host: bool) -> serde_json::Value {
    let mut properties = json!({
        "path": { "type": "string", "description": "要交付的文件或目录的绝对路径" },
        "title": { "type": "string", "description": "可选。卡片上显示的短名称（如「周报」「导出结果」），省略时显示文件名" },
        "note": { "type": "string", "description": "可选。一句话说明这是什么（不要复述文件内容）" }
    });
    if with_host {
        properties["host"] = json!({
            "type": "string",
            "description": format!(
                "Optional. Target machine's readable name: the current machine or one from the multi-host selected set. When omitted, the file is on the current session's machine. {}",
                super::HOST_MATCH_RULE
            )
        });
    }
    json!({
        "type": "object",
        "properties": properties,
        "required": ["path"]
    })
}

// ───────────────────────────── 远端 ─────────────────────────────

pub struct PresentFileTool;

impl PresentFileTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for PresentFileTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for PresentFileTool {
    fn name(&self) -> &str {
        "present_file"
    }

    fn description(&self) -> &str {
        "把你在远端服务器上产出的文件（或目录）交付给用户：界面会显示一张可打开、可在文件管理器中显示的卡片。\
         产出了要给用户看的成果（报告、文档、导出结果）后调用一次；不是每改一个文件都调用，\
         只是提到的路径也不必调用。调用后回复正文里仍可按约定把它写成链接。路径不存在会报错。"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        parameters_schema(true)
    }

    fn disposition(&self) -> Disposition {
        Disposition::Allow
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let args = match parse_args(&params, false) {
            Ok(a) => a,
            Err(e) => return Ok(ToolOutput::fail("present_file", e)),
        };

        // 目标机器：口径与 bash 一致 —— host 非空就解析（失败是明确错误，绝不静默落回
        // 当前机）；省略 = 当前会话机器，metadata.host 为 null。
        let (session_id, host) = match crate::multi_host::optional_host(&params) {
            Some(host) => {
                let task_id = ctx.task_id.clone().unwrap_or_default();
                if task_id.is_empty() {
                    return Ok(ToolOutput::fail(
                        "present_file",
                        "多机操作需要任务上下文（缺少 task_id）",
                    ));
                }
                let resolved = crate::multi_host::resolve_target(
                    &ctx.app_handle,
                    &host,
                    &task_id,
                    &ctx.session_id,
                )
                .await?;
                (resolved.session_id, Some(resolved.host_label))
            }
            None => (ctx.session_id.clone(), None),
        };

        let stat_path = args.path.clone();
        let stat = ctx
            .ssh
            .with_shared_sftp(&session_id, |sftp| {
                let p = stat_path.clone();
                async move { sftp.metadata(p).await }
            })
            .await?;
        let metadata = match stat {
            Ok(m) => m,
            Err(e) => return Ok(missing_path_failure(&args.path, &e.to_string())),
        };
        let is_dir = metadata.is_dir();
        Ok(build_output(PresentFileMeta {
            kind: "presentFile",
            path: args.path,
            is_dir,
            size: if is_dir { None } else { Some(metadata.len()) },
            side: "remote",
            host,
            title: args.title,
            note: args.note,
        }))
    }
}

// ───────────────────────────── 本机 ─────────────────────────────

/// 本机版：路径在运行 Marcel SSH 的这台电脑上，只给本机子 agent。
#[cfg(desktop)]
pub struct LocalPresentFileTool;

#[cfg(desktop)]
impl LocalPresentFileTool {
    pub fn new() -> Self {
        Self
    }
}
#[cfg(desktop)]
impl Default for LocalPresentFileTool {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(desktop)]
#[async_trait]
impl AgentTool for LocalPresentFileTool {
    fn name(&self) -> &str {
        "local_present_file"
    }

    fn description(&self) -> &str {
        "把你在用户本机（运行 Marcel SSH 的这台电脑）上产出的文件（或目录）交付给用户：界面会显示一张可打开、\
         可在文件管理器中显示的卡片。产出了要给用户看的成果（报告、文档、导出结果）后调用一次；\
         不是每改一个文件都调用，只是提到的路径也不必调用。调用后回复正文里仍可按约定把它写成链接。路径不存在会报错。"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        parameters_schema(false)
    }

    fn disposition(&self) -> Disposition {
        Disposition::Allow
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        Ok(present_local(&params).await)
    }
}

/// `local_present_file` 的本体（不读 ctx，便于单测）。
#[cfg(desktop)]
async fn present_local(params: &serde_json::Value) -> ToolOutput {
    let args = match parse_args(params, true) {
        Ok(a) => a,
        Err(e) => return ToolOutput::fail("local_present_file", e),
    };
    // 与 local_target_exists 同口径：跟随符号链接。
    let metadata = match tokio::fs::metadata(&args.path).await {
        Ok(m) => m,
        Err(e) => return missing_path_failure(&args.path, &e.to_string()),
    };
    let is_dir = metadata.is_dir();
    build_output(PresentFileMeta {
        kind: "presentFile",
        path: args.path,
        is_dir,
        size: if is_dir { None } else { Some(metadata.len()) },
        side: "local",
        host: None,
        title: args.title,
        note: args.note,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_trailing_separators_but_keeps_roots() {
        assert_eq!(normalize_display_path("/data/out/", false), "/data/out");
        assert_eq!(normalize_display_path("/data/out///", false), "/data/out");
        assert_eq!(normalize_display_path("/", false), "/");
        assert_eq!(normalize_display_path("///", false), "/");
        assert_eq!(
            normalize_display_path("C:\\Users\\x\\", true),
            "C:\\Users\\x"
        );
        assert_eq!(normalize_display_path("C:/Users/x/", true), "C:/Users/x");
        assert_eq!(normalize_display_path("C:\\", true), "C:/");
        // 远端不把反斜杠当分隔符（它是 POSIX 文件名里的合法字符）。
        assert_eq!(normalize_display_path("/a/b\\", false), "/a/b\\");
    }

    #[test]
    fn parse_args_requires_absolute_path_and_trims_optionals() {
        let ok = parse_args(
            &json!({"path": " /srv/report.md ", "title": " 周报 ", "note": "  "}),
            false,
        )
        .unwrap();
        assert_eq!(ok.path, "/srv/report.md");
        assert_eq!(ok.title.as_deref(), Some("周报"));
        assert_eq!(ok.note, None, "纯空白的 note 视为未提供");

        assert!(parse_args(&json!({}), false).is_err());
        assert!(parse_args(&json!({"path": ""}), false).is_err());
        assert!(parse_args(&json!({"path": "relative/a.txt"}), false).is_err());
        assert!(parse_args(&json!({"path": "~/a.txt"}), false).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn parse_args_local_accepts_drive_paths() {
        let a = parse_args(&json!({"path": "C:/Users/x/out.csv"}), true).unwrap();
        assert_eq!(a.path, "C:/Users/x/out.csv");
        assert!(parse_args(&json!({"path": "out.csv"}), true).is_err());
    }

    #[test]
    fn metadata_serializes_in_the_frontend_contract_shape() {
        let out = build_output(PresentFileMeta {
            kind: "presentFile",
            path: "/data/out.csv".into(),
            is_dir: false,
            size: Some(1234),
            side: "remote",
            host: None,
            title: Some("导出结果".into()),
            note: None,
        });
        assert!(out.success);
        assert_eq!(
            out.metadata.unwrap(),
            json!({
                "kind": "presentFile",
                "path": "/data/out.csv",
                "isDir": false,
                "size": 1234,
                "side": "remote",
                "host": null,
                "title": "导出结果",
                "note": null
            })
        );
    }

    #[test]
    fn directory_metadata_has_null_size() {
        let out = build_output(PresentFileMeta {
            kind: "presentFile",
            path: "/data".into(),
            is_dir: true,
            size: None,
            side: "remote",
            host: Some("web-01".into()),
            title: None,
            note: None,
        });
        let meta = out.metadata.unwrap();
        assert_eq!(meta["isDir"], true);
        assert!(meta["size"].is_null());
        assert_eq!(meta["host"], "web-01");
    }

    #[test]
    fn missing_path_failure_tells_the_agent_in_chinese() {
        let out = missing_path_failure("/nope", "No such file");
        assert!(!out.success);
        assert!(out.output.contains("路径不存在"));
        assert!(out.output.contains("/nope"));
        assert!(out.metadata.is_none());
    }

    #[test]
    fn remote_schema_has_host_and_local_schema_does_not() {
        let remote = PresentFileTool::new().parameters_schema();
        assert!(remote["properties"].get("host").is_some());
        assert_eq!(remote["required"], json!(["path"]));
        let local = parameters_schema(false);
        assert!(local["properties"].get("host").is_none());
        assert_eq!(local["required"], json!(["path"]));
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn local_present_file_stats_files_dirs_and_rejects_missing() {
        let dir = std::env::temp_dir().join(format!("marcel-present-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();

        let out = present_local(&json!({"path": file.to_string_lossy(), "title": "t"})).await;
        assert!(out.success, "{}", out.output);
        let meta = out.metadata.unwrap();
        assert_eq!(meta["kind"], "presentFile");
        assert_eq!(meta["isDir"], false);
        assert_eq!(meta["size"], 5);
        assert_eq!(meta["side"], "local");
        assert!(meta["host"].is_null());
        assert_eq!(meta["title"], "t");

        // 目录：带末尾斜杠传入，metadata 里已规整，size 为 null。
        let with_slash = format!("{}/", dir.to_string_lossy());
        let out = present_local(&json!({"path": with_slash})).await;
        let meta = out.metadata.unwrap();
        assert_eq!(meta["isDir"], true);
        assert!(meta["size"].is_null());
        assert!(!meta["path"].as_str().unwrap().ends_with('/'));

        let gone = dir.join("missing.txt");
        let out = present_local(&json!({"path": gone.to_string_lossy()})).await;
        assert!(!out.success);
        assert!(out.output.contains("路径不存在"));
        assert!(out.metadata.is_none());

        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(LocalPresentFileTool::new().name(), "local_present_file");
    }
}
