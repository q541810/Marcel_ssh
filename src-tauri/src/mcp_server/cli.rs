// MCP Server CLI 入口
//
// 用户以 `--mcp-server` 启动即进入无头 MCP 模式：**不启动 GUI**，把
// SSH / SFTP 能力通过 MCP 暴露给外部 agent。
//
// 两种传输：
//   --mcp-server            默认，stdio（客户端启动本进程并通过管道通信）
//   --mcp-server --mcp-http HTTP，本机端口 + 强制 Bearer 令牌
//
// stdio 是绝大多数客户端（Claude Code / zcode / DSH）的接入方式——
// 它们本来就是「启动子进程」的模型。HTTP 用于需要常驻服务、多方接入的场景，
// 但**多出一道认证边界**，见 `http_transport.rs` 顶部的安全说明。

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::command_exec::CommandExecutionManager;
use crate::config::connections::ConnectionStore;
use crate::config::persist::JsonPersistable;
use crate::mcp_server::stdio_transport;
use crate::mcp_server::{McpServer, McpServerConfig};
use crate::SshManager;

/// 检查命令行参数，如果包含 `--mcp-server` 则进入 MCP Server 模式
pub fn check_mcp_server_mode() -> bool {
    std::env::args().any(|arg| arg == "--mcp-server")
}

/// 是否走 HTTP 传输（`--mcp-http`）。
#[cfg(desktop)]
pub fn use_http_transport() -> bool {
    std::env::args().any(|arg| arg == "--mcp-http")
}

