# AGENTS.md — Marcel SSH (玛瑟尔 SSH)

> **AI-Native SSH Client with Autonomous Agent Operations**
> 以 Agent 自动化操作为核心差异化的下一代 SSH 终端工具。

---

## 1. 项目定位

Marcel SSH 不是又一个 SSH 客户端。它的核心价值主张是：

- **Agent-First**：内置 AI Agent 能力，可自主理解用户意图、规划操作步骤、在远程服务器上自动执行命令序列。类似 Claude Code 对本地开发环境的操控能力，Marcel SSH 将这种能力延伸到远程 SSH 会话中。
- **人机协同终端**：用户可在传统手动终端和 Agent 自动模式之间无缝切换。Agent 操作全程可观察、可中断、可回滚。
- **桌面级体验**：基于 Tauri 构建，提供原生级性能和系统集成，同时保持极小的资源占用。

### 与现有工具的差异

| 特性 | 传统 SSH 客户端 | Marcel SSH |
|------|----------------|------------|
| 命令执行 | 手动逐条输入 | Agent 自主规划 + 批量执行 |
| 错误处理 | 用户自行判断 | Agent 自动识别错误并尝试修复 |
| 上下文理解 | 无 | Agent 理解会话历史和服务器状态 |
| 操作模式 | 纯手动 | 手动 / Agent 辅助 / Agent 自主 |
| 安全审计 | 依赖外部工具 | 内置操作日志与权限沙箱 |

---

## 2. 技术栈

### 核心框架

```
Tauri 2.x (Rust 后端 + WebView 前端)
├── 后端 (Rust)
│   ├── tauri             — 应用框架、窗口管理、IPC
│   ├── russh / ssh2      — SSH 协议实现
│   ├── tokio             — 异步运行时
│   ├── serde / serde_json— 序列化
│   ├── sqlx / rusqlite   — 本地数据持久化
│   └── keyring           — 系统密钥链集成
│
├── 前端 (TypeScript)
│   ├── React 18+ / Solid — UI 框架（二选一，推荐 Solid 轻量）
│   ├── xterm.js          — 终端模拟器渲染
│   ├── TailwindCSS 4     — 样式系统
│   ├── Zustand / Jotai   — 状态管理
│   └── @tauri-apps/api   — Tauri 前端 API 绑定
│
└── Agent 层
    ├── LLM Provider 抽象层 (支持 OpenAI / Anthropic / Ollama 等)
    ├── Tool-Use 协议实现
    └── Conversation & Context 管理
```

### 构建工具

- **前端**：Vite 6+
- **后端**：Cargo (Rust 2021 edition)
- **包管理**：pnpm (前端), cargo (Rust)
- **测试**：Vitest (前端), `cargo test` (Rust)
- **Lint**：ESLint + Prettier (前端), clippy + rustfmt (Rust)

---

## 3. 系统架构

### 3.1 进程模型

```
┌─────────────────────────────────────────────────────┐
│                   Tauri 主进程 (Rust)                 │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ SSH 连接  │  │ Agent    │  │ 系统服务            │  │
│  │ 管理器   │  │ Runtime  │  │ (密钥/配置/日志)    │  │
│  └────┬─────┘  └────┬─────┘  └────────┬───────────┘  │
│       │              │                 │               │
│       └──────────────┼─────────────────┘               │
│                      │ IPC (Tauri Commands + Events)   │
├──────────────────────┼─────────────────────────────────┤
│                      │                                  │
│  ┌───────────────────┴──────────────────────────────┐  │
│  │              WebView 渲染进程 (前端)               │  │
│  │                                                    │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │  │
│  │  │ Terminal  │ │ Agent UI │ │ Connection       │  │  │
│  │  │ (xterm)  │ │ Panel    │ │ Manager UI       │  │  │
│  │  └──────────┘ └──────────┘ └──────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
   ┌──────────┐                  ┌──────────────┐
   │ 远程 SSH  │                  │ LLM Provider │
   │ 服务器    │                  │ (云端/本地)   │
   └──────────┘                  └──────────────┘
```

### 3.2 核心模块划分

