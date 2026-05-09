# AGENTS.md — Marcel SSH (玛瑟尔 SSH)

> **AI-Native SSH Client with Autonomous Agent Operations**
> 以 Agent 自动化操作为核心差异化的下一代 SSH 终端工具。

---

## 1. 项目定位

- **Agent-First**：内置 AI Agent 能力，可自主理解用户意图、规划操作步骤、在远程服务器上自动执行命令序列。
- **人机协同终端**：用户可在传统手动终端和 Agent 自动模式之间无缝切换。Agent 操作全程可观察、可中断、可回滚。
- **桌面级体验**：基于 Tauri 构建，提供原生级性能和系统集成，同时保持极小的资源占用。

---

## 2. 技术栈

### 核心框架

```
Tauri 2.x (Rust 后端 + WebView 前端)
├── 后端 (Rust)
│   ├── tauri             — 应用框架、窗口管理、IPC
│   ├── russh             — SSH 协议实现
│   ├── tokio             — 异步运行时
│   ├── serde / serde_json— 序列化
│   ├── rusqlite          — 本地数据持久化
│   └── keyring           — 系统密钥链集成
│
├── 前端 (TypeScript)
│   ├── React 18          — UI 框架
│   ├── xterm.js          — 终端模拟器渲染
│   ├── TailwindCSS 4     — 样式系统
│   ├── Zustand           — 状态管理
│   └── @tauri-apps/api   — Tauri 前端 API 绑定
│
└── Agent 层
    ├── OpenAI 兼容 API 接入
    ├── Tool-Use 协议实现
    └── Conversation & Context 管理
```

### 构建工具

- **前端**：Vite 6+, pnpm
- **后端**：Cargo (Rust 2021 edition)
- **测试**：Vitest (前端), `cargo test` (Rust)
- **Lint**：ESLint + Prettier (前端), clippy + rustfmt (Rust)

---

## 3. 系统架构

### 3.1 进程模型

```
Tauri 主进程 (Rust)
├── SSH 连接管理器
├── Agent Runtime
└── 系统服务 (密钥/配置/日志)
        │
        │ IPC (Tauri Commands + Events)
        ▼
WebView 渲染进程 (前端)
├── Terminal (xterm.js)
├── Agent UI Panel
└── Connection Manager UI

外部连接:
├── 远程 SSH 服务器
└── LLM Provider (云端/本地)
```

### 3.2 核心模块划分

| 模块                | 层    | 职责                        |
| ----------------- | ---- | ------------------------- |
| `ssh-core`        | Rust | SSH 连接建立、认证、通道管理、SFTP     |
| `agent-runtime`   | Rust | Agent 生命周期管理、Tool 调度、安全沙箱 |
| `llm-bridge`      | Rust | LLM API 调用抽象、流式响应处理       |
| `session-manager` | Rust | 多会话/多标签管理、会话持久化           |
| `config-store`    | Rust | 连接配置、密钥管理、偏好设置            |
| `skills-store`    | Rust | 用户自定义技能（Skill）CRUD 与持久化   |
| `terminal-view`   | 前端   | xterm.js 封装、输入输出流绑定       |
| `agent-panel`     | 前端   | Agent 对话界面、操作审批 UI、执行日志   |
| `connection-ui`   | 前端   | 连接列表、快速连接、分组管理            |
| `skill-ui`        | 前端   | 技能列表、创建/编辑/启用/禁用          |

---

## 4. Agent 自动化系统（核心差异化）

这是 Marcel SSH 的灵魂。Agent 系统的设计原则：

### 4.1 Agent 操作模式

- **Chat 模式**：纯对话，AI 仅回答问题，不触发工具调用或命令执行。
- **Agent 模式**（默认）：AI 可调用工具执行命令，受黑白名单策略控制，中高风险操作需用户确认。
- **Auto 模式**：全自主模式，AI 无需确认直接执行所有工具调用。

### 4.2 Tool-Use 架构

Agent 通过一组预定义的 **Tools** 与远程服务器交互：