/// 运行 MCP Server（阻塞直到 stdin EOF）
///
/// **stdout 是协议通道**：这里（以及所有被调用到的代码）只允许往 stderr 写
/// 人看的日志，往 stdout 写一个字节都会破坏 JSON-RPC 流。`env_logger` 默认
/// 就是写 stderr，`eprintln!` 同理——不要在这一路径上换成 `println!`。
pub async fn run_mcp_server() -> Result<(), Box<dyn std::error::Error>> {
    // GUI 模式在 `marcel_ssh::run()` 里初始化日志；无头模式不走那条路，
    // 得自己初始化，否则排查问题时一片空白。
    // `default_filter_or("info")` 与 GUI 保持一致，`RUST_LOG` 可覆盖。
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    eprintln!("[Marcel SSH] Starting MCP Server mode...");

    // 加载配置目录
    let config_dir = get_config_dir();
    eprintln!("[Marcel SSH] Config directory: {}", config_dir.display());

    // 加载连接配置
    let connections_file = ConnectionStore::default_file(&config_dir);
    let connection_store = match ConnectionStore::load_from_path(&connections_file) {
        Ok(store) => {
            eprintln!(
                "[Marcel SSH] Loaded {} connections from {}",
                store.get_all().len(),
                connections_file.display()
            );
            store
        }
        Err(e) => {
            eprintln!(
                "[Marcel SSH] Warning: Failed to load connections ({}): {}",
                connections_file.display(),
                e
            );
            eprintln!("[Marcel SSH] Using empty connection store");
            ConnectionStore::new()
        }
    };

    let connection_store = Arc::new(RwLock::new(connection_store));

    // 主机密钥库：**必须与 GUI 同一个文件**。
    //
    // 这里曾经用 `SshManager::new()`——它建的是一个 `%TEMP%` 下的一次性
    // store（那个构造器自己的文档就写着「生产代码应当用 with_known_hosts」）。
    // 后果不是「少了个文件」而是**安全语义整个塌掉**：无头模式读不到用户既有的
    // known_hosts，于是每一台主机都被当成首次见到而走 TOFU 直接接受，
    // 「指纹不匹配一律拒绝」这条跨进程永远不会触发——服务器被换钥（MITM）
    // 会被静默接受，随后用密钥链里的凭据完成认证。必须读真实那份。
    let known_hosts = {
        let path = config_dir.join("known_hosts.json");
        match crate::ssh::known_hosts::KnownHostsStore::load(path.clone()).await {
            Ok(store) => {
                eprintln!("[Marcel SSH] Loaded known_hosts from {}", path.display());
                store
            }
            Err(e) => {
                // 读不出来时**不能**退化成「临时空表」——那等于把校验关掉。
                // 退到固定路径的 fallback（GUI 也是这么做的），至少同一台
                // 机器上多次运行之间是一致的，且会留下痕迹。
                let fallback = std::env::temp_dir().join("marcel-ssh-known-hosts-fallback.json");
                eprintln!(
                    "[Marcel SSH] 警告：读取 {} 失败（{}），本次改用 {}。\
                     主机密钥校验仍然生效，但这份记录与 GUI 的不共享。",
                    path.display(),
                    e,
                    fallback.display()
                );
                crate::ssh::known_hosts::KnownHostsStore::load(fallback).await?
            }
        }
    };

    let ssh_manager = Arc::new(SshManager::with_known_hosts(known_hosts));

    // 创建命令执行管理器（headless 模式，临时目录）
    let temp_dir = std::env::temp_dir().join("marcel-ssh-mcp");
    std::fs::create_dir_all(&temp_dir).ok();
    let command_exec = Arc::new(
        CommandExecutionManager::new(
            (*ssh_manager).clone(),
            temp_dir.join("jobs_temp"),
            temp_dir.join("ledger.jsonl"),
        )
        .await,
    );

    // 创建 MCP Server
    let config = McpServerConfig {
        name: "Marcel SSH MCP".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        log_external_calls: true,
    };

    let mut server = McpServer::new(config, ssh_manager, connection_store);

    // 注入 command_exec（用于工具调用）
    server.command_exec = Some(command_exec);
    // 注入配置目录：无头 agent 任务要读它来解析模型与 API Key（`agent_task` 工具）
    server.config_dir = Some(config_dir.clone());

    eprintln!(
        "[Marcel SSH] MCP Server ready: {} v{}",
        server.config.name, server.config.version
    );
    eprintln!("[Marcel SSH] Protocol: {}", server.protocol_version());

    // ── 传输选择 ──
    #[cfg(desktop)]
    if use_http_transport() {
        return run_http(&server).await;
    }

    eprintln!(
        "[Marcel SSH] Tools: 10 (list_connections, ssh_execute, get_working_directory, \
         create_connection, test_connection, sftp_upload, sftp_download, sftp_list, \
         sftp_delete, agent_task)"
    );
    eprintln!("[Marcel SSH] Listening on stdio...");

    // 运行 stdio transport（阻塞直到 EOF）
    stdio_transport::run_stdio_server(&server).await?;

    eprintln!("[Marcel SSH] MCP Server stopped");
    Ok(())
}

/// 启动 HTTP 传输。
///
/// 令牌优先级：`--mcp-token` > 自动生成。自动生成时**打印到 stderr**，
/// 用户要从那里抄走告诉客户端——这比允许空令牌安全得多。
#[cfg(desktop)]
async fn run_http(server: &McpServer) -> Result<(), Box<dyn std::error::Error>> {
    use crate::mcp_server::http_transport::{
        generate_token, HttpConfig, DEFAULT_BIND, DEFAULT_HTTP_PORT,
    };

    let bind_str = arg_value("--mcp-bind").unwrap_or_else(|| DEFAULT_BIND.to_string());
    let bind = bind_str
        .parse()
        .map_err(|e| format!("--mcp-bind 解析失败（{}）：{}", bind_str, e))?;

    let port = match arg_value("--mcp-port") {
        Some(p) => p
            .parse()
            .map_err(|e| format!("--mcp-port 解析失败（{}）：{}", p, e))?,
        None => DEFAULT_HTTP_PORT,
    };

    let generated = arg_value("--mcp-token").is_none();
    let token = arg_value("--mcp-token").unwrap_or_else(generate_token);

    if generated {
        eprintln!();
        eprintln!("[Marcel SSH] 已自动生成访问令牌（客户端需在 Authorization 头里带它）：");
        eprintln!();
        eprintln!("    {}", token);
        eprintln!();
        eprintln!("[Marcel SSH] 本次启动有效，重启会换新令牌。要固定下来请用 --mcp-token。");
        eprintln!();
    }

    let cfg = HttpConfig { bind, port, token };

    eprintln!(
        "[Marcel SSH] HTTP 端点: http://{}/mcp",
        cfg.socket_addr()
    );
    eprintln!(
        "[Marcel SSH] Tools: 10 (list_connections, ssh_execute, get_working_directory, \
         create_connection, test_connection, sftp_upload, sftp_download, sftp_list, \
         sftp_delete, agent_task)"
    );

    let result = server.run_http(cfg).await;

    // HTTP 是常驻服务，正常只在出错或收到信号时返回
    result?;
    Ok(())
}