| 模块 | 层 | 职责 |
|------|----|------|
| `ssh-core` | Rust | SSH 连接建立、认证、通道管理、SFTP |
| `agent-runtime` | Rust | Agent 生命周期管理、Tool 调度、安全沙箱 |
| `llm-bridge` | Rust | LLM API 调用抽象、流式响应处理、Token 计费 |
| `session-manager` | Rust | 多会话/多标签管理、会话持久化 |
| `config-store` | Rust | 连接配置、密钥管理、偏好设置 |
| `terminal-view` | 前端 | xterm.js 封装、输入输出流绑定 |
| `agent-panel` | 前端 | Agent 对话界面、操作审批 UI、执行日志 |
| `connection-ui` | 前端 | 连接列表、快速连接、分组管理 |

---

## 4. Agent 自动化系统（核心差异化）

这是 Marcel SSH 的灵魂。Agent 系统的设计原则：

### 4.1 设计原则

1. **可观察性 (Observable)**：Agent 的每一步思考和操作都实时展示给用户。
2. **可中断性 (Interruptible)**：用户随时可以暂停或终止 Agent 操作。
3. **可回滚性 (Reversible)**：危险操作前自动创建检查点，支持回滚。
4. **最小权限 (Least Privilege)**：Agent 默认只有读权限，写/执行操作需用户确认或预授权。
5. **上下文感知 (Context-Aware)**：Agent 理解当前服务器环境、历史命令、文件状态。

### 4.2 Agent 操作模式

```
┌─────────────────────────────────────────────┐
│             Agent 操作模式光谱                │
│                                               │
│  手动模式 ◄──────────────────► 全自主模式     │
│                                               │
│  ┌─────────┐  ┌───────────┐  ┌────────────┐ │
│  │ Manual  │  │ Copilot   │  │ Autonomous │ │
│  │         │  │           │  │            │ │
│  │ 用户手动 │  │ Agent建议  │  │ Agent自主   │ │
│  │ 操作终端 │  │ 用户确认   │  │ 执行任务链  │ │
│  │         │  │ 再执行     │  │ 仅汇报结果  │ │
│  └─────────┘  └───────────┘  └────────────┘ │
└─────────────────────────────────────────────┘
```

- **Manual 模式**：传统终端，Agent 仅作为旁观者积累上下文。
- **Copilot 模式**（默认）：用户用自然语言描述意图，Agent 生成命令计划，逐步确认执行。
- **Autonomous 模式**：用户设定目标，Agent 自主规划并执行完整操作序列。需要预先配置权限策略。

### 4.3 Tool-Use 架构

Agent 通过一组预定义的 **Tools** 与远程服务器交互：