```rust
// 核心 Tool 定义示例（Rust 侧）
pub trait AgentTool: Send + Sync {
    /// 工具名称，供 LLM 引用
    fn name(&self) -> &str;
    /// JSON Schema 描述参数
    fn parameters_schema(&self) -> serde_json::Value;
    async fn execute(&self, params: serde_json::Value, ctx: &SessionContext) -> Result<ToolOutput, AgentError>;
    fn risk_level(&self) -> RiskLevel;
}

pub enum RiskLevel {
    ReadOnly,      // ls, cat, pwd — 无需确认
    LowRisk,       // mkdir, touch — 简单确认
    Moderate,      // 文件编辑、服务重启 — 详细确认
    HighRisk,      // rm -rf, 权限变更 — 强制确认 + 二次验证
    Destructive,   // 格式化磁盘等 — 默认禁止，需手动解锁
}
```

**内置 Tools 列表**（12 个，在 `agent/tools/` 模块和 `commands/agent.rs` 中定义）：

| Tool 名称              | 功能                    | 风险等级        | 实现方式                           |
| -------------------- | --------------------- | ----------- | ------------------------------ |
| `execute_command`    | 在远程 shell 执行单条命令      | 取决于命令（动态评估） | `agent/tools/execute_cmd.rs`   |
| `read_file`          | 读取远程文件（`cat`）         | ReadOnly    | `agent/tools/file_ops.rs`      |
| `write_file`         | 写入/创建远程文件（heredoc）    | Moderate    | `agent/tools/file_ops.rs`      |
| `edit_file`          | 编辑远程文件（diff patch）    | Moderate    | `agent/tools/file_ops.rs`      |
| `list_directory`     | 列出目录内容（`ls -la`）      | ReadOnly    | `agent/tools/file_ops.rs`      |
| `upload_file`        | 上传本地文件到远程（SFTP）       | Moderate    | `agent/tools/sftp_transfer.rs` |
| `download_file`      | 下载远程文件到本地（SFTP）       | ReadOnly    | `agent/tools/sftp_transfer.rs` |
| `search_files`       | 内容搜索（`grep -rn`）      | ReadOnly    | `agent/tools/search.rs`        |
| `process_management` | 查看/管理远程进程             | ReadOnly    | `agent/tools/process.rs`       |
| `system_info`        | OS / 内存 / 磁盘信息查询      | ReadOnly    | `agent/tools/system.rs`        |
| `web_search`         | 联网搜索互联网信息（返回标题+摘要+链接） | ReadOnly    | `agent/tools/web_search.rs`    |
| `http_get`           | 获取网页完整内容              | ReadOnly    | `agent/tools/http_get.rs`      |
| `create_plan`        | 创建结构化任务计划（todolist）   | ReadOnly    | `agent/tools/plan.rs`          |
| `update_plan_item`   | 更新任务计划中步骤的状态          | ReadOnly    | `agent/tools/plan.rs`          |

> **架构要点**：工具通过 `AgentTool` trait 实现，注册到 `ToolRegistry::with_builtins()` 中。Agent 循环 `run_agent_loop()` 负责 LLM 调用、工具派发、安全策略检查和结果反馈。新增工具需：
> 
> 1. 在 `agent/tools/<name>.rs` 实现 `AgentTool` trait
> 2. 在 `mod.rs` 中声明模块并在 `with_builtins()` 注册
> 3. 在本表中登记

> **联网工具使用模式**：`web_search` 返回搜索结果摘要（标题+链接），**不包含完整页面内容**。如需阅读详细信息，Agent 应使用 `http_get` 工具访问搜索返回的 URL。这种"信息饥饿"设计让 Agent 自然地组合两个工具，同时节省上下文窗口。

### 4.3 上下文管理

Agent 维护以下上下文，用于每次 LLM 调用：

```
SessionContext {
    // 服务器环境快照
    os_info: String,           // uname -a
    shell_type: Shell,         // bash / zsh / fish
    current_directory: Path,
    environment_vars: HashMap,

    // 会话历史
    command_history: Vec<CommandRecord>,  // 最近 N 条命令 + 输出
    file_changes: Vec<FileChange>,       // 本次会话修改过的文件

    // 用户意图
    current_goal: String,
    task_plan: Vec<TaskStep>,

    // 安全上下文
    permission_policy: PermissionPolicy,
    confirmed_operations: Vec<OperationId>,
}
```

---

## 5. 项目目录结构

