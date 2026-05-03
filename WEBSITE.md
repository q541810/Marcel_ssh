# Marcel SSH 官网开发文档

> 本文档为 AI 辅助开发官网提供完整的项目信息和技术规格。

---

## 1. 项目概述

### 1.1 产品定位

**Marcel SSH（玛瑟尔 SSH）** 是一款 AI 原生 SSH 客户端，核心差异化是内置自主 Agent 操作能力。

**核心价值主张**：
- Agent-First：AI Agent 可自主理解用户意图、规划操作步骤、在远程服务器上自动执行命令序列
- 人机协同终端：用户可在传统手动终端和 Agent 自动模式之间无缝切换
- 桌面级体验：基于 Tauri 构建，原生级性能，极小资源占用

### 1.2 与现有工具的差异

| 特性 | 传统 SSH 客户端 | Marcel SSH |
|------|----------------|------------|
| 命令执行 | 手动逐条输入 | Agent 自主规划 + 批量执行 |
| 错误处理 | 用户自行判断 | Agent 自动识别错误并尝试修复 |
| 上下文理解 | 无 | Agent 理解会话历史和服务器状态 |
| 安全审计 | 依赖外部工具 | 内置操作日志与权限沙箱 |

### 1.3 目标用户

- DevOps 工程师
- 后端开发者
- 系统管理员
- 需要频繁操作远程服务器的技术人员

---

## 2. 核心功能

### 2.1 智能助手系统（核心差异化）

**三种操作模式**：

| 模式 | 说明 |
|------|------|
| **CHAT** | 纯聊天模式，AI 仅回答问题，不执行任何工具或命令 |
| **AGENT** | AI 可调用工具执行命令，受黑/白名单约束，中高风险操作需用户确认 |
| **AUTO** | 全自主模式，AI 无需确认直接执行所有工具调用 |

**内置工具（12个）**：

| 工具名称 | 功能 | 风险等级 |
|----------|------|---------|
| `execute_command` | 在远程 shell 执行单条命令 | 动态评估 |
| `read_file` | 读取远程文件 | 只读 |
| `write_file` | 写入/创建远程文件 | 中等风险 |
| `edit_file` | 编辑远程文件（diff patch） | 中等风险 |
| `list_directory` | 列出目录内容 | 只读 |
| `upload_file` | 上传本地文件到远程（SFTP） | 中等风险 |
| `download_file` | 下载远程文件到本地（SFTP） | 只读 |
| `search_files` | 内容搜索（grep -rn） | 只读 |
| `process_management` | 查看/管理远程进程 | 只读 |
| `system_info` | OS / 内存 / 磁盘信息查询 | 只读 |
| `web_search` | 联网搜索互联网信息 | 只读 |
| `http_get` | 获取网页完整内容 | 只读 |

### 2.2 安全沙箱

- **命令黑名单**：`rm`, `mkfs`, `dd`, `shutdown`, `reboot` 等危险命令默认需确认
- **命令速率限制**：单次任务最大 LLM 交互轮数默认 50 轮
- **审计日志**：所有 Agent 操作实时推送至前端

### 2.3 终端功能

- 基于 xterm.js 5 的高性能终端渲染
- 支持自定义终端颜色主题（8 种预设 + 自定义）
- 多标签会话管理
- 实时输出流

### 2.4 连接管理

- 支持密码认证和 SSH 密钥认证
- 连接配置持久化存储
- 分组管理

---

## 3. 技术栈

### 3.1 后端（Rust）

```
Tauri 2.x (Rust 后端 + WebView 前端)
├── tauri             — 应用框架、窗口管理、IPC
├── russh             — SSH 协议实现
├── tokio             — 异步运行时
├── serde / serde_json— 序列化
├── rusqlite          — 本地数据持久化
└── keyring           — 系统密钥链集成
```

### 3.2 前端（TypeScript）

