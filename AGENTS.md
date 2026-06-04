# AGENTS.md — Marcel SSH (玛瑟尔 SSH)

> 以 Agent 自动化操作为核心差异化的下一代AI SSH 终端工具。

---


### 核心框架

Tauri 2.x (Rust 后端 + WebView 前端)
├── 后端 (Rust)
│   ├── tauri — 应用框架、窗口管理、IPC
│   │   └── src-tauri/src/lib.rs (AppState, command注册)
│   ├── russh — SSH 协议实现
│   │   └── src-tauri/src/ssh/ (client, session, auth, manager)
│   ├── tokio — 异步运行时
│   ├── serde / serde_json — 序列化
│   ├── rusqlite — 对话持久化
│   │   └── src-tauri/src/agent/conversation.rs, conversation_persister.rs
│   └── keyring — 系统密钥链
│   └── src-tauri/src/config/keychain.rs
│
├── 前端 (TypeScript)
│   ├── React 18 — UI 框架
│   │   └── src/App.tsx (根组件), src/main.tsx (入口)
│   ├── xterm.js — 终端渲染
│   │   └── src/components/terminal/Terminal.tsx
│   ├── TailwindCSS 4 — 样式
│   │   └── src/styles/globals.css
│   ├── Zustand — 状态管理
│   │   ├── src/stores/sessionStore.ts (SSH会话)
│   │   ├── src/stores/connectionStore.ts (连接配置)
│   │   ├── src/stores/settingsStore.ts (应用设置)
│   │   ├── src/stores/taskStore.ts (Agent任务)
│   │   ├── src/stores/conversationStore.ts (Agent对话)
│   │   ├── src/stores/agentStore.ts (task+conversation组合)
│   │   ├── src/stores/agentStreamManager.ts + agentStreamHandlers.ts + storeStreamAdapter.ts (Agent流处理)
│   │   ├── src/stores/skillStore.ts (技能)
│   │   ├── src/stores/quickCommandStore.ts (快捷命令)
│   │   └── src/stores/messageConversion.ts (消息格式转换)
│   ├── @tauri-apps/api — IPC 封装
│   │   └── src/lib/tauri.ts (所有invoke调用)
│   ├── 类型定义
│   │   └── src/lib/types.ts
│   ├── 自定义Hooks
│   │   ├── src/hooks/useAgent.ts (Agent交互)
│   │   ├── src/hooks/useSessionLifecycle.ts (会话生命周期)
│   │   └── src/hooks/useClipboardHandler.ts (剪贴板)
│   └── UI组件
│       ├── src/components/agent/ (Agent面板、消息、审批)
│       ├── src/components/terminal/ (终端、标签页、快捷命令)
│       ├── src/components/connection/ (连接列表、表单)
│       ├── src/components/settings/ (设置页)
│       ├── src/components/sftp/ (文件管理器)
│       ├── src/components/skill/ (技能管理)
│       ├── src/components/nav/ (导航栏)
│       ├── src/components/layout/ (窗口控制)
│       └── src/components/ui/ (通用UI基础组件)
│
└── Agent 层
    ├── OpenAI 兼容 API 接入
    │   └── src-tauri/src/llm/ (openai, streaming, provider)
    ├── Tool-Use 协议实现
    │   └── src-tauri/src/agent/ (agent_loop, tool_dispatcher, tools/)
    ├── 安全沙箱
    │   └── src-tauri/src/agent/sandbox/ (checker, policy, risk_model)
    └── Tauri Commands
        └── src-tauri/src/commands/ (ssh, agent_lifecycle, connections, settings, sftp, skill...)

### 构建工具

- **前端**：Vite 6+, pnpm
- **后端**：Cargo (Rust 2021 edition)
- **测试**：Vitest (前端), `cargo test` (Rust)
- **Lint**：ESLint + Prettier (前端), clippy + rustfmt (Rust)

---

### Rust 后端规范

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

### 前端规范

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

## IPC 通信协议

前端与 Rust 后端通过 Tauri 的 command/event 机制通信。

---


## 安全考量

1. **API Key 存储**：LLM API Key 存储在系统密钥链（macOS Keychain / Windows Credential Manager / Linux Secret Service），绝不明文写入配置文件。
2. **SSH 密钥**：私钥不经过 WebView 进程，仅在 Rust 侧内存中加载。
3. **Agent 沙箱**：Agent 无法绕过安全策略引擎直接执行命令。所有命令必须经过 `sandbox.rs` 审查。
4. **内存安全**：敏感数据（密码、密钥内容）使用 `zeroize` crate 在不再需要时清零内存。

---

## 在编写/修改任何代码前，你必须遵守以下硬性约束：
1. 全局兼容性检查：新增或修改的代码必须与项目中已有所有功能在同一个运行时上下文中兼容共存。如果存在潜在冲突（如变量/函数重名、状态污染、副作用干扰其他功能），必须先指出冲突点并提出重构方案。
2. 禁止局部短视实现：不允许仅为了“当前调用能跑通”而写死临时逻辑、硬编码、破坏原有接口契约、或绕过已有模块。每次改动必须考虑未来扩展与可维护性。
3. 技术债影响评估：在你输出代码之前，必须显式列出本次改动可能产生的技术债（例如：重复逻辑、耦合增加、测试覆盖率下降、文档过时）。如果无法避免，需说明最少债务方案。
4. 回归风险声明：如果你认为新功能可能影响其他功能的运行，必须标注出受影响的功能模块名称以及建议的回归测试范围。
5. 拒绝“仅局部工作”的代码：如果代码只能在当前单一功能、单一场景、单一顺序下正常工作，而无法在完整项目上下文中运行，你必须拒绝输出，并解释原因。

---

## 其他代码规范
1. **安全是不可协商的**：
   - 不要跳过安全检查来"简化"代码。
   - 不要在日志中输出密码、密钥或 API Key。
   - 不要将敏感数据序列化到前端。

2. **变更要求** 相关更改必须同步更新本文件（AGENTS.md）

3. 修改或创建skill时，必须同步更新.opencode和.trae中的skill

4. 在增加任何功能前，你必须明白你写的是一个"manager"还是一个"纯功能"并且和我说。需要"了解"并协调多个子功能，复杂度高，设计时要考虑对其他功能的适配和可扩展性，而纯功能是一个独立的功能模块。比如给终端添加标签页功能，就是个manager，而给终端添加复制粘贴板功能，就是个纯功能。

5. 无论是功能还是manager都必须可以主动适配其他东西的变更，不要认为你以后写新东西的时候能想起来改他