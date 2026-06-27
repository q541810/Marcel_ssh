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

欢迎加入交流群，与我们分享使用经验、反馈问题、建议功能等，有时会发一些福利。

---

## 快速开始

1. 前往 [Release 页面](https://github.com/q541810/Marcel_ssh/releases) 下载最新安装包
2. 安装后打开，根据使用引导完成配置
3. 添加你的 SSH 服务器连接
4. 开始使用！

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
- **插件系统**：支持自定义插件，扩展 Marcel SSH 的功能（[开发指南](docs/plugin-development.md)）




---

## 安全功能

- **API Key** 存储在系统密钥链中，不会明文保存到配置文件。
- **危险命令** 通过可配置的黑名单/白名单筛选，被删选掉的危险命令需要用户审批确认后执行。

---

## 终端操作

符合直觉的 Windows powershell 风格键鼠操作，无需记忆快捷键：

| 操作             | 行为                 |
| -------------- | ------------------ |
| 直接 `Ctrl+C`    | 中断当前命令（SSH SIGINT） |
| 选中文字后 `Ctrl+C` | 复制选中内容（Windows 逻辑） |
| 右键点击终端         | 粘贴剪贴板内容            |


---

## 界面展示

![Marcel SSH 展示图](https://github.com/q541810/Marcel_ssh/blob/main/image/%E5%B1%95%E7%A4%BA%E5%9B%BE.png?raw=true)

---

## 开发相关

贡献必读： [Contributors_read.md](Contributors_read.md)，了解贡献者需要遵守的规则和建议

插件开发：
- [插件开发指南](docs/plugin-development.md) — 从零开始创建插件
- [插件 API 参考](docs/plugin-api.md) — 完整的字段定义与协议格式


---

## 授权

GNU General Public License v3.0

---

## 致谢

感谢[GitFrog1111](https://github.com/GitFrog1111/OpenWhip) ，本项目的鞭子借鉴了其仓库GitFrog1111/OpenWhip的实现

感谢[heibaiya-dev](https://github.com/heibaiya-dev) 为项目的贡献
