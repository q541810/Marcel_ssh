#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 检查是否以 MCP Server 模式启动
    #[cfg(desktop)]
    if marcel_ssh::mcp_server::cli::check_mcp_server_mode() {
        // MCP Server 模式：不启动 GUI，通过 stdio 通信
        let runtime = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
        let result = runtime.block_on(marcel_ssh::mcp_server::cli::run_mcp_server());

        if let Err(e) = result {
            eprintln!("[Marcel SSH] MCP Server error: {}", e);
            std::process::exit(1);
        }
        return;
    }

    // 正常 GUI 模式
    marcel_ssh::run();
}