```rust
// 核心 Tool 定义示例（Rust 侧）
pub trait AgentTool: Send + Sync {
    /// 工具名称，供 LLM 引用
    fn name(&self) -> &str;
    /// JSON Schema 描述参数
    fn parameters_schema(&self) -> serde_json::Value;
    /// 执行工具调用
    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &SessionContext,
    ) -> Result<ToolOutput, AgentError>;
    /// 该工具的风险等级
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

**内置 Tools 列表**：

| Tool 名称 | 功能 | 风险等级 |
|-----------|------|---------|
| `execute_command` | 在远程 shell 执行单条命令 | 取决于命令 |
| `read_file` | 读取远程文件内容 | ReadOnly |
| `write_file` | 写入/创建远程文件 | Moderate |
| `edit_file` | 精确编辑远程文件（diff-based） | Moderate |
| `list_directory` | 列出目录内容 | ReadOnly |
| `upload_file` | 通过 SFTP 上传本地文件 | LowRisk |
| `download_file` | 通过 SFTP 下载远程文件 | ReadOnly |
| `search_files` | 在远程文件系统中搜索 | ReadOnly |
| `process_management` | 查看/管理远程进程 | Moderate |
| `system_info` | 获取系统信息 | ReadOnly |

### 4.4 安全沙箱

```
┌─────────────────────────────────────────┐
│            安全策略引擎                   │
│                                           │
│  用户请求 ──► 意图解析 ──► 命令生成       │
│                              │             │
│                              ▼             │
│                      ┌──────────────┐     │
│                      │ 权限检查器    │     │
│                      │              │     │
│                      │ • 命令黑名单  │     │
│                      │ • 路径白名单  │     │
│                      │ • 风险评估    │     │
│                      │ • 用户策略    │     │
│                      └──────┬───────┘     │
│                             │              │
│                    ┌────────┴────────┐     │
│                    ▼                 ▼     │
│              ┌──────────┐    ┌─────────┐  │
│              │ 自动放行  │    │ 请求确认 │  │
│              │ (低风险)  │    │ (高风险) │  │
│              └──────────┘    └─────────┘  │
└─────────────────────────────────────────┘
```

**安全规则**：
- **命令黑名单**：`rm -rf /`, `mkfs`, `dd if=/dev/zero` 等破坏性命令默认永久禁止。
- **路径保护**：`/etc/`, `/boot/`, `/sys/` 等系统关键路径默认为只读。
- **操作速率限制**：Agent 单次任务最大命令数可配置（默认 50）。
- **超时机制**：单条命令默认 30s 超时，整个 Agent 任务默认 10min 超时。
- **审计日志**：所有 Agent 操作写入本地不可篡改日志，含时间戳、命令、输出、LLM 交互记录。

### 4.5 上下文管理

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
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/             # Tauri 2 权限声明
│   ├── src/
│   │   ├── main.rs               # 入口
│   │   ├── lib.rs                # 库导出
│   │   ├── commands/             # Tauri IPC command handlers
│   │   │   ├── mod.rs
│   │   │   ├── ssh.rs            # SSH 连接相关命令
│   │   │   ├── agent.rs          # Agent 操作命令
│   │   │   ├── config.rs         # 配置管理命令
│   │   │   └── sftp.rs           # 文件传输命令
│   │   ├── ssh/                  # SSH 核心实现
│   │   │   ├── mod.rs
│   │   │   ├── connection.rs     # 连接建立与管理
│   │   │   ├── auth.rs           # 认证（密码/密钥/Agent）
│   │   │   ├── channel.rs        # Shell/Exec 通道
│   │   │   ├── sftp.rs           # SFTP 实现
│   │   │   └── pool.rs           # 连接池
│   │   ├── agent/                # Agent 自动化系统
│   │   │   ├── mod.rs
│   │   │   ├── runtime.rs        # Agent 运行时主循环
│   │   │   ├── planner.rs        # 任务规划器
│   │   │   ├── executor.rs       # 命令执行器
│   │   │   ├── tools/            # Tool 实现
│   │   │   │   ├── mod.rs
│   │   │   │   ├── execute_cmd.rs
│   │   │   │   ├── file_ops.rs
│   │   │   │   ├── search.rs
│   │   │   │   └── system.rs
│   │   │   ├── sandbox.rs        # 安全沙箱
│   │   │   ├── context.rs        # 上下文管理
│   │   │   └── audit.rs          # 审计日志
│   │   ├── llm/                  # LLM 接入层
│   │   │   ├── mod.rs
│   │   │   ├── provider.rs       # Provider trait + 工厂
│   │   │   ├── openai.rs         # OpenAI 兼容 API
│   │   │   ├── anthropic.rs      # Anthropic Claude API
│   │   │   ├── ollama.rs         # 本地 Ollama
│   │   │   └── streaming.rs      # SSE 流式处理
│   │   ├── config/               # 配置与持久化
│   │   │   ├── mod.rs
│   │   │   ├── settings.rs       # 应用设置
│   │   │   ├── connections.rs    # 连接配置存储
│   │   │   └── keychain.rs       # 密钥链集成
│   │   └── error.rs              # 统一错误类型
│   └── tests/                    # Rust 集成测试
│
├── src/                          # 前端（TypeScript + React/Solid）
│   ├── index.html
│   ├── main.tsx                  # 前端入口
│   ├── App.tsx                   # 根组件
│   ├── components/
│   │   ├── terminal/
│   │   │   ├── Terminal.tsx       # xterm.js 封装
│   │   │   ├── TerminalTabs.tsx   # 多标签管理
│   │   │   └── TerminalToolbar.tsx
│   │   ├── agent/
│   │   │   ├── AgentPanel.tsx     # Agent 对话面板
│   │   │   ├── AgentMessage.tsx   # 消息气泡组件
│   │   │   ├── ApprovalDialog.tsx # 操作确认对话框
│   │   │   ├── TaskPlan.tsx       # 任务计划展示
│   │   │   └── AuditLog.tsx       # 操作日志查看器
│   │   ├── connection/
│   │   │   ├── ConnectionList.tsx # 连接列表侧边栏
│   │   │   ├── ConnectionForm.tsx # 连接编辑表单
│   │   │   └── QuickConnect.tsx   # 快速连接栏
│   │   ├── sftp/
│   │   │   ├── FileExplorer.tsx   # 远程文件浏览器
│   │   │   └── TransferQueue.tsx  # 传输队列
│   │   └── ui/                   # 通用 UI 组件
│   ├── hooks/                    # 自定义 Hooks
│   │   ├── useSSH.ts
│   │   ├── useAgent.ts
│   │   └── useTerminal.ts
│   ├── stores/                   # 状态管理
│   │   ├── connectionStore.ts
│   │   ├── sessionStore.ts
│   │   └── agentStore.ts
│   ├── lib/                      # 工具函数与类型
│   │   ├── tauri.ts              # Tauri IPC 封装
│   │   ├── types.ts              # 共享类型定义
│   │   └── constants.ts
│   └── styles/                   # 全局样式
│
├── package.json
├── pnpm-lock.yaml
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── eslint.config.js
├── AGENTS.md                     # 本文件
└── README.md
```

