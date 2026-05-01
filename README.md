# Marcel SSH (玛瑟尔 SSH)

> **AI 原生 SSH 客户端，具备自主 Agent 操作能力**

---

## 快速开始

### 1. 安装依赖

双击运行：
```
install.cmd
```

或手动执行：
```bash
pnpm install
```

### 2. 启动应用

双击运行：
```
dev.cmd
```

首次启动需要 1-2 分钟编译 Rust 后端，之后启动只需几秒。

### 3. 仅预览前端 UI

如果只想在浏览器中查看界面（不启动完整应用）：
```
dev-frontend.cmd
```

然后打开 http://localhost:1420

---

## 项目特色

- **智能助手驱动**：内置 AI Agent，可自主理解意图、规划操作、在远程服务器上执行命令序列
- **三种操作模式**：手动模式 / 副驾驶模式 / 自主模式
- **安全沙箱**：命令风险评估、黑名单过滤、路径保护、操作审计
- **原生性能**：基于 Tauri 2 + Rust，打包体积 < 15MB，内存占用 < 80MB

---

## 技术栈

- **后端**：Rust + Tauri 2 + russh + tokio
- **前端**：React 18 + TypeScript + Vite 6 + TailwindCSS 4
- **终端**：xterm.js 5
- **状态管理**：Zustand

---

## 开发状态

**Phase 0 已完成**：
- ✅ 项目脚手架搭建
- ✅ 完整的模块架构（SSH / Agent / LLM / Config）
- ✅ 安全沙箱实现（含 11 个单元测试）
- ✅ 前端 UI 组件（终端 / 智能助手 / 连接管理）
- ✅ 界面中文化
- ✅ 构建验证通过（Rust + TypeScript）

**Phase 1 待实现**：
- 🚧 真实 SSH 连接（russh 集成）
- 🚧 PTY 通道与双向数据流
- 🚧 LLM Provider 实现（OpenAI / Anthropic / Ollama）
- 🚧 Agent 工具系统执行

---

## 项目结构

```
marcel-ssh/
├── src-tauri/          # Rust 后端
│   ├── src/
│   │   ├── ssh/        # SSH 连接管理
│   │   ├── agent/      # Agent 运行时 + 工具系统 + 安全沙箱
│   │   ├── llm/        # LLM Provider 抽象
│   │   ├── config/     # 配置与持久化
│   │   └── commands/   # Tauri IPC 命令
│   └── Cargo.toml
│
├── src/                # React 前端
│   ├── components/
│   │   ├── terminal/   # 终端组件
│   │   ├── agent/      # 智能助手面板
│   │   ├── connection/ # 连接管理
│   │   └── ui/         # 通用 UI 组件
│   ├── hooks/          # useSSH, useAgent, useTerminal
│   ├── stores/         # Zustand 状态管理
│   └── lib/            # 类型定义 + Tauri IPC 封装
│
├── dev.cmd             # 启动脚本（完整应用）
├── dev-frontend.cmd    # 启动脚本（仅前端预览）
├── install.cmd         # 依赖安装脚本
├── AGENTS.md           # 架构设计文档
└── package.json
```

---

## 命令参考

```bash
# 开发模式（完整应用）
dev.cmd

# 仅前端预览
dev-frontend.cmd

# 安装依赖
install.cmd

# 手动命令
pnpm install          # 安装依赖
pnpm dev              # 启动 Vite dev server
pnpm build            # 构建前端
pnpm tauri dev        # 启动 Tauri 开发模式
pnpm tauri build      # 打包生产版本

# Rust 测试
cd src-tauri
cargo test            # 运行单元测试
cargo check           # 类型检查
cargo build --release # 发布构建
```
n## 系统要求

- **Node.js** 18+ (推荐 LTS)
- **Rust** 1.77+ (通过 [rustup.rs](https://rustup.rs) 安装)
- **pnpm** 8+ (自动通过 install.cmd 安装)
- **Windows 10/11** (需要 WebView2 运行时，通常已预装)

---

## 许可证

MIT

---

## 相关文档

- [AGENTS.md](./AGENTS.md) - 完整架构设计文档
- [Tauri 文档](https://v2.tauri.app/)
- [xterm.js 文档](https://xtermjs.org/)