```
marcel-ssh/
├── src-tauri/                    # Rust 后端（Tauri 核心）
│   ├── src/
│   │   ├── commands/             # Tauri IPC command handlers
│   │   │   ├── ssh.rs            # SSH 连接相关命令
│   │   │   ├── agent.rs          # Agent 操作命令
│   │   │   ├── config.rs         # 配置管理命令
│   │   │   └── quick_command.rs  # 快捷指令管理命令
│   │   ├── ssh/                  # SSH 核心实现
│   │   │   ├── connection.rs     # 连接建立与管理
│   │   │   ├── auth.rs           # 认证（密码/密钥/Agent）
│   │   │   ├── channel.rs        # Shell/Exec 通道
│   │   │   ├── sftp.rs           # SFTP 实现
│   │   │   └── pool.rs           # 连接池
│   │   ├── agent/                # Agent 自动化系统
│   │   │   ├── runtime.rs        # Agent 运行时主循环
│   │   │   ├── executor.rs       # 命令执行器
│   │   │   ├── tools/            # Tool 实现
│   │   │   ├── sandbox.rs        # 安全沙箱
│   │   │   ├── context.rs        # 上下文管理
│   │   │   └── audit.rs          # 审计日志
│   │   ├── llm/                  # LLM 接入层
│   │   │   ├── provider.rs       # Provider trait + 工厂
│   │   │   ├── openai.rs         # OpenAI 兼容 API
│   │   │   └── streaming.rs      # SSE 流式处理
│   │   ├── config/               # 配置与持久化
│   │   │   ├── settings.rs       # 应用设置
│   │   │   ├── connections.rs    # 连接配置存储
│   │   │   ├── quick_commands.rs # 全局/连接级快捷指令存储
│   │   │   └── keychain.rs       # 密钥链集成
│   │   └── error.rs              # 统一错误类型
│   └── tests/                    # Rust 集成测试
│
├── src/                          # 前端（TypeScript + React）
│   ├── components/
│   │   ├── terminal/             # 终端组件
│   │   ├── agent/                # 智能助手面板
│   │   ├── connection/           # 连接管理
│   │   ├── sftp/                 # 文件传输
│   │   ├── settings/             # 设置页面
│   │   └── ui/                   # 通用 UI 组件
│   ├── hooks/                    # useSSH, useAgent, useTerminal
│   ├── stores/                   # Zustand 状态管理
│   └── lib/                      # 类型定义 + Tauri IPC 封装
│
├── dev.cmd                       # 启动脚本（完整应用）
├── dev-frontend.cmd              # 启动脚本（仅前端预览）
├── install.cmd                   # 依赖安装脚本
├── AGENTS.md                     # 本文件
└── README.md
```

---

## 6. 开发规范

### 6.1 Rust 后端规范

**异步模型**：

- 所有 SSH 操作和 LLM 调用必须异步（`async fn`）。
- 使用 `tokio` 作为唯一异步运行时。
- 长时间运行的 Agent 任务使用 `tokio::spawn` 在独立 task 中执行，通过 Tauri Event 向前端推送进度。

**命名约定**：

- 模块名：`snake_case`
- 类型名：`PascalCase`
- 函数名：`snake_case`
- Tauri command：`snake_case`，前端调用时自动转换为 `camelCase`

**Tauri Command 模式**：

```rust
#[tauri::command]
async fn ssh_connect(
    state: tauri::State<'_, AppState>,
    config: ConnectionConfig,
) -> Result<SessionId, AppError> {
    // ...
}
```

**依赖管理**：

- 最小化依赖原则。引入新 crate 需在 PR 中说明必要性。
- 优先使用 Rust 标准库和 Tauri 内置功能。
- 密码学相关必须使用经过审计的库（`ring`, `rustls` 等）。

### 6.2 前端规范

**组件设计**：

- 使用函数式组件 + Hooks 模式。
- 组件文件名 `PascalCase.tsx`，每个组件一个文件。
- Props 类型使用 `interface`，在组件文件内定义。
- 避免超过 300 行的组件文件，及时拆分。

**状态管理原则**：

- 局部 UI 状态：`useState`
- 跨组件共享状态：Zustand store
- 服务端状态（SSH 会话等）：通过 Tauri command 查询，结合 store 缓存
- 禁止在 store 中存储可从其他状态派生的数据

**Tauri IPC 调用封装**：