```
React 18          — UI 框架
xterm.js 5        — 终端模拟器渲染
TailwindCSS 4     — 样式系统
Zustand           — 状态管理
@tauri-apps/api   — Tauri 前端 API 绑定
Vite 6            — 构建工具
```

### 3.3 性能指标

| 指标 | 目标 |
|------|------|
| 冷启动到可用 | < 2s |
| SSH 连接建立 | < 3s |
| 终端输入延迟 | < 16ms |
| 内存占用（空闲） | < 80MB |
| 打包体积 | < 15MB |

---

## 4. 项目结构

```
marcel-ssh/
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── commands/             # Tauri IPC command handlers
│   │   │   ├── ssh.rs            # SSH 连接相关命令
│   │   │   ├── agent.rs          # Agent 操作命令
│   │   │   └── config.rs         # 配置管理命令
│   │   ├── ssh/                  # SSH 核心实现
│   │   ├── agent/                # Agent 自动化系统
│   │   ├── llm/                  # LLM 接入层
│   │   ├── config/               # 配置与持久化
│   │   └── error.rs              # 统一错误类型
│   └── Cargo.toml
│
├── src/                          # 前端
│   ├── components/
│   │   ├── terminal/             # 终端组件
│   │   ├── agent/                # 智能助手面板
│   │   ├── connection/           # 连接管理
│   │   ├── settings/             # 设置页面
│   │   └── ui/                   # 通用 UI 组件
│   ├── hooks/                    # useSSH, useAgent, useTerminal
│   ├── stores/                   # Zustand 状态管理
│   └── lib/                      # 类型定义 + Tauri IPC 封装
│
├── AGENTS.md                     # 完整架构设计文档
├── README.md                     # 项目说明
└── package.json
```

---

## 5. UI 设计规格

### 5.1 设计风格

