<p align="center">
  <img src="https://github.com/q541810/Marcel_ssh/blob/main/image/%E6%A0%87%E7%AD%BE%E5%9B%BE.png?raw=true" alt="Marcel SSH" width="520" />
</p>

<h1 align="center">Marcel SSH</h1>

<p align="center">
  <strong>小白也能上手的专业级 AI-Native SSH Client</strong>
</p>

***

## 交流群

QQ:1101255501

欢迎加入交流群，与我们分享使用经验、反馈问题、建议功能等，有时会发一些福利。

***


## 核心功能

**AI-Native 设计，从底层架构为 Agent 而生**

- **智能助手 (Agent)**：13+ 内置工具，自主决策多步执行，支持命令执行、文件读写、进程管理、Web 搜索等
- **执行计划系统**：Agent 自动创建分步计划，实时状态推送，可视化进度跟踪
- **MCP 集成**：连接外部工具服务器，工具自动发现与调用，支持信任分级
- **Skills**：自定义提示词模板，渐进式披露，按需启用/禁用
- **SFTP 文件管理**：拖拽上传、批量操作、在线解压、可上传文件夹、文件编辑
- **插件系统**：自定义插件扩展功能，支持 WebView 面板挂载（[开发指南](docs/plugin-development.md)）

***

## 安全功能

**三层审批体系，危险命令无处遁形** 

1. **沙箱静态分析（风险名单用户可自定义）**：Shell-aware 解析器，五级风险评估（ReadOnly → LowRisk → Moderate → HighRisk → Destructive）
2. **模型审批（可开可关）**：LLM 独立判断命令安全性，支持放行/转人工/阻止三种决策
3. **人工审批**：弹出审批对话框，显示风险级别、命令内容、模型提示原因

**补充安全机制**：

- **密钥链隔离**：API Key、SSH 密码存储在系统密钥链，前端永远拿不到明文
- **内存清零**：密码、敏感命令执行后立即清零内存（zeroize crate）


***

## 终端操作

**符合直觉的 Windows PowerShell 风格，无需记忆快捷键**

| 操作             | 行为                 |
| -------------- | ------------------ |
| 直接 `Ctrl+C`    | 中断当前命令（SSH SIGINT） |
| 选中文字后 `Ctrl+C` | 复制选中内容（Windows 逻辑） |
| 右键点击终端         | 粘贴剪贴板内容            |


***

## 快速开始

1. 前往 [Release 页面](https://github.com/q541810/Marcel_ssh/releases) 下载最新安装包
2. 安装后打开，根据使用引导完成配置
3. 添加你的 SSH 服务器连接
4. 开始使用！

（想要体验最新内容请自行拉取仓库后运行dev.cmd或打包成安装包使用，并在有新commit后pull）

***

## 界面展示

![Marcel SSH 展示图](https://github.com/q541810/Marcel_ssh/blob/main/image/%E5%B1%95%E7%A4%BA%E5%9B%BE.png?raw=true)

***

## 开发相关

贡献必读： [Contributors\_read.md](Contributors_read.md)，了解贡献者需要遵守的规则和建议

插件开发：

- [插件开发指南](docs/plugin-development.md) — 从零开始创建插件
- [插件 API 参考](docs/plugin-api.md) — 完整的字段定义与协议格式

***

## 授权

GNU General Public License v3.0

***

## 致谢

感谢[heibaiya-dev](https://github.com/heibaiya-dev) 为项目的贡献
