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
      "title": "Hello"
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
    index.html           # 默认入口文件（可在 manifest 中用 entry 指定其他文件）
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
- `navGroup`：`sidebar` 视图必须设置，`top` 或 `bottom`
- `order`：排序权重，越小越靠前，默认 100
- `entry`：入口文件路径，相对于插件根目录，默认 `index.html`
- `exclusive`：设为 `true` 独占中央面板（如设置页），默认 `false`

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
- 背景色建议使用 `#18181b`（zinc-900）以匹配应用主题
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

> **注意**：Agent 工具仅在 Agent 模式和 Auto 模式下可用，Chat 模式下不注册。

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

**config.html**：
```html
<!DOCTYPE html>
<html>
<body style="background:#18181b;color:#e4e4e7;padding:24px;font-family:sans-serif">
  <h3 style="margin:0 0 16px">服务器监控 - 配置</h3>
  
  <div style="margin-bottom:12px">
    <label style="display:block;margin-bottom:4px;font-size:13px;color:#a1a1aa">刷新间隔 (秒)</label>
    <input id="interval" type="number" value="5" min="1" max="60"
      style="width:100%;padding:8px;background:#27272a;border:1px solid #3f3f46;border-radius:6px;color:#e4e4e7">
  </div>
  
  <div style="margin-bottom:16px">
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
      <input id="notify" type="checkbox">
      <span style="font-size:13px">状态变化时发送通知</span>
    </label>
  </div>
  
  <button id="save" style="padding:8px 16px;background:#4f46e5;color:#fff;border:none;border-radius:6px;cursor:pointer">
    保存
  </button>
  
  <script>
    const { emit, listen } = window.__TAURI__.event;
    let counter = 0;

    // 读取现有配置
    async function loadConfig() {
      const id = String(++counter);
      return new Promise((resolve) => {
        listen(`plugin-response-${id}`, (e) => {
          if (e.payload.ok && e.payload.data) {
            try {
              const config = JSON.parse(e.payload.data);
              document.getElementById('interval').value = config.interval ?? 5;
              document.getElementById('notify').checked = config.notify ?? false;
            } catch {}
          }
          resolve();
        }).then(() => {
          emit('plugin-request', {
            id,
            pluginId: 'server-monitor',
            cmd: 'config.read',
            args: {}
          });
        });
      });
    }

    // 保存配置
    document.getElementById('save').onclick = async () => {
      const config = {
        interval: parseInt(document.getElementById('interval').value) || 5,
        notify: document.getElementById('notify').checked
      };

      const id = String(++counter);
      await listen(`plugin-response-${id}`, async (e) => {
        if (e.payload.ok) {
          // 通知主应用保存完成
          const saveId = String(++counter);
          await emit('plugin-request', {
            id: saveId,
            pluginId: 'server-monitor',
            cmd: 'config.saved',
            args: {}
          });
        }
      });

      await emit('plugin-request', {
        id,
        pluginId: 'server-monitor',
        cmd: 'config.write',
        args: { content: JSON.stringify(config, null, 2) }
      });
    };

    loadConfig();
  </script>
</body>
</html>
```

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
| Agent 工具不生效 | 当前处于 Chat 模式，需切换到 Agent/Auto |
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

## 更多

- [API 参考](./plugin-api.md) — 完整的字段定义、协议格式
