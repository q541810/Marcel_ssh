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

## 系统要求

### 必需环境

| 依赖 | 版本 | 安装方式 |
|------|------|----------|
| **Node.js** | 18+ (推荐 LTS) | [nodejs.org](https://nodejs.org/) |
| **pnpm** | 8+ | `npm install -g pnpm` 或运行 `install.cmd` |
| **Rust** | 1.77+ | [rustup.rs](https://rustup.rs/) |
| **WebView2** | 最新版 | Windows 10/11 通常已预装 |

### 可选依赖

| 依赖 | 用途 | 安装方式 |
|------|------|----------|
| **Visual Studio Build Tools** | Windows 编译 C++ 依赖 | [visualstudio.microsoft.com/visual-cpp-build-tools/](https://visualstudio.microsoft.com/visual-cpp-build-tools/) |
| **Git** | 版本控制 | [git-scm.com](https://git-scm.com/) |

### 平台支持

| 平台 | 支持状态 | 备注 |
|------|---------|------|
| Windows 10/11 | ✅ 完全支持 | 推荐平台 |
| macOS 12+ | 🚧 开发中 | 需要调整部分配置 |
| Linux (Ubuntu 22.04+) | 🚧 开发中 | 需要额外安装依赖 |

---

## 生产环境配置

### 1. LLM Provider 配置

Marcel SSH 的 Agent 功能需要接入 OpenAI 兼容 API 服务。

#### OpenAI 兼容 API

```bash
# 方式一：通过环境变量
set MARCEL_SSH_LLM_API_KEY=sk-xxx
set MARCEL_SSH_LLM_BASE_URL=https://api.openai.com/v1

# 方式二：在应用设置中配置（推荐）
```

支持模型：
- `gpt-4o`（推荐）
- `gpt-4o-mini`
- `gpt-3.5-turbo`
- 兼容 OpenAI API 的其他服务（如 Azure OpenAI、本地 vLLM）


### 2. SSH 连接配置

#### 支持的认证方式

| 认证方式 | 状态 | 说明 |
|----------|------|------|
| 密码认证 | ✅ | 适用于大多数服务器 |
| SSH 密钥 | ✅ | 推荐使用，更安全 |
| SSH Agent 转发 | ✅ | 适用于跳板机场景 |

#### 密钥格式要求

Marcel SSH 支持以下格式的私钥：
- RSA (PEM/OpenSSH)
- Ed25519
- ECDSA
- DSA

密钥文件路径：`~/.ssh/id_rsa` 或其他自定义路径

#### 连接配置示例

```json
{
  "host": "192.168.1.100",
  "port": 22,
  "username": "deploy",
  "auth": {
    "type": "key",
    "key_path": "C:\\Users\\YourName\\.ssh\\id_rsa"
  },
  "name": "生产服务器",
  "group": "生产环境"
}
```

### 3. 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `MARCEL_SSH_LLM_API_KEY` | LLM API 密钥 | 无 |
| `MARCEL_SSH_LLM_BASE_URL` | LLM API 基础 URL | 无（使用 OpenAI 默认值） |
| `MARCEL_SSH_LLM_MODEL` | LLM 模型名 | `gpt-4` |
| `MARCEL_SSH_LLM_ALLOW_INVALID_CERTS` | 允许无效证书 | `false` |
| `RUST_LOG` | Rust 日志级别 | `info` |

### 4. Agent 权限策略

Agent 系统默认采用保守的权限策略（Agent 模式，默认模式）：

| 操作类型 | 默认行为 | 可配置 |
|----------|---------|--------|
| 只读命令 (`ls`, `cat`, `pwd`) | ✅ 自动执行 | - |
| 低风险操作 (`mkdir`, `touch`) | ⚠️ 确认后执行 | 可设置自动确认 |
| 危险命令 (`rm`, `mkfs`, `dd`, `shutdown`) | ⚠️ 黑名单中，需用户确认 | 可通过设置调整 |

---

## 构建生产版本

### Windows 打包

```bash
# 1. 确保已完成前端构建
pnpm build

# 2. 打包 Windows 安装程序
pnpm tauri build

# 构建产物将输出到：
# src-tauri/target/release/bundle/
# ├── nsis/          # NSIS 安装包 (.exe)
# └── msi/           # MSI 安装包
```

### 构建配置优化

`tauri.conf.json` 中的关键配置项：

```json
{
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi"],
    "icon": ["icons/icon.ico", "icons/icon.png"],
    "identifier": "com.marcel.ssh",
    "windows": {
      "certificateThumbprint": "YOUR_CERT_THUMBPRINT",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

### 代码签名（可选但推荐）

1. 获取代码签名证书
2. 在 `tauri.conf.json` 中配置证书指纹
3. 构建时自动签名

---

## 开发指南

### 项目结构

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
│   │   ├── sftp/       # 文件传输
│   │   ├── settings/   # 设置页面
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

### 命令参考

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
cargo clippy          # 代码质量检查
cargo build --release # 发布构建
```

## 性能目标

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


## 贡献指南

欢迎提交 Issue 和 Pull Request！

### 提交 Issue

请提供：
- 问题描述
- 复现步骤
- 预期行为
- 实际行为
- 系统环境（OS、Node.js 版本、Rust 版本）

### 提交 PR

1. Fork 本项目
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

---

## 许可证

MIT

---

## 相关文档

- [AGENTS.md](./AGENTS.md) - 完整架构设计文档
- [Tauri 文档](https://v2.tauri.app/)
- [xterm.js 文档](https://xtermjs.org/)
- [russh 文档](https://docs.rs/russh/)
- [Zustand 文档](https://zustand-demo.pmnd.rs/)