/// 应用标识符。
///
/// **必须与 `tauri.conf.json` 的 `identifier` 逐字一致**：GUI 用 Tauri 的
/// `app_config_dir()`（= `{系统配置目录}/{identifier}`）定位配置目录，无头模式
/// 没有 Tauri 可问，只能自己拼同一条路径。拼错不会报错——只会读到空的目录、
/// 一条连接都看不见，然后让人以为是「连接没保存上」。
const APP_IDENTIFIER: &str = "com.marcel.ssh";

/// 解析配置目录。
///
/// 优先级：`--config-dir <path>` > 环境变量 `MARCEL_CONFIG_DIR` > 按平台按
/// 标识符推导（与 Tauri `app_config_dir()` 同规则）。
fn get_config_dir() -> PathBuf {
    if let Some(dir) = arg_value("--config-dir") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("MARCEL_CONFIG_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    default_config_dir()
}

/// 按平台推导默认配置目录（等价于 Tauri 的 `app_config_dir()`）。
fn default_config_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        // Windows 上 Tauri 用 Roaming AppData
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(APP_IDENTIFIER)
    }

    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("Library")
            .join("Application Support")
            .join(APP_IDENTIFIER)
    }

    #[cfg(target_os = "linux")]
    {
        // XDG_CONFIG_HOME 优先，未设则 ~/.config
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
            if !xdg.is_empty() {
                return PathBuf::from(xdg).join(APP_IDENTIFIER);
            }
        }
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".config")
            .join(APP_IDENTIFIER)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        PathBuf::from(".").join(APP_IDENTIFIER)
    }
}

/// 取 `--flag value` 形式的参数值。
fn arg_value(flag: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == flag {
            return args.next();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_dir_is_identifier_based() {
        // 配置目录必须以应用标识符结尾，否则会读到与 GUI 不同的目录
        let dir = default_config_dir();
        if dir != PathBuf::from(".") {
            assert_eq!(
                dir.file_name().and_then(|n| n.to_str()),
                Some(APP_IDENTIFIER),
                "配置目录必须以 identifier 结尾（与 tauri.conf.json 对齐）"
            );
        }
    }

    #[test]
    fn identifier_matches_tauri_conf() {
        // 这条断言是防「改了 tauri.conf.json 却忘了改这里」的护栏。
        // 读取 conf 文件，逐字比对 identifier。
        let conf = include_str!("../../tauri.conf.json");
        let expected = format!("\"identifier\": \"{}\"", APP_IDENTIFIER);
        assert!(
            conf.contains(&expected),
            "tauri.conf.json 的 identifier 与 APP_IDENTIFIER({}) 不一致；\
             两者必须相同，否则 MCP 无头模式读不到 GUI 保存的连接",
            APP_IDENTIFIER
        );
    }

    #[test]
    fn flag_detection_reads_argv() {
        // 仅验证函数可调用且不 panic（真实 argv 由进程决定）
        let _ = check_mcp_server_mode();
    }
}
