# AGENTS.md — Marcel SSH (玛瑟尔 SSH)

> 以 Agent 自动化操作为核心差异化的下一代AI SSH 终端工具。

---


## 项目索引

- 后端：`src-tauri/src`
- Tauri command 注册：`src-tauri/src/lib.rs`
- SSH：`src-tauri/src/ssh`
- Agent：`src-tauri/src/agent`
- LLM：`src-tauri/src/llm`
- Commands：`src-tauri/src/commands`
- 前端入口：`src/main.tsx`、`src/App.tsx`
- Tauri IPC 封装：`src/lib/tauri.ts`
- 类型：`src/lib/types.ts`
- Stores：`src/stores`
- 终端：`src/components/terminal`
- Agent UI：`src/components/agent`
- SFTP：`src/components/sftp`
- Skills：`src/components/skill`

### 构建工具

- **前端**：Vite 6+, pnpm
- **后端**：Cargo (Rust 2021 edition)
- **测试**：Vitest (前端), `cargo test` (Rust)
- **Lint**：ESLint + Prettier (前端), clippy + rustfmt (Rust)
- **Windows 发布**：默认只构建/发布 NSIS 安装包，不发布 MSI，以控制安装包体积；如需 MSI，必须在发布前显式说明并临时调整 Tauri bundle target。

---

### Rust 后端规范

- SSH、LLM、Agent 长任务必须使用异步实现，统一基于 `tokio`。
- 长时间运行的 Agent 任务用 `tokio::spawn` 独立执行，并通过 Tauri Event 向前端推送进度。
- Tauri command 放在 `src-tauri/src/commands` 或相关模块中，并在 `src-tauri/src/lib.rs` 注册。
- 命名遵循 Rust 常规：模块/函数 `snake_case`，类型 `PascalCase`，Tauri command 使用 `snake_case`。
- 新增依赖要克制；优先使用标准库、Tauri 内置能力和项目已有依赖。
- 密码、SSH 私钥、API Key 等敏感数据不得写日志、不得传到 WebView、不得明文落配置。
- 涉及 Agent 工具、安全策略、SSH、密钥链的改动，必须优先考虑安全边界和回归测试。

---

### 前端规范

- 使用 React 函数组件和 Hooks，组件文件名用 `PascalCase.tsx`。
- 局部 UI 状态用 `useState`；跨组件共享状态用 Zustand；不要在 store 中保存可从其他状态派生的数据。
- Tauri IPC 调用统一通过 `src/lib/tauri.ts` 封装，保持类型安全，不要在组件里散落裸 `invoke`。
- 类型定义优先放在 `src/lib/types.ts` 或组件局部 `interface`，避免重复定义同一业务结构。
- 样式优先使用 TailwindCSS utility；终端主题色使用 CSS 变量，避免硬编码颜色。
- 组件过大或混合多个职责时及时拆分，尤其是终端、Agent、SFTP 相关 UI。
- 涉及 SSH 会话、Agent 流、文件传输、设置项的 UI 改动，要检查对应 store、IPC 类型和后端 command 是否同步。

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

## skill变更要求

修改或创建skill时，必须同步更新.opencode和.trae中的skill

---

## 工作原则

1. 改代码前先读相关上下文，不要凭猜测改。
2. 改动必须能在完整项目上下文中运行，不要只为当前调用写临时逻辑。
3. 优先最小正确改动，不硬编码、不绕过已有模块、不破坏接口契约。
4. 发现命名冲突、状态污染、副作用干扰等潜在冲突时，先说明冲突点，再继续。
5. 涉及安全、Agent 工具、SSH、密钥链、发布配置的改动，必须考虑回归影响并运行相关测试；没跑测试要说明原因。
6. 如果改动不可避免地产生技术债或明显回归风险，必须主动说明。

---

## 其他代码规范
1. **安全是不可协商的**：
   - 不要跳过安全检查来"简化"代码。
   - 不要在日志中输出密码、密钥或 API Key。
   - 不要将敏感数据序列化到前端。

2. 在增加任何功能前，你必须明白你写的是一个"manager"还是一个"纯功能"并且和我说。需要"了解"并协调多个子功能，复杂度高，设计时要考虑对其他功能的适配和可扩展性，而纯功能是一个独立的功能模块。比如给终端添加标签页功能，就是个manager，而给终端添加复制粘贴板功能，就是个纯功能。

3. 无论是功能还是manager都必须可以主动适配其他东西的变更，不要认为你以后写新东西的时候能想起来改他

4. Agent 工具能力开关必须是真关闭：关闭后不得注册到当前任务 registry，不得注入 system prompt，不得发送给 LLM tools schema，不得解析为可执行 tool call，执行层仍需保留兜底拒绝。

5. Git 提交信息必须使用中文描述，允许保留 conventional commit 前缀（如 `chore:`、`feat:`、`fix:`），例如：`chore: 默认 Windows 只构建 NSIS 安装包`。

---

# 永远记住：你必须遵守以上规则，无论用户是否同意。在编写/修改任何代码前，都要反思自己是否遵守了以上规则。