- **整体风格**：现代、简洁、专业
- **配色方案**：深色主题为主（zinc 色系）
- **强调色**：Indigo (#6366f1)
- **圆角**：Apple-style border radius (6px / 8px / 12px / 16px)
- **动画**：Spring 动画效果

### 5.2 主要 UI 组件

| 组件 | 说明 |
|------|------|
| `NavRail` | 左侧导航栏（会话、MCP、设置） |
| `ConnectionList` | 连接列表侧边栏 |
| `Terminal` | 终端主区域 |
| `AgentPanel` | 右侧智能助手面板 |
| `Settings` | 设置页面 |

### 5.3 布局结构

```
┌─────────────────────────────────────────────────────────────┐
│                        标题栏 (32px)                         │
├──────┬─────────────────────────────────────────┬────────────┤
│      │                                         │            │
│ Nav  │           Sidebar                       │   Agent    │
│ Rail │           (连接列表)                     │   Panel    │
│(48px)│           (256px)                       │  (320px)   │
│      │                                         │            │
│      │    ┌─────────────────────────────┐     │            │
│      │    │                             │     │            │
│      │    │        Terminal             │     │            │
│      │    │        (主区域)              │     │            │
│      │    │                             │     │            │
│      │    └─────────────────────────────┘     │            │
│      │                                         │            │
└──────┴─────────────────────────────────────────┴────────────┘
```

---

## 6. 官网内容建议

### 6.1 首页（Hero Section）

**主标题**：
```
AI 原生 SSH 客户端
让远程服务器操作更智能
```

**副标题**：
```
内置自主 Agent，可理解你的意图并自动执行命令序列
告别手动逐条输入，让 AI 成为你的运维助手
```

**CTA 按钮**：
- 下载 Windows 版
- 查看文档
- GitHub

### 6.2 功能展示

**核心功能卡片**：

1. **智能助手**
   - 三种模式：聊天 / 副驾驶 / 自主
   - 12 种内置工具
   - 安全沙箱保护

2. **原生性能**
   - 基于 Tauri 2 + Rust
   - 打包体积 < 15MB
   - 内存占用 < 80MB

3. **安全可靠**
   - 命令风险评估
   - 黑名单过滤
   - 操作审计日志

4. **高度可定制**
   - 8 种终端主题
   - 自定义颜色
   - 灵活的权限策略

### 6.3 演示区域

建议展示：
- Agent 执行命令的实时演示
- 终端主题切换效果
- 安全确认弹窗交互

### 6.4 技术栈展示

```
Backend:  Rust | Tauri 2 | russh | tokio
Frontend: React 18 | TypeScript | TailwindCSS 4 | xterm.js
```

### 6.5 下载区域

| 平台 | 状态 | 备注 |
|------|------|------|
| Windows 10/11 | ✅ 完全支持 | 推荐平台 |
| macOS 12+ | 🚧 开发中 | - |
| Linux | 🚧 开发中 | - |

---

## 7. 品牌资源

### 7.1 产品名称

- **英文**：Marcel SSH
- **中文**：玛瑟尔 SSH
- **Slogan**：AI-Native SSH Client

### 7.2 颜色变量

```css
/* 主色调 */
--primary: #6366f1;        /* Indigo 500 */
--primary-hover: #4f46e5;  /* Indigo 600 */

/* 背景色 */
--bg-primary: #09090b;     /* Zinc 950 */
--bg-secondary: #18181b;   /* Zinc 900 */
--bg-tertiary: #27272a;    /* Zinc 800 */

/* 文字色 */
--text-primary: #fafafa;   /* Zinc 50 */
--text-secondary: #a1a1aa; /* Zinc 400 */
--text-muted: #71717a;     /* Zinc 500 */

/* 边框色 */
--border: #3f3f46;         /* Zinc 700 */
```

### 7.3 图标资源

- 图标目录：`src-tauri/icons/`
- 格式：ICO (Windows), PNG, ICNS (macOS)
- 尺寸：32x32, 128x128, 128x128@2x, 512x512

---

## 8. 链接资源

### 8.1 官方链接

- **GitHub**：https://github.com/your-org/marcel-ssh
- **文档**：AGENTS.md（架构设计）、README.md（使用指南）
- **问题反馈**：GitHub Issues

### 8.2 技术文档

- [Tauri 文档](https://v2.tauri.app/)
- [xterm.js 文档](https://xtermjs.org/)
- [russh 文档](https://docs.rs/russh/)
- [Zustand 文档](https://zustand-demo.pmnd.rs/)

---

## 9. 开发命令参考

```bash
# 安装依赖
pnpm install

# 启动开发模式（完整应用）
pnpm tauri dev

# 仅预览前端 UI
pnpm dev

# 构建前端
pnpm build

# 打包生产版本
pnpm tauri build

# Rust 测试
cd src-tauri && cargo test

# Rust 类型检查
cd src-tauri && cargo check
```

---

## 10. 注意事项

### 10.1 安全相关

- API Key 存储在系统密钥链，绝不明文写入配置文件
- SSH 私钥不经过 WebView 进程，仅在 Rust 侧内存中加载
- Agent 无法绕过安全策略引擎直接执行命令

### 10.2 性能相关

- 终端输出是热路径，避免不必要的计算
- 所有 SSH 操作必须异步
- 长时间运行的任务使用 tokio::spawn

### 10.3 兼容性

- Windows 路径可能包含单引号，需要特殊处理
- RC.EXE 不支持包含单引号的路径

---

## 11. 更新日志

### v0.1.0 (当前版本)

- ✅ SSH 连接管理（密码/密钥认证）
- ✅ 终端多标签
- ✅ AI Agent 系统（12 种工具）
- ✅ 安全沙箱
- ✅ 终端主题自定义
- ✅ 实验性功能设置

### 计划中

- 🚧 SFTP 文件传输
- 🚧 macOS 支持
- 🚧 Linux 支持
- 🚧 更多 LLM Provider

---

*文档最后更新：2026-05-03*