```typescript
// lib/tauri.ts — 统一封装，带类型安全
import { invoke } from '@tauri-apps/api/core';

export async function sshConnect(config: ConnectionConfig): Promise<SessionId> {
  return invoke<SessionId>('ssh_connect', { config });
}
```

**样式规范**：

- TailwindCSS utility-first，避免自定义 CSS。
- 终端主题色采用 CSS 变量，支持用户自定义。

---

## 7. IPC 通信协议

前端与 Rust 后端通过 Tauri 的 command/event 机制通信。

### 7.1 Commands（请求-响应）

用于用户主动触发的操作：

```
ssh_connect(config) → SessionId
ssh_disconnect(session_id) → ()
ssh_send_input(session_id, data) → ()
ssh_resize(session_id, cols, rows) → ()
ssh_list_sessions() → Vec<String>
agent_start_task(session_id, prompt, mode, history) → TaskId
agent_stop_task(task_id) → ()
agent_approve_operation(task_id, operation_id) → ()
agent_reject_operation(task_id, operation_id) → ()
agent_check_command(command, mode) → CommandCheckResult
config_get_connections() → Vec<SavedConnection>
config_save_connection(connection) → ConnectionId
config_delete_connection(id) → ()
config_save_password(connection_id, password) → ()
config_get_password(connection_id) → Option<String>
config_delete_password(connection_id) → ()
config_save_llm_api_key(api_key) → ()
config_get_llm_api_key() → Option<String>
config_delete_llm_api_key() → ()
config_get_settings() → AppSettings
config_save_settings(settings) → ()
quick_command_list(session_key?) → Vec<QuickCommand>
quick_command_add(command) → QuickCommand
quick_command_update(id, patch) → ()
quick_command_delete(id) → ()
skill_list() → Vec<Skill>
skill_add(name, description, prompt) → Skill
skill_update(id, name?, description?, prompt?) → ()
skill_toggle(id) → ()
skill_delete(id) → ()
import_skill_file(fileData, fileName) → ParsedSkill  // 解析 .md 文件或 zip/.skill 压缩包中的 YAML frontmatter
```

### 7.2 Events（服务端推送）

用于实时数据流和状态变更通知：

```
ssh://output/{session_id}        — 终端输出流
ssh://status/{session_id}        — 连接状态变更
agent://stream/{task_id}         — Agent 统一流式事件（含文本/工具调用/审批请求/错误等）
```

---

## 8. 安全考量

1. **API Key 存储**：LLM API Key 存储在系统密钥链（macOS Keychain / Windows Credential Manager / Linux Secret Service），绝不明文写入配置文件。
2. **SSH 密钥**：私钥不经过 WebView 进程，仅在 Rust 侧内存中加载。
3. **Agent 沙箱**：Agent 无法绕过安全策略引擎直接执行命令。所有命令必须经过 `sandbox.rs` 审查。
4. **内存安全**：敏感数据（密码、密钥内容）使用 `zeroize` crate 在不再需要时清零内存。

---



## 9. 给 AI Agent 的指示

> 以下内容专门为参与此项目开发的 AI 编码助手编写。

当你在此项目中工作时：

1. **Tauri IPC 是前后端桥梁**：修改 Rust 侧的 command 签名时，必须同步更新前端的 `lib/tauri.ts` 类型定义。

2. **SSH 操作全部异步**：永远不要阻塞 Tauri 主线程。所有 SSH I/O 必须在 `tokio::spawn` 的 task 中执行。

3. **安全是不可协商的**：
   
   - 不要跳过安全检查来"简化"代码。
   - 不要在日志中输出密码、密钥或 API Key。
   - 不要将敏感数据序列化到前端。

4. **测试覆盖**：新增 Agent Tool 必须附带单元测试。安全相关变更必须有对应的测试验证策略是否正确执行。

5. **变更要求** 相关更改必须同步更新本文件（AGENTS.md）

6. 在创建工作环境或构建项目时，必须阅读 `README.md` 获取教程

7. 更改依赖包、更新配置文件、平台支持、构建生产版本等，必须同步更新 `README.md`

8. 本文件是 **绝对权威** 是 **不可违反** 的，必须遵循本文件（除非你把本文件改成符合你需求的样子）

9. 你不能执行任何预计耗时一秒以上的shell命令，但可以要求用户帮你执行
