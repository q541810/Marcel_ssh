# 插件开发指南

本文档帮助你从零开始开发 Marcel SSH 插件。如果你已经熟悉插件系统，直接查阅 [API 参考](./plugin-api.md)。

---

## 快速开始

### 1. 创建插件目录

在插件目录下创建一个新文件夹：

```
<app-config-dir>/plugins/hello-world/
```

> `<app-config-dir>` 因平台而异：
> - Windows: `C:\Users\<user>\AppData\Roaming\com.marcel.ssh\`
> - macOS: `~/Library/Application Support/com.marcel.ssh/`
> - Linux: `~/.config/com.marcel.ssh/`
>
> 也可以在 Marcel SSH 的 **设置 → 插件** 页面复制完整路径。

### 2. 创建 manifest

在 `hello-world/` 下创建 `plugin.json`：

```json
{
  "id": "hello-world",
  "version": "1.0.0",
  "name": "Hello World",
  "capabilities": ["ssh.list"],
  "views": [
    {
      "id": "main",
      "mount": "sidebar",
      "title": "Hello",
      "navGroup": "top",
      "entry": "index.html"
    }
  ]
}
```

### 3. 创建入口文件

在 `hello-world/` 下创建 `index.html`：

```html
<!DOCTYPE html>
<html>
<body style="background:#18181b;color:#e4e4e7;padding:16px;font-family:sans-serif">
  <h3>Hello Plugin</h3>
  <button id="btn" style="padding:6px 12px;background:#3f3f46;color:#fff;border:none;border-radius:6px;cursor:pointer">
    获取当前会话
  </button>
  <pre id="out" style="margin-top:12px;font-size:13px;white-space:pre-wrap"></pre>

  <script>
    const { emit, listen } = window.__TAURI__.event;
    let counter = 0;

    document.getElementById('btn').onclick = async () => {
      const id = String(++counter);
      const unlisten = await listen(`plugin-response-${id}`, (e) => {
        document.getElementById('out').textContent = JSON.stringify(e.payload, null, 2);
        unlisten();
      });
      await emit('plugin-request', {
        id,
        pluginId: 'hello-world',
        cmd: 'session.active',
        args: {}
      });
    };
  </script>
</body>
</html>
```

### 4. 刷新插件

打开 Marcel SSH → **设置 → 插件** → 点击 **刷新**。

左侧导航栏会出现 "Hello" 按钮，点击即可看到插件界面。

---

## 插件结构

```
<app-config-dir>/plugins/
  <plugin-id>/
    plugin.json          # 必须。插件 manifest。
    index.html           # 入口文件（由 manifest 的 entry 字段指定，必填）
    style.css            # 可选。样式文件。
    icon.svg             # 可选。插件图标。
    ...                  # 其他前端资源
```

- `plugin-id` 必须是合法的文件夹名（字母、数字、连字符、下划线）
- 所有资源通过 `plugin://<plugin-id>/<path>` 协议加载
- HTML 中用相对路径引用资源（如 `<link rel="stylesheet" href="style.css">`）

---

## manifest 字段速查

```jsonc
{
  "id": "my-plugin",              // 必须。与文件夹名一致。
  "version": "1.0.0",             // 必须。语义化版本号。
  "name": "我的插件",              // 必须。显示名称。
  "publisher": "developer",       // 可选。发布者。
  "description": "插件描述",       // 可选。
  "capabilities": ["ssh.list"],   // 可选。声明需要的权限。
  "configView": "config.html",     // 可选。配置视图入口文件。
  "views": [...],                 // 可选。视图定义。
  "agentTools": [...],            // 可选。Agent 工具定义。
  "injections": [...]             // 可选。内容脚本注入（需 ui.inject）。
}
```

