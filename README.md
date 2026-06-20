<p align="center">
  <img src="https://github.com/q541810/Marcel_ssh/blob/main/image/%E6%A0%87%E7%AD%BE%E5%9B%BE.png?raw=true" alt="Marcel SSH" width="520" />
</p>

<h1 align="center">Marcel SSH</h1>

<p align="center">
  <strong>小白也能上手的专业级 AI-Native SSH Client</strong>
</p>

---

## 交流群

QQ:1101255501

## 快速开始

1. 前往 [Release 页面](https://github.com/q541810/Marcel_ssh/releases) 下载最新安装包
2. 安装后打开，先配置 LLM（设置 → LLM 配置）
3. 添加你的 SSH 服务器连接
4. 开始使用！Agent 会理解你的意图、规划操作步骤并执行

（想要体验最新内容请自行拉取仓库后运行dev.cmd或打包成安装包使用，并在有新commit后pull）

---

## 核心功能

- **智能助手 (Agent)**：用自然语言描述你想做的事，Agent 自动在远程服务器上执行
- **文件管理 (SFTP)**：可视化目录浏览、拖拽上传、批量操作、压缩包在线解压
- **MCP 集成**：支持 Model Context Protocol 外部工具服务器，工具自动发现与调用
- **Skills 系统**：自定义提示词模板，按需启用/禁用
- **快捷命令**：预设常用命令组，支持定时执行
- **文件编辑**：内置 CodeMirror 编辑器，支持语法高亮
- **安全筛选**：危险命令默认被拦截，黑白名单可自定义
- **原生性能**：Tauri 2 + Rust + React + TypeScript

---

## 技术栈

| 层级   | 技术                 |
| ---- | ------------------ |
| 后端   | Rust + Tauri 2     |
| 前端   | React + TypeScript |
| 终端   | xterm.js + WebGL   |
| 状态管理 | Zustand            |
| 文件编辑 | CodeMirror         |
| 样式   | TailwindCSS        |
| 数据库  | SQLite（对话持久化）      |

---

## 终端操作

符合直觉的 Windows powershell 风格键鼠操作，无需记忆快捷键：

| 操作             | 行为                 |
| -------------- | ------------------ |
| 直接 `Ctrl+C`    | 中断当前命令（SSH SIGINT） |
| 选中文字后 `Ctrl+C` | 复制选中内容（Windows 逻辑） |
| 右键点击终端         | 粘贴剪贴板内容            |

---

## 安全功能

- **API Key** 存储在系统密钥链中，不会明文保存到配置文件
- **危险命令** 默认被黑名单拦截（rm -rf /、mkfs、dd、shutdown、reboot 等），名单可配置
- **下载路径** 被限制在沙箱目录内，系统路径不可写入

---

## 界面展示

![Marcel SSH 展示图](https://github.com/q541810/Marcel_ssh/blob/main/image/%E5%B1%95%E7%A4%BA%E5%9B%BE.png?raw=true)

---

## 贡献必读

请先阅读 [Contributors_read.md](Contributors_read.md)，了解贡献者需要遵守的规则和建议

~

---

## 授权

GNU General Public License v3.0

---

## 致谢

感谢[GitFrog1111](https://github.com/GitFrog1111/OpenWhip) ，本项目的鞭子借鉴了其仓库GitFrog1111/OpenWhip的实现

感谢[heibaiya-dev](https://github.com/heibaiya-dev) 为项目的贡献