---

## 6. 开发规范

### 6.1 Rust 后端规范

**错误处理**：
- 使用 `thiserror` 定义模块级错误枚举，统一在 `error.rs` 中导出。
- Tauri command 返回 `Result<T, AppError>`，`AppError` 实现 `serde::Serialize`。
- 禁止在生产代码中使用 `.unwrap()` / `.expect()`（测试代码除外）。

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
- 局部 UI 状态：`useState` / `useSignal`
- 跨组件共享状态：Zustand store / Jotai atom
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
- 响应式布局适配不同窗口尺寸。

### 6.3 Git 规范

**分支策略**：
- `main`：稳定发布分支
- `develop`：开发集成分支
- `feature/<name>`：功能分支
- `fix/<name>`：修复分支

**Commit Message 格式**（Conventional Commits）：
```
<type>(<scope>): <description>

feat(agent): add file editing tool with diff-based patching
fix(ssh): handle connection timeout on slow networks
refactor(llm): extract streaming response parser
docs(agents): update tool-use architecture section
```

**Scope 列表**：`ssh`, `agent`, `llm`, `terminal`, `sftp`, `config`, `ui`, `build`

---

## 7. IPC 通信协议

前端与 Rust 后端通过 Tauri 的 command/event 机制通信。

### 7.1 Commands（请求-响应）

用于用户主动触发的操作：

```
ssh_connect(config) → SessionId
ssh_disconnect(session_id) → ()
ssh_send_input(session_id, data) → ()
agent_start_task(session_id, prompt, mode) → TaskId
agent_stop_task(task_id) → ()
agent_approve_operation(task_id, operation_id) → ()
agent_reject_operation(task_id, operation_id) → ()
sftp_list_dir(session_id, path) → Vec<FileEntry>
sftp_upload(session_id, local_path, remote_path) → TransferId
config_get_connections() → Vec<ConnectionConfig>
config_save_connection(config) → ConnectionId
```

### 7.2 Events（服务端推送）

用于实时数据流和状态变更通知：

```
ssh://output/{session_id}        — 终端输出流
ssh://status/{session_id}        — 连接状态变更
agent://thinking/{task_id}       — Agent 思考过程（流式）
agent://tool-call/{task_id}      — Agent 发起工具调用
agent://approval-needed/{task_id}— 需要用户确认的操作
agent://task-progress/{task_id}  — 任务进度更新
agent://task-complete/{task_id}  — 任务完成
agent://error/{task_id}          — Agent 错误
sftp://progress/{transfer_id}    — 文件传输进度
```

---

## 8. Agent 任务执行流程

```
用户输入自然语言指令
        │
        ▼
┌─────────────────┐
│ 1. 意图解析      │ ← LLM 理解用户目标
│    + 上下文注入   │ ← 注入服务器环境/历史
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 2. 任务规划      │ ← LLM 生成步骤计划
│    Task Plan     │    (展示给用户预览)
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────┐
│ 3. 逐步执行      │────►│ 安全检查     │
│    Tool Calls    │◄────│ 权限审批     │
└────────┬────────┘     └─────────────┘
         │
         │ (每步执行后)
         ▼
┌─────────────────┐
│ 4. 结果分析      │ ← LLM 判断是否成功
│    + 错误修复    │    失败则自动重试/调整
└────────┬────────┘
         │
         │ (循环直到目标完成或放弃)
         ▼
┌─────────────────┐
│ 5. 任务总结      │ ← 汇报执行结果
│    + 审计记录    │    写入审计日志
└─────────────────┘
```

---

## 9. 关键设计决策记录

### ADR-001: 为什么选择 Tauri 而非 Electron

- Tauri 的 Rust 后端天然适合 SSH 协议处理（性能、内存安全）。
- 打包体积远小于 Electron（~10MB vs ~150MB+）。
- Rust 生态有成熟的 SSH 库（`russh`）。
- 系统级密钥链访问更自然。