详见 [API 参考 - Manifest 格式](./plugin-api.md#pluginjson-manifest-格式)。

---

## 视图开发

### 挂载点

视图可以挂载到以下位置：

| 挂载点 | 说明 | 典型用途 |
|--------|------|----------|
| `sidebar` | 左侧面板 | 导航列表、快捷操作 |
| `bottom` | 底部面板 | 日志、输出 |

### 基本视图定义

```json
{
  "id": "main",
  "mount": "sidebar",
  "title": "我的面板",
  "navGroup": "top",
  "order": 100,
  "entry": "index.html"
}
```

- `id`：在插件内简短即可（如 `main`），最终 ID 自动拼接为 `<plugin-id>.<view-id>`
- `navGroup`：`top` 或 `bottom`。sidebar 视图需设置此项才会出现在 NavRail 上；不设置则视图仍注册但不显示在导航栏
- `order`：排序权重，越小越靠前，默认 100
- `entry`：入口文件路径，相对于插件根目录（必填）
- `exclusive`：设为 `true` 时该视图通过 NavRail 切换激活后会**独占中央面板**，同时隐藏 sidebar 和 agent 面板（如设置页），默认 `false`

### 图标

```json
// SVG 图标
{ "kind": "svg", "src": "icon.svg" }

// 图片图标
{ "kind": "img", "src": "icon.png" }
```

不设置图标时显示默认插件图标。

### WebView 特性

- 每个插件视图是**独立的 OS 窗口**，不是主窗口的 DOM
- 不能访问主窗口的 DOM 或 React 状态
- **配色建议使用注入的配色变量**（`var(--bg)`/`var(--text)`/`var(--accent)` 等，见 [API 参考·配置视图·配色变量](./plugin-api.md#配置视图)），与主应用深色配色一致；**不要写死颜色**。注意：配置 WebView 会自动注入一组固定深色配色变量（主应用目前**没有**可切换的主题系统），若你的页面用 `var(--bg, #ffffff)` 这类带白色兜底的写法，注入后背景会变为深色 `#18181b`——这是预期行为
- Tauri API 通过 `window.__TAURI__` 自动注入

---

## IPC 通信

插件通过事件与主应用通信。

### 请求

```javascript
const { emit, listen } = window.__TAURI__.event;

// 发送请求
const id = '1';  // 唯一标识，用于匹配响应
await emit('plugin-request', {
  id,                    // 请求 ID（字符串）
  pluginId: 'my-plugin', // 你的插件 ID
  cmd: 'session.active', // 要执行的命令
  args: {}               // 命令参数
});
```

### 响应

```javascript
// 监听响应
const unlisten = await listen(`plugin-response-${id}`, (e) => {
  if (e.payload.ok) {
    console.log('成功:', e.payload.data);
  } else {
    console.error('失败:', e.payload.data);
  }
  unlisten();  // 用完后取消监听
});
```

### 完整示例：获取会话列表

```javascript
async function listSessions() {
  const id = Date.now().toString();
  return new Promise((resolve, reject) => {
    window.__TAURI__.event.listen(`plugin-response-${id}`, (e) => {
      if (e.payload.ok) {
        resolve(e.payload.data);
      } else {
        reject(new Error(e.payload.data));
      }
    }).then(unlisten => {
      window.__TAURI__.event.emit('plugin-request', {
        id,
        pluginId: 'my-plugin',
        cmd: 'session.active',
        args: {}
      }).then(null, reject);
    }).catch(reject);
  });
}
```

### 错误处理

插件 IPC 代理层会捕获所有错误并通过 `{ ok: false, data: "错误信息" }` 返回。常见错误：

- `command xxx not authorized for plugin yyy` — 未声明对应 capability
- 后端命令执行失败 — 返回 Rust 错误信息

---

## 可用命令

### 查询类（capability: `ssh.list`）

| 命令 | 参数 | 说明 |
|------|------|------|
| `session.active` | 无 | 获取当前活跃会话 |
| `session.info` | `{sessionId}` | 查询会话详情 |
| `connection.info` | `{connectionId}` | 查询保存的连接信息 |
| `connection.list` | 无 | 列出所有保存的连接 |
| `ssh_list_sessions` | 无 | 列出所有会话 ID |

### 执行类（capability: `ssh.exec`）

| 命令 | 参数 | 说明 |
|------|------|------|
| `ssh_exec` | `{sessionId, command}` | 在远程服务器执行命令 |

### 文件类

| 命令 | 参数 | capability | 说明 |
|------|------|------------|------|
| `sftp_read_file` | `{sessionId, path}` | `sftp.read` | 读取远程文件（最大 2MB） |
| `sftp_write_file` | `{sessionId, path, content}` | `sftp.write` | 写入远程文件 |
| `fs.read` | `{path}` | `fs.read` | 读取插件目录下的本地文件 |
| `fs.write` | `{path, content}` | `fs.write` | 写入插件目录下的本地文件 |

### 网络类（capability: `net.request`）

| 命令 | 参数 | 说明 |
|------|------|------|
| `net.request` | `{url, method?, headers?, body?}` | HTTP 请求（超时 20s，响应最大 256KB） |

### 通知类（capability: `notification`）

| 命令 | 参数 | 说明 |
|------|------|------|
| `notification` | `{title, body}` | 发送系统通知（标题自动加 `[插件ID]` 前缀） |

### 事件订阅（capability: `events`）

| 命令 | 参数 | 说明 |
|------|------|------|
| `events.subscribe` | `{events: string[]}` | 订阅事件，支持通配符 |
| `events.unsubscribe` | `{events: string[]}` | 取消订阅事件 |

#### 可订阅事件

| 事件模式 | 说明 |
|----------|------|
| `ssh://status/*` | SSH 连接状态变化 |
| `ssh://session-active` | 当前激活的 SSH 会话 Tab 变化（payload：`sessionId` / `connectionId` / `previous*`） |
| `agent://stream/*` | Agent 任务流 |
| `agent://plan/*` | Agent 计划流 |
| `sftp-upload-progress` | SFTP 上传进度 |
| `sftp-upload-done` | SFTP 上传完成 |
| `sftp-download-progress` | SFTP 下载进度 |
| `sftp-download-done` | SFTP 下载完成 |

#### 使用示例

```javascript
const { emit, listen } = window.__TAURI__.event;

// 订阅
const subId = Date.now().toString();
await listen(`plugin-response-${subId}`, (e) => {
  console.log('订阅结果:', e.payload.data);
});
await emit('plugin-request', {
  id: subId,
  pluginId: 'my-plugin',
  cmd: 'events.subscribe',
  args: { events: ['ssh://status/*'] }
});

// 接收事件
await listen('plugin-event-my-plugin', (e) => {
  console.log('事件:', e.payload.event, e.payload.data);
});
```

---

## HTTP API 端点

除了事件 IPC，插件还可以通过 `plugin://` 协议的 HTTP API 端点调用命令：

```javascript
const res = await fetch('plugin://my-plugin/api/ssh_exec', {
  method: 'POST',
  body: JSON.stringify({ sessionId: 'xxx', command: 'uptime' }),
});
const { ok, data } = await res.json();
```

优点：代码更简洁，无需管理请求 ID 和监听器。

限制：同步执行，长时间命令可能阻塞。

详见 [API 参考 - HTTP API 端点](./plugin-api.md#http-api-端点)。

---

## Agent 工具

插件可以为 AI Agent 提供自定义工具。

### 定义工具

在 `plugin.json` 的 `agentTools` 中定义：

```json
{
  "agentTools": [
    {
      "name": "server_status",
      "description": "获取服务器运行状态",
      "command": "top -bn1 | head -20",
      "parameters": {},
      "riskLevel": "ReadOnly"
    }
  ]
}
```

### 命令模板

> **注意**：Agent 工具的 `command` 在**当前活跃 SSH 会话的远程服务器**上执行（通过 SSH exec channel）。无活跃 SSH 会话时调用会失败。

用 `{{param}}` 引用参数：

```json
{
  "name": "restart_service",
  "description": "重启指定服务",
  "command": "sudo systemctl restart {{service}}",
  "parameters": {
    "type": "object",
    "properties": {
      "service": { "type": "string", "description": "服务名称" }
    },
    "required": ["service"]
  },
  "riskLevel": "HighRisk"
}
```

### 风险等级

| 等级 | 说明 |
|------|------|
| `ReadOnly` | 只读操作 |
| `LowRisk` | 低风险，可能创建临时文件 |
| `Moderate` | 中等风险（默认） |
| `HighRisk` | 高风险，沙箱审查后执行 |

> **注意**：Agent 工具仅在 Agent 模式和 Auto 模式下可用，Plan 模式下不注册。

### 本地工具（`kind=local`）

除了在远程服务器执行 SSH 命令（`kind=ssh`，默认），插件工具还可以声明 `kind=local` 在**用户本机**执行，调用内核注册的通用 handler。典型用途：读写插件目录下的本地文件、查询当前会话信息。

| | `kind=ssh`（默认） | `kind=local` |
|--|-------------------|--------------|
| 执行位置 | 远程 SSH 服务器 | 用户本机 |
| 必填字段 | `command`（SSH 命令模板） | `handler`（内核 handler 名）+ `command`（JSON 固定参数） |
| capability | 由 IPC 命令决定 | 由 handler 决定（如 `fs.read` handler 需声明 `fs.read`） |
| 适用场景 | 服务器运维命令 | 本地文件 IO、会话查询 |

示例：用 `fs.read` handler 读取插件目录下的 `data.json`，模型无法指定路径。

```json
{
  "agentTools": [
    {
      "name": "read_data",
      "description": "读取插件数据文件",
      "kind": "local",
      "handler": "fs.read",
      "command": "{\"path\":\"data.json\"}",
      "parameters": {},
      "riskLevel": "ReadOnly"
    }
  ],
  "capabilities": ["fs.read"]
}
```

要点：

- **`command` 字段在 `kind=local` 时是 JSON 对象字符串**，解析后作为 fixed_params 与模型参数合并，**fixed_params 优先**——把 `path` 写死在 `command` 里、不暴露给 `parameters` schema，可从根本上防止模型写到任意路径
- **capability 检查**：插件必须声明 handler 要求的 capability，否则工具调用被拒绝（详见 [API 参考 - 通用本地 handler](./plugin-api.md#通用本地-handler)）
- **handler 列表**：当前内核注册了 6 个通用 handler（`fs.read`/`fs.write`/`fs.append`/`session.info`/`connection.info`/`host_port`），任何插件都可调用，无需自己实现
- **上下文变量**：`command` 字段的字符串值支持 `{{__host_port__}}` 等模板变量，可让 path 自动带上当前连接标识（详见 [API 参考 - 模板上下文变量](./plugin-api.md#模板上下文变量)）

完整 handler 列表与 fixed_params 合并顺序详见 [API 参考](./plugin-api.md#通用本地-handler)。

### System Prompt 静态段（`systemPromptSection`）

如果插件希望模型在每次对话开始就"知道某些事"（如"你有这些工具可用"、"会话开始时主动调用某工具"），可以在 manifest 声明 `systemPromptSection` 字段，指向一个静态文本文件：

```json
{
  "id": "my-plugin",
  "systemPromptSection": "system-prompt.md"
}
```

`system-prompt.md` 内容是纯静态文本，支持 [上下文变量](./plugin-api.md#模板上下文变量) 替换：

```markdown
## 我的插件

当前连接为 {{__host_port__}}。会话开始时请主动调用 read_data 加载已有数据。
```

行为：

- 仅在 **Agent 模式 / Auto 模式**下生效，Plan 模式不拼接
- 拼接在 system prompt 末尾，模型每次对话开始自动看到
- 单段上限 2000 字符，超过截断
- 文件读取失败时跳过该段（warn 日志），不阻塞会话
- **不支持动态占位符**（如 `{{memory_index}}`），需要动态数据时由模型主动调用工具获取

详见 [API 参考 - systemPromptSection](./plugin-api.md#systempromptsection)。

---

## 内容脚本（Content Script）

插件可以像浏览器扩展一样把 JS/CSS 注入主窗口，直接操控主界面 DOM：改外观、加浮层、给现有 UI 加按钮/徽标、重塑布局等。

### 与视图（views）的区别

| | views | injections |
|--|-------|-----------|
| 运行环境 | 独立 OS WebView，隔离 | 主窗口内，与 React 共享 DOM |
| 能力 | 只能通过 IPC 通信 | 可直接 querySelector/改 DOM/加浮层 |
| 隔离 | 强（崩溃不影响主 UI） | 弱（同步死循环会卡主窗口） |
| 权限 | 视图挂载即可用 | 需声明 `ui.inject` capability |

一个插件可以同时有 `views` 和 `injections`。

### 快速开始

1. 声明 `ui.inject` 权限和 `injections`：

```json
{
  "id": "theme-tweak",
  "version": "1.0.0",
  "name": "主题微调",
  "capabilities": ["ui.inject"],
  "injections": [
    {
      "id": "main",
      "matches": ["*"],
      "styles": ["theme.css"],
      "scripts": ["content.js"]
    }
  ]
}
```

2. 创建 `theme.css`（全局注入到 `<head>`）：

```css
/* 给会话列表项加圆角 */
[data-region="sessions"] .rounded-lg { border-radius: 12px; }

/* 终端区背景微调 */
[data-region="terminal"] { background: #1a1a1f; }
```

3. 创建 `content.js`（以 `marcel` 为唯一参数执行）：

```js
// content.js — 顶层 await 可用，但不是 ES 模块（不能用 import/export）

// 监听导航切换，在进入终端时注入一个状态徽标
marcel.events.on('ui:nav-change', ({ to }) => {
  if (to === 'builtin.terminal') injectBadge();
});

async function injectBadge() {
  const term = await marcel.dom.waitForRegion('terminal');
  if (!term) return;
  if (term.querySelector('[data-theme-tweak-badge]')) return; // 已存在

  const badge = document.createElement('div');
  badge.setAttribute('data-theme-tweak-badge', '');
  badge.textContent = '🎨';
  badge.style.cssText = 'position:absolute;top:8px;right:12px;z-index:50;font-size:14px';
  term.appendChild(badge);

  // 清理：插件禁用/刷新时移除徽标
  marcel.onCleanup(() => badge.remove());
}

// 定时刷新示例
const timer = setInterval(() => {
  marcel.log.info('tick');
}, 10000);
marcel.onCleanup(() => clearInterval(timer));
```

4. 刷新插件（设置 → 插件 → 刷新），注入立即生效。

### `marcel` API 速查

详见 [API 参考 - 内容脚本注入](./plugin-api.md#内容脚本注入content-script)。

| 命名空间 | 用途 |
|----------|------|
| `marcel.dom` | querySelector / waitForRegion / ready |
| `marcel.overlay` | 创建/移除浮层（挂到 `#marcel-overlays`） |
| `marcel.ipc.call(cmd, args)` | 调用插件 IPC（受 capability 检查） |
| `marcel.events.on(name, cb)` | 订阅 UI 事件（`ui:*`）+ 后端事件（`ssh://status/*` 等） |
| `marcel.events.emit(name, data)` | 发射本地事件 |
| `marcel.onCleanup(fn)` | 注册清理回调 |
| `marcel.log.info/warn/error` | 带前缀的日志 |

### 生命周期

- **激活**：插件启用 + 授权 `ui.inject` + 非安全模式时，按 `runAt` 注入
- **清理**：插件禁用/刷新/重试时，按 LIFO 调用所有 `onCleanup` 回调，移除 `<style>` 标签，清除该插件的浮层
- **重试**：设置页插件卡片可对报错的注入点单独重试

### 与 React 共存的注意事项

主界面由 React 管理。直接修改 React 渲染的 DOM 节点会在下次重渲染时被覆盖。推荐做法：

1. **追加而非修改**：用 `appendChild` 在区域节点末尾加自己的元素，不要改 React 生成的节点属性
2. **监听 `ui:region-mounted` 重注入**：React 卸载/重挂区域时，重新执行你的注入逻辑
3. **用 `onCleanup` 撤销**：确保你加的元素在清理时移除

```js
marcel.events.on('ui:region-mounted', ({ region, el }) => {
  if (region !== 'terminal') return;
  // el 是 [data-region="terminal"] 节点，在此追加你的 UI
});
```

### 浮层示例

```js
// 创建一个固定在右下角的悬浮按钮
const btn = marcel.overlay.create();
btn.style.cssText = 'position:fixed;right:20px;bottom:20px;width:48px;height:48px;border-radius:50%;background:#4f46e5;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px';
btn.textContent = '⚡';
btn.onclick = () => marcel.ipc.call('session.active').then(console.log);
marcel.onCleanup(() => marcel.overlay.dismiss(btn));
```

### 安全模式

插件 JS 同步死循环会卡死主窗口。遇到这种情况：设置 → 插件 → 开启「注入安全模式」→ 重启应用。安全模式跳过所有内容脚本注入，让你能进设置页禁用问题插件。

---

## 配置 UI 开发

插件可以提供自定义配置界面，用户在设置页点击"配置"按钮即可打开。

### 快速开始

1. 在插件目录下创建 `config.html`
2. 在 `plugin.json` 中声明 `configView`：

```json
{
  "id": "my-plugin",
  "configView": "config.html",
  "capabilities": ["fs.read", "fs.write"]
}
```

3. 刷新插件，设置页的插件卡片会出现可点击的"配置"按钮

### 配置文件

配置文件固定为 `config.json`（位于插件目录下）。主应用提供专用命令读写此文件：

| 命令 | 说明 |
|------|------|
| `config.read` | 读取 `config.json` |
| `config.write` | 写入 `config.json` |
| `config.saved` | 通知保存完成，自动关闭弹窗 |

### 安全限制

- 只能读写 `config.json`，无法访问其他文件
- 路径由主应用硬编码，防止路径穿越

### 完整示例

**plugin.json**：
```json
{
  "id": "server-monitor",
  "version": "1.0.0",
  "name": "服务器监控",
  "configView": "config.html",
  "capabilities": ["fs.read", "fs.write", "ssh.list", "ssh.exec"],
  "views": [
    { "id": "dashboard", "mount": "sidebar", "title": "监控", "navGroup": "top" }
  ]
}
```

**config.html**（推荐模式：配色变量 + 安全 IPC + 读取失败报错 + 改动即时写盘；无"保存"按钮）：

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    /* 配色全部用注入的变量（见 API 参考·配置视图），不要写死颜色 */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--font, system-ui, sans-serif);
      background: var(--bg, #18181b);
      color: var(--text, #f4f4f5);
      padding: 20px 24px;
      user-select: none;
      -webkit-user-select: none;
    }
    .card {
      background: var(--bg-secondary, #27272a);
      border: 1px solid var(--border, #3f3f46);
      border-radius: var(--radius-lg, 12px);
      padding: 14px 16px;
      margin-bottom: 14px;
      transition: border-color 180ms ease;
    }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    label { font-size: 13px; }
    .desc { font-size: 11px; color: var(--text-muted, #71717a); margin-top: 2px; }
    input[type="number"], input[type="text"] {
      width: 140px;
      padding: 7px 10px;
      font-size: 13px;
      background: var(--bg-elevated, #1c1c1f);
      color: var(--text, #f4f4f5);
      border: 1px solid var(--border-strong, #52525b);
      border-radius: var(--radius-md, 8px);
      outline: none;
      transition: border-color 150ms ease, box-shadow 150ms ease;
    }
    input[type="number"]:focus, input[type="text"]:focus {
      border-color: var(--accent, #a78bfa);
      box-shadow: 0 0 0 3px rgba(167, 139, 250, 0.18);
    }

    /* 尺寸调整：预览框 + 滑块（拖动实时预览，松手写盘） */
    .size-row { display: flex; align-items: center; gap: 18px; }
    .preview {
      width: 120px; height: 120px;
      flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.35);
      border: 1px dashed var(--border-strong, #52525b);
      border-radius: var(--radius-md, 8px);
      overflow: hidden;
    }
    .preview .dot {
      width: var(--preview-size, 48px);
      height: var(--preview-size, 48px);
      border-radius: 50%;
      background: var(--accent, #a78bfa);
      opacity: 0.85;
    }
    .size-controls { flex: 1; min-width: 0; }
    .size-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
    .size-head label { font-size: 13px; color: var(--text-secondary, #a1a1aa); }
    .size-val {
      font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums;
      color: var(--accent, #a78bfa);
    }
    input[type="range"] {
      width: 100%;
      -webkit-appearance: none;
      appearance: none;
      height: 4px;
      border-radius: 999px;
      background: var(--border-strong, #52525b);
      outline: none;
      cursor: pointer;
    }
    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--accent, #a78bfa);
      border: none;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
      cursor: grab;
      transition: transform 120ms ease, box-shadow 120ms ease;
    }
    input[type="range"]::-webkit-slider-thumb:hover { box-shadow: 0 0 0 5px rgba(167, 139, 250, 0.2); }
    input[type="range"]::-webkit-slider-thumb:active {
      cursor: grabbing;
      transform: scale(1.2);
      box-shadow: 0 0 0 8px rgba(167, 139, 250, 0.22);
    }
    .size-hint { font-size: 11px; color: var(--text-muted, #71717a); margin-top: 6px; }

    /* 开关：按下有回弹，滑块弹簧过渡 */
    .switch {
      position: relative;
      width: 40px; height: 24px;
      flex-shrink: 0;
      background: var(--border-strong, #52525b);
      border-radius: 999px;
      cursor: pointer;
      transition: background 180ms ease;
    }
    .switch:active { transform: scale(0.94); }
    .switch::after {
      content: "";
      position: absolute;
      top: 3px; left: 3px;
      width: 18px; height: 18px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
      transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    .switch.on { background: var(--accent, #a78bfa); }
    .switch.on::after { transform: translateX(16px); }

    /* 操作按钮（如"重置"类）：悬停/按下反馈 */
    button.action {
      padding: 7px 14px;
      font-size: 12.5px;
      font-weight: 550;
      color: var(--text, #f4f4f5);
      background: var(--bg-elevated, #1c1c1f);
      border: 1px solid var(--border-strong, #52525b);
      border-radius: var(--radius-md, 8px);
      cursor: pointer;
      transition: background 150ms ease, border-color 150ms ease, transform 100ms ease;
    }
    button.action:hover { background: var(--border, #3f3f46); }
    button.action:active { transform: scale(0.96); }

    .error-bar {
      display: none;
      margin-bottom: 14px;
      padding: 9px 12px;
      font-size: 12px;
      color: var(--danger, #f87171);
      background: rgba(248, 113, 113, 0.08);
      border: 1px solid rgba(248, 113, 113, 0.25);
      border-radius: var(--radius-md, 8px);
    }
    .error-bar.show { display: block; }

    /* 自定义滚动条（与主应用一致） */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--border, #3f3f46);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover { background: var(--border-strong, #52525b); }
  </style>
</head>
<body>
  <div class="error-bar" id="errorBar"></div>

  <!-- 尺寸调整：预览 + 滑块（拖动实时预览，松手写盘） -->
  <div class="card">
    <div class="size-row">
      <div class="preview"><div class="dot" id="previewDot"></div></div>
      <div class="size-controls">
        <div class="size-head">
          <label>元素大小</label>
          <span class="size-val" id="sizeVal">48 px</span>
        </div>
        <input type="range" id="size" min="24" max="96" step="4" value="48">
        <div class="size-hint">预览随滑块实时变化，松手后写盘</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="row">
      <div>
        <label>刷新间隔（秒）</label>
        <div class="desc">数字输入框，改动即时生效</div>
      </div>
      <input id="interval" type="number" value="5" min="1" max="60">
    </div>
  </div>

  <div class="card">
    <div class="row">
      <div>
        <label>状态变化时发送通知</label>
        <div class="desc">开关，点击即时生效</div>
      </div>
      <div class="switch" id="notify"></div>
    </div>
  </div>

  <script>
    (() => {
      const PLUGIN_ID = 'server-monitor';
      const DEFAULTS = { interval: 5, notify: false, size: 48 };

      // __TAURI__ 在子 WebView 可能不可用，安全解构 + 兜底
      const tauriEvent = window.__TAURI__ && window.__TAURI__.event;
      const emit = tauriEvent ? tauriEvent.emit.bind(tauriEvent) : () => Promise.reject(new Error('__TAURI__.event unavailable'));
      const listen = tauriEvent ? tauriEvent.listen.bind(tauriEvent) : () => Promise.reject(new Error('__TAURI__.event unavailable'));

      const intervalInput = document.getElementById('interval');
      const notifySwitch = document.getElementById('notify');
      const sizeInput = document.getElementById('size');
      const sizeVal = document.getElementById('sizeVal');
      const previewDot = document.getElementById('previewDot');
      const errorBar = document.getElementById('errorBar');

      let cfg = { ...DEFAULTS };

      function showError(msg) {
        errorBar.textContent = msg;
        errorBar.classList.add('show');
      }
      function syncSwitch() {
        notifySwitch.classList.toggle('on', cfg.notify !== false);
      }
      function syncSize(px) {
        sizeVal.textContent = px + ' px';
        // 预览 1:1 真实像素：所见即所得
        document.documentElement.style.setProperty('--preview-size', px + 'px');
      }

      // 带超时和错误分支的 IPC 封装：失败不会永久挂起
      function ipc(cmd, args, timeoutMs) {
        timeoutMs = timeoutMs || 5000;
        args = args || {};
        const id = 'cfg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        return new Promise((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('ipc "' + cmd + '" timed out'));
          }, timeoutMs);
          listen('plugin-response-' + id, (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (e.payload && e.payload.ok) resolve(e.payload.data);
            else reject(new Error(String(e.payload && e.payload.data)));
          })
            .then((unlisten) => {
              if (settled) { unlisten(); return; }
              emit('plugin-request', { id, pluginId: PLUGIN_ID, cmd, args }).catch((err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error('emit failed: ' + err));
              });
            })
            .catch((err) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(new Error('listen failed: ' + err));
            });
        });
      }

      // 改动即时写盘：无需"保存"按钮
      function persist() {
        ipc('config.write', { content: JSON.stringify(cfg, null, 2) })
          .catch((e) => {
            console.error('[config] save failed:', e);
            showError('保存失败: ' + e.message);
          });
      }

      // 初始化：读取真实配置，失败必须明确报错（不显示假状态）
      (async function init() {
        try {
          const raw = await ipc('config.read');
          if (raw) Object.assign(cfg, JSON.parse(raw));
        } catch (e) {
          console.error('[config] init failed:', e);
          showError('无法读取配置（' + (e && e.message ? e.message : e) + '），当前显示默认值。');
        }
        intervalInput.value = cfg.interval || DEFAULTS.interval;
        sizeInput.value = cfg.size || DEFAULTS.size;
        syncSize(sizeInput.value);
        syncSwitch();
      })();

      intervalInput.addEventListener('change', () => {
        cfg.interval = parseInt(intervalInput.value, 10) || DEFAULTS.interval;
        persist();
      });

      // 滑块：拖动只改预览（零 IPC），松手才写盘
      sizeInput.addEventListener('input', () => syncSize(sizeInput.value));
      sizeInput.addEventListener('change', () => {
        cfg.size = Number(sizeInput.value);
        persist();
      });

      notifySwitch.addEventListener('click', () => {
        cfg.notify = !(cfg.notify !== false);
        syncSwitch();
        persist();
      });
    })();
  </script>
</body>
</html>
```

> 说明：若插件需要在保存后**关闭配置弹窗**（旧式"保存按钮"模式），在 `persist()` 成功后调用 `config.saved` 即可（见 [API 参考·配置视图·保存流程](./plugin-api.md#配置视图)）。即时写盘模式不需要它。

### 弹窗行为

- 尺寸：896px 宽，80vh 高
- 关闭方式：关闭按钮、ESC、点击遮罩、调用 `config.saved`
- WebView 生命周期：打开时创建，关闭时销毁

---

## 开发与调试

### 刷新插件

修改插件文件后，进入 **设置 → 插件** → 点击 **刷新**。

### 查看日志

- 按 `F12` 打开主窗口 DevTools
- Console 中可看到 IPC 相关日志
- 插件加载失败会在插件区域显示错误信息（加载失败显示重试按钮，运行时错误显示"禁用此插件"按钮）

### 常见问题

| 症状 | 原因 |
|------|------|
| 插件不显示 | `plugin.json` 格式错误、文件夹名与 `id` 不一致 |
| 视图不出现 | `entry` 文件不存在、`mount` 值拼写错误 |
| IPC 无响应 | 未声明对应 capability、`pluginId` 不匹配 |
| 资源加载失败 | 路径含 `../`（被拒绝）、文件不存在 |
| Agent 工具不生效 | 当前处于 Plan 模式，需切换到 Agent/Auto |
| 事件订阅无效果 | 未声明 `events` capability、事件模式拼写错误 |

---

## 完整示例：服务器监控插件

### 文件结构

```
server-monitor/
  plugin.json
  index.html
  icon.svg
```

### plugin.json

```json
{
  "id": "server-monitor",
  "version": "1.0.0",
  "name": "服务器监控",
  "description": "实时监控服务器 CPU、内存使用情况",
  "capabilities": ["ssh.list", "ssh.exec"],
  "views": [
    {
      "id": "dashboard",
      "mount": "sidebar",
      "title": "监控",
      "icon": { "kind": "svg", "src": "icon.svg" },
      "navGroup": "top",
      "order": 50
    }
  ],
  "agentTools": [
    {
      "name": "server_status",
      "description": "获取服务器运行状态（CPU、内存、磁盘）",
      "command": "top -bn1 | head -20",
      "parameters": {},
      "riskLevel": "ReadOnly"
    }
  ]
}
```

### index.html

```html
<!DOCTYPE html>
<html>
<body style="background:#18181b;color:#e4e4e7;padding:16px;font-family:sans-serif">
  <h3 style="margin:0 0 12px">服务器监控</h3>
  <button id="btn" style="padding:6px 12px;background:#3f3f46;color:#fff;border:none;border-radius:6px;cursor:pointer">
    刷新状态
  </button>
  <pre id="out" style="margin-top:12px;font-size:13px;white-space:pre-wrap;color:#a1a1aa"></pre>

  <script>
    const { emit, listen } = window.__TAURI__.event;
    let counter = 0;

    async function getStatus() {
      const sessionId = await getSessionId();
      if (!sessionId) {
        document.getElementById('out').textContent = '没有活跃的 SSH 会话';
        return;
      }

      const id = String(++counter);
      const unlisten = await listen(`plugin-response-${id}`, (e) => {
        if (e.payload.ok) {
          document.getElementById('out').textContent = e.payload.data;
        } else {
          document.getElementById('out').textContent = '错误: ' + e.payload.data;
        }
        unlisten();
      });
      await emit('plugin-request', {
        id,
        pluginId: 'server-monitor',
        cmd: 'ssh_exec',
        args: { sessionId, command: 'top -bn1 | head -20' }
      });
    }

    async function getSessionId() {
      const id = String(++counter);
      return new Promise((resolve) => {
        listen(`plugin-response-${id}`, (e) => {
          resolve(e.payload.ok ? e.payload.data?.sessionId : null);
        }).then(() => {
          emit('plugin-request', {
            id,
            pluginId: 'server-monitor',
            cmd: 'session.active',
            args: {}
          });
        });
      });
    }

    document.getElementById('btn').onclick = getStatus;
    getStatus();
  </script>
</body>
</html>
```

---

## 示例插件：长期记忆（long-term-memory）

这是一个**完整可分发的示例插件**，演示 `kind=local` 工具 + `systemPromptSection` + 通用 handler 的组合用法。它让 Agent 自己判断哪些关键信息值得"记到小本本上"，并在下次连接同一台服务器时主动想起，避免重复犯错、重复询问。

> 这是 `kind=local` 能力的参考实现——所有 memory 逻辑（数据结构、文件格式、读写规则）都在插件里，内核零 memory 专用代码。

### 功能

- Agent 在对话中调用 `memory_save` 把关键信息追加到当前连接的记忆文件
- 每次会话开始 Agent 自动 `memory_recall` 查看已记录的记忆
- 通过 `memory_update` / `memory_delete` 修改或删除记忆（先 recall 再全量写回）
- 记忆按连接（`host_port`）隔离，A 服务器的记忆不会污染 B 服务器
- 侧栏面板可手工查看/编辑/新增/删除记忆

### 安装

将仓库内的示例目录复制到你的插件目录：

```
<app-config-dir>/plugins/
  long-term-memory/        ← 从 examples/plugins/long-term-memory/ 复制
    plugin.json
    index.html
    system-prompt.md
    memories/              ← 运行时自动创建
      1.2.3.4_22.jsonl
      ...
```

> `<app-config-dir>` 因平台而异（详见 [快速开始](#1-创建插件目录)）。复制后在 **设置 → 插件** 点刷新即可。

### manifest 摘要

```json
{
  "id": "long-term-memory",
  "version": "1.0.3",
  "name": "长期记忆",
  "description": "让 Agent 选择性地把关键信息记到小本本上，按连接隔离",
  "capabilities": ["ssh.list", "fs.read", "fs.write", "events"],
  "systemPromptSection": "system-prompt.md",
  "views": [
    {
      "id": "panel",
      "mount": "sidebar",
      "title": "记忆",
      "navGroup": "top",
      "order": 60,
      "entry": "index.html"
    }
  ],
  "agentTools": [
    {
      "name": "memory_save",
      "description": "把一条记忆追加到当前连接的小本本...",
      "kind": "local",
      "handler": "fs.append",
      "command": "{\"path\":\"memories/{{__host_port__}}.jsonl\"}",
      "parameters": { "type": "object", "properties": { "content": { "type": "string" } }, "required": ["content"] },
      "riskLevel": "LowRisk"
    },
    {
      "name": "memory_recall",
      "description": "读取当前连接已记录的所有记忆...",
      "kind": "local",
      "handler": "fs.read",
      "command": "{\"path\":\"memories/{{__host_port__}}.jsonl\"}",
      "parameters": {},
      "riskLevel": "ReadOnly"
    },
    {
      "name": "memory_update",
      "description": "修改已有记忆（需先 recall 再全量写回）...",
      "kind": "local",
      "handler": "fs.write",
      "command": "{\"path\":\"memories/{{__host_port__}}.jsonl\"}",
      "parameters": { "type": "object", "properties": { "content": { "type": "string" } }, "required": ["content"] },
      "riskLevel": "LowRisk"
    },
    {
      "name": "memory_delete",
      "description": "删除记忆（需先 recall 再全量写回）...",
      "kind": "local",
      "handler": "fs.write",
      "command": "{\"path\":\"memories/{{__host_port__}}.jsonl\"}",
      "parameters": { "type": "object", "properties": { "content": { "type": "string" } }, "required": ["content"] },
      "riskLevel": "LowRisk"
    }
  ]
}
```

### 工作原理

四个 memory 工具全部用 `kind=local` + 通用 fs handler 组合实现，**没有任何 memory 专用 handler**：

| 工具 | handler | path 模板（固定，模型不能传） | 模型传参 | 行为 |
|------|---------|------------------------------|----------|------|
| `memory_save` | `fs.append` | `memories/{{__host_port__}}.jsonl` | `content`（一行 JSON 字符串，即一条 entry） | 追加一行 |
| `memory_recall` | `fs.read` | `memories/{{__host_port__}}.jsonl` | 无 | 返回文件全文 |
| `memory_update` | `fs.write` | `memories/{{__host_port__}}.jsonl` | `content`（全量新内容，多行 JSONL） | 全量覆盖 |
| `memory_delete` | `fs.write` | `memories/{{__host_port__}}.jsonl` | `content`（删除后剩余内容） | 全量覆盖 |

关键设计：

- **`path` 写死在 `command` 字段**（含 `{{__host_port__}}` 上下文变量），不暴露给 `parameters` schema，模型无法写到任意路径
- **按连接隔离**：`{{__host_port__}}` 自动替换为 `1.2.3.4_22`，每台服务器一个独立的 `.jsonl` 文件
- **`systemPromptSection`** 静态段在 Agent 模式下自动拼到 system prompt 末尾，引导模型"会话开始主动 recall""遇到用户偏好/服务器事实/坑主动 save"

### 记忆文件格式

每行一个 JSON 对象（JSONL），字段：

```json
{"id":"mem_1720000000_a1b2","type":"pitfall","title":"systemd 需 --no-block","content":"这台机器 systemctl restart 会卡，需加 --no-block 参数","tags":["systemd"],"createdAt":1720000000,"updatedAt":1720000000}
```

- `id`：`mem_` + 时间戳 + 4 位随机 hex
- `type`：`user_preference` / `server_info` / `pitfall`（用户偏好 / 服务器事实 / 注意事项）
- `title` / `content` / `tags` / `createdAt` / `updatedAt`

### 使用方法

1. **安装插件**：复制示例目录到 `<app-config-dir>/plugins/long-term-memory/`，刷新插件
2. **连接 SSH 服务器**，切到 Agent 模式
3. **正常对话**：当你说"以后提交信息用中文"或 Agent 发现"nginx 在 /opt/nginx"时，它会自动调用 `memory_save` 记录
4. **下次连接同一服务器**：Agent 会话开始时自动 `memory_recall`，看到之前的记忆，主动避免重复询问

侧栏"记忆"按钮可手动浏览/编辑/删除记忆。

侧栏「当前连接」列表会订阅 `ssh://session-active` 与 `ssh://status/*`（`events` 能力），在切换 SSH Tab、连接成功/断开时自动刷新，并以低频状态校验作为丢事件兜底。

### 开发参考

如果你想做一个类似的"按连接隔离的本地数据"插件，可以参考 long-term-memory 的模式：

1. 用 `kind=local` + `fs.read`/`fs.write`/`fs.append` 做本地数据读写
2. `command` 字段用 `{{__host_port__}}` 模板实现按连接隔离
3. `systemPromptSection` 引导模型何时调用工具
4. 工具 `description` 写清楚参数格式和调用时机（这是模型正确使用的关键）
5. 侧栏 UI 用 `events.subscribe` 订阅 `ssh://session-active`（及可选 `ssh://status/*`）跟随当前会话

完整字段定义详见 [API 参考](./plugin-api.md)。

---

## 上架到插件市场

Marcel SSH 有官方插件市场（GitHub 托管，应用内可浏览/跳转下载），仓库：

**https://github.com/q541810/marcel-ssh-plugins**

### 插件仓库规范

- **`plugin.json` 必须位于插件仓库根目录**（市场索引从它提取 id/version/name/description/minAppVersion/capabilities）
- 建议提供 `README.md`：功能介绍、安装方式、配置说明、使用示例
- 仓库必须公开

### 上架流程

1. 在[市场仓库](https://github.com/q541810/marcel-ssh-plugins)创建 [插件上架 Issue](../../../q541810/marcel-ssh-plugins/issues/new?template=plugin-submit.md)
2. 按模板填写插件 ID、仓库地址（owner/repo）、分类、图标，勾选确认事项
3. 机器人自动校验（仓库可达 / plugin.json 合法 / 确认事项勾选），结果评论在 Issue 中
   - ✅ 通过 → 自动收录，刷新 `index.json`
   - ❌ 失败 → 评论原因，编辑 Issue 重新触发或重新提交

**更新插件**：修改插件仓库发布新版本后，重新提交模板（插件 ID 不变即视为更新）或编辑原 Issue。

### 索引协议

应用侧市场功能读取市场仓库的 `index.json`（机器人自动生成，不要手改）：

```jsonc
{ "plugins": [{ "id", "name", "version", "publisher", "minAppVersion",
  "description", "capabilities", "category", "icon", "repoUrl", "updatedAt" }] }
```

- `repoUrl` 指向插件仓库，应用内"下载"即跳转该仓库网页
- `icon`：`{ "kind": "emoji" | "img", "value": "..." }`
- 市场源可配置：内置官方源（GitHub），或自定义源（镜像 index.json 地址 + 可选仓库地址重写规则）

---

## 更多

- [API 参考](./plugin-api.md) — 完整的字段定义、协议格式
