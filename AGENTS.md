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

当你在此项目中工作时：

1. **Tauri IPC 是前后端桥梁**：修改 Rust 侧的 command 签名时，必须同步更新前端的 `lib/tauri.ts` 类型定义。

2. **SSH 操作全部异步**：永远不要阻塞 Tauri 主线程。所有 SSH I/O 必须在 `tokio::spawn` 的 task 中执行。

3. **安全是不可协商的**：
   - 不要跳过安全检查来"简化"代码。
   - 不要在日志中输出密码、密钥或 API Key。
   - 不要将敏感数据序列化到前端。

4. **变更要求** 相关更改必须同步更新本文件（AGENTS.md）

5. 修改或创建skill时，必须同步更新.opencode和.trae中的skill

6. 在增加任何功能前，你必须明白你写的是一个"manager"还是一个"纯功能"并且和用户说明。需要"了解"并协调多个子功能，复杂度高，设计时要考虑对其他功能的适配和可扩展性，而纯功能是一个独立的功能模块。比如给终端添加标签页功能，就是个manager，而给终端添加复制粘贴板功能，就是个纯功能。

7. 无论是功能还是manager都必须可以主动适配其他东西的变更，不要认为你以后写新东西的时候能想起来改他