### ADR-002: LLM 调用放在 Rust 侧而非前端

- 避免 API Key 暴露在 WebView 进程中。
- Rust 侧可以直接将 LLM 输出接入 SSH channel，减少 IPC 开销。
- 统一的错误处理和重试逻辑。
- Token 计量和速率限制在后端更可控。

### ADR-003: Agent 操作确认采用异步审批模型

- Agent 发起操作 → 推送 `approval-needed` 事件 → 前端展示确认弹窗 → 用户确认/拒绝 → Agent 继续/跳过。
- 而非同步阻塞模型，因为用户可能不在窗口前（Autonomous 模式下可设置自动审批策略）。

### ADR-004: 终端输出与 Agent 上下文分离

- 原始终端输出流直接从 SSH channel 推送到 xterm.js，确保零延迟。
- Agent 上下文单独维护一份经过清洗的命令/输出历史（去除 ANSI 转义码、截断超长输出）。
- 两者通过 session_id 关联但独立管道，互不干扰。

---

## 10. 测试策略

| 层 | 测试类型 | 工具 | 覆盖重点 |
|----|---------|------|---------|
| Rust - SSH | 单元测试 + 集成测试 | `cargo test` + mock server | 连接建立、认证流程、通道管理 |
| Rust - Agent | 单元测试 | `cargo test` + mock LLM | Tool 执行、安全检查、上下文构建 |
| Rust - LLM | 集成测试 | `cargo test` (需 API key) | 流式解析、错误重试、Provider 切换 |
| 前端 - 组件 | 组件测试 | Vitest + Testing Library | 终端渲染、Agent 面板交互 |
| 前端 - Store | 单元测试 | Vitest | 状态流转正确性 |
| E2E | 端到端测试 | Tauri Driver / Playwright | 完整用户流程 |

---

## 11. 安全考量

1. **API Key 存储**：LLM API Key 存储在系统密钥链（macOS Keychain / Windows Credential Manager / Linux Secret Service），绝不明文写入配置文件。
2. **SSH 密钥**：私钥不经过 WebView 进程，仅在 Rust 侧内存中加载。
3. **Agent 沙箱**：Agent 无法绕过安全策略引擎直接执行命令。所有命令必须经过 `sandbox.rs` 审查。
4. **审计不可篡改**：审计日志使用 append-only 文件 + 哈希链（每条记录包含前一条的哈希），防止事后篡改。
5. **传输安全**：所有 LLM API 调用强制 HTTPS。SSH 连接严格验证 host key。
6. **内存安全**：敏感数据（密码、密钥内容）使用 `zeroize` crate 在不再需要时清零内存。

---

## 12. 性能目标

| 指标 | 目标 |
|------|------|
| 冷启动到可用 | < 2s |
| SSH 连接建立 | < 3s（网络正常时） |
| 终端输入延迟 | < 16ms（一帧） |
| Agent 首次响应 | < 2s（取决于 LLM API） |
| 内存占用（空闲） | < 80MB |
| 内存占用（10 会话） | < 200MB |
| 打包体积 | < 15MB |

---

## 13. 给 AI Agent 的指示

> 以下内容专门为参与此项目开发的 AI 编码助手编写。

当你在此项目中工作时：

1. **优先理解 Agent 系统**：这是核心差异化。任何涉及 `agent/` 目录的修改都需要格外谨慎，特别是安全沙箱 (`sandbox.rs`) 和权限检查相关逻辑。

2. **Tauri IPC 是前后端桥梁**：修改 Rust 侧的 command 签名时，必须同步更新前端的 `lib/tauri.ts` 类型定义。

3. **SSH 操作全部异步**：永远不要阻塞 Tauri 主线程。所有 SSH I/O 必须在 `tokio::spawn` 的 task 中执行。

4. **安全是不可协商的**：
   - 不要跳过安全检查来"简化"代码。
   - 不要在日志中输出密码、密钥或 API Key。
   - 不要将敏感数据序列化到前端。

5. **终端性能敏感**：`terminal-view` 组件是热路径。避免在终端输出的渲染路径上做任何不必要的计算或内存分配。

6. **测试覆盖**：新增 Agent Tool 必须附带单元测试。安全相关变更必须有对应的测试验证策略是否正确执行。

7. **中文注释可接受**：代码注释可以使用中文，但公开 API 文档和类型名必须使用英文。
