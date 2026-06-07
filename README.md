<p align="center">
  <img src="https://github.com/q541810/Marcel_ssh/blob/main/image/%E6%A0%87%E7%AD%BE%E5%9B%BE.png?raw=true" alt="Marcel SSH" width="520" />
</p>

<h1 align="center">Marcel SSH</h1>

<p align="center">
  <strong>面向小白的、深度集成ai的AI SSH终端工具</strong>
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
- **三种模式**：
  - **Chat 模式**：纯对话，不执行任何命令
  - **Agent 模式**（默认）：AI 可执行命令，中高风险操作需你确认
  - **Auto 模式**：全自动，无需逐条确认
- **安全筛选**：危险命令（rm -rf、mkfs、shutdown 等）默认被拦截，黑白名单可自定义
- **原生性能**：Tauri 2 + Rust

---

## 终端操作

符合直觉的 Windows powershell 风格键鼠操作，无需记忆快捷键：

| 操作 | 行为 |
|------|------|
| 直接 `Ctrl+C` | 中断当前命令（SSH SIGINT） |
| 选中文字后 `Ctrl+C` | 复制选中内容（Windows 逻辑） |
| 右键点击终端 | 粘贴剪贴板内容 |

---

## 首次使用

连接 SSH 服务器后，在右侧 Agent 面板输入你的需求，例如：

> "查看服务器状态，检查磁盘空间和内存使用"
> "帮我部署一个 Nginx 容器"
> "找出 /var/log 下最近修改过的文件"

Agent 会自动规划步骤、执行命令，并在需要你确认时暂停等待。

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

~~呃，你问我为什么dev时一堆warn？能跑就行啦！挑啥！~~

---

## 授权

GNU General Public License v3.0

---

## 致谢

感谢[heibaiya-dev](https://github.com/heibaiya-dev) 为项目的贡献
