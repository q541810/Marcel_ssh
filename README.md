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

欢迎加入交流群，与我们分享使用经验、反馈问题、建议功能等

***

## 核心功能

**AI-Native 设计，从底层架构为 Agent 而生**

- **智能助手 (Agent)**：13+ 内置工具，自主决策多步执行，支持命令执行、文件读写、进程管理、Web 搜索等
- **执行计划系统**：Agent 自动创建分步计划，实时状态推送，可视化进度跟踪
- **MCP 集成**：连接外部工具服务器，工具自动发现与调用，支持信任分级
- **Skills**：自定义提示词模板，渐进式披露，按需启用/禁用
- **SFTP 文件管理**：拖拽上传、批量操作、在线解压、可上传文件夹、文件编辑
- **插件系统**：自定义插件扩展功能，支持 WebView 面板挂载（[开发指南](docs/plugin-development.md)）
- **双端支持**：Marcel SSH 同时支持 **Windows 桌面端** 与 **Android 移动端**。搭配自动同步，工作随时迁移

***

## 安全功能

**三层审批体系，危险命令无处遁形** 

1. **沙箱静态分析（风险名单用户可自定义）**：Shell-aware 解析器，五级风险评估（ReadOnly → LowRisk → Moderate → HighRisk → Destructive）
2. **模型审批（可开可关）**：LLM 独立判断命令安全性，支持放行/转人工/阻止三种决策
3. **人工审批**：弹出审批对话框，显示风险级别、命令内容、模型提示原因

**补充安全机制**：

- **密钥链隔离**：API Key、SSH 密码存储在系统密钥链，前端永远拿不到明文(移动版为Android Keystore + SharedPreferences)
- **内存清零**：密码、敏感命令执行后立即清零内存（zeroize crate）

***

## 生于agent，不止于agent

Marcel SSH 底层为 AI Agent 深度定制，内置13+工具、自主执行计划与 MCP 集成，让服务器操作真正进入“说人话就能完成”的时代。但我们清楚，再智能的 Agent 也不能脱离一个可靠的传统终端。

因此，我们投入大量精力打磨 **专业级 SSH 客户端应有的每一项基本功**：

- **原生终端体验**：流畅渲染、符合 Windows 习惯的 `Ctrl+C`/右键粘贴交互，拒绝为 AI 功能牺牲操作效率。
- **完整的 SFTP 文件管理**：拖拽上传/下载、文件夹操作、在线解压与编辑，不依赖第三方软件。
- **严苛的安全体系**：三层审批（沙箱分析、模型判断、人工确认）+ 密钥链隔离 + 内存敏感数据清零，危险命令无处遁形。
- **插件与同步生态**：插件系统扩展无限可能，端到端加密的自动同步让 Windows 与 Android 间无缝迁移。

我们精心打磨各项功能，只为给你最完整的体验——**Agent 是强大的副驾驶，但 Marcel SSH 本身就是一辆哪儿都能去的车，而不是一个止步于 agent 功能的花架子。**

****

## 双端支持

Marcel SSH 同时支持 **Windows 桌面端** 与 **Android 移动端**，两端共用同一套核心：SSH 终端、Agent 自动化、SFTP 文件管理、Skills、MCP、设置。

|                                | Windows                                | Android                                     |
| ------------------------------ | -------------------------------------- | ------------------------------------------- |
| 安装包                            | `Marcel SSH_x.y.z_x64-setup.exe`（NSIS） | `Marcel-SSH_x.y.z_arm64.apk`（arm64-v8a，已签名） |
| SSH 终端 / Agent / SFTP / Skills | ✓                                      | ✓                                           |
| 插件系统/自定义MCP                    | ✓                                      | ✗                                           |
| 敏感信息存储                         | 系统密钥链                                  | Android Keystore + SharedPreferences        |
| 网页获取                           | http_get/调用本机真实浏览器（默认）                 | http_get                                    |
| 平台专属交互                         | PowerShell 风格终端操作                      | 终端底部辅助键栏（Esc/Ctrl/方向键/常用符号）                 |

Android APK 在 [Release 页面](https://github.com/q541810/Marcel_ssh/releases) 与 Windows 安装包一同发布。

****

### 自动同步

基于端到端加密，服务端无法读取数据。支持自部署或使用官方服务器。

|      | Marcel SSH      | FinalShell   | XShell |
| ---- | --------------- | ------------ | ------ |
| 费用   | 免费              | 云同步收费        | 付费软件   |
| 同步方式 | 配置码+密码，不强制绑定手机号 | 账号密码登录       | 无云同步   |
| 服务端  | 自部署/官方，代码开源     | 强制使用官方服务器，闭源 | 无      |
| 数据隐私 | 服务端零信任的端到端加密    | 闭源软件，全凭开发者自觉 | 仅本地    |

**安全说明**：SSH 密钥永远不同步；配置码和账户密码参与密钥派生，丢失后无法找回（不影响本地数据）。

****

## 快速开始

1. 前往 [Release 页面](https://github.com/q541810/Marcel_ssh/releases) 下载最新安装包
2. 安装后打开，根据使用引导完成配置
3. 添加你的 SSH 服务器连接
4. 开始使用！

（想要体验最新内容请自行拉取仓库后运行dev.cmd或打包成安装包使用，并在有新commit后pull）

***

### 自行编译 Android 包

需要 Android SDK + NDK 27 + JDK，然后：

```powershell
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME="$env:LOCALAPPDATA\Android\Sdk\ndk\27.0.12077973"
pnpm tauri android build --apk --target aarch64
```

产物在 `src-tauri/gen/android/app/build/outputs/apk/universal/release/`。release 构建会自动用仓库外的正式 keystore 签名；没有配置 `key.properties` 时退化为未签名 APK，可手动用 `apksigner` 签 debug key 自测。

***

### 部署自动同步服务端

服务端文档见Marcel SSH\server\DEPLOY.md

****

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
