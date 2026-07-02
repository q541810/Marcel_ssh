# 插件 API 参考

本文档是 Marcel SSH 插件系统的完整 API 参考。如需入门指南，请参阅 [插件开发指南](./plugin-development.md)。

---

## plugin.json Manifest 格式

```jsonc
{
  "id": "my-plugin",              // 必须。与文件夹名一致。
  "version": "1.0.0",             // 必须。语义化版本号。
  "name": "我的插件",              // 必须。显示名称。
  "publisher": "developer",       // 可选。发布者。
  "description": "插件描述",       // 可选。
  "capabilities": ["ssh.list"],   // 可选。声明需要的权限。
  "views": [...],                 // 可选。视图定义。
  "agentTools": [...],            // 可选。Agent 工具定义。
  "injections": [...],            // 可选。内容脚本注入（需 ui.inject 权限）。
  "configView": "config.html"     // 可选。配置视图入口文件。
}
```

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 插件唯一标识，与文件夹名一致 |
| `version` | string | 是 | 语义化版本号 |
| `name` | string | 是 | 显示名称 |
| `publisher` | string | 否 | 发布者 |
| `description` | string | 否 | 描述 |
| `capabilities` | string[] | 否 | 声明的权限列表 |
| `views` | ViewDef[] | 否 | 视图定义列表 |
| `agentTools` | AgentToolDef[] | 否 | Agent 工具定义列表 |
| `injections` | InjectionDef[] | 否 | 内容脚本注入定义列表 |
| `configView` | string | 否 | 配置视图入口文件路径（相对于插件根目录） |

---

## 视图定义

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 视图唯一标识（在插件内简短即可，如 `main`。最终 ID 自动拼接为 `<plugin-id>.<view-id>`） |
| `mount` | string | 是 | 挂载点：`sidebar` / `bottom` |
| `title` | string | 是 | 显示标题 |
| `icon` | IconDef | 否 | 图标定义 |
| `navGroup` | string | 否 | 导航分组：`top` / `bottom`（sidebar 视图必须） |
| `order` | number | 否 | 排序权重（越小越靠前，默认 100） |
| `entry` | string | 否 | WebView 入口文件路径（相对于插件根目录，默认 `index.html`） |
| `exclusive` | boolean | 否 | 是否独占模式（如设置页，默认 false） |

### 挂载点

| 挂载点 | 说明 |
|--------|------|
| `sidebar` | 左侧面板。需要设置 `navGroup`。 |
| `bottom` | 终端底部面板，以 tab 形式与内置 tab 共存。需要已连接的 SSH 会话。 |

> `agent` 挂载点被内置 Agent 面板（`builtin.agent`，不可禁用）常驻占用，且代码只取 order 最小的 provider，插件无法实际使用，不对外暴露。`center` 挂载点被内置终端/设置占用，同理不对外暴露。

### 图标定义

```jsonc
{ "kind": "svg", "src": "icon.svg" }   // SVG 图标
{ "kind": "img", "src": "icon.png" }   // 图片图标
```

`src` 是相对于插件根目录的路径，通过 `plugin://<plugin-id>/<src>` 协议加载。

---

## Agent 工具定义

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 工具名称（Agent 调用时使用） |
| `description` | string | 是 | 工具描述（Agent 可见） |
| `command` | string | 是 | 命令模板。`{{param}}` 为参数占位符 |
| `parameters` | JSON Schema | 否 | 参数 JSON Schema |
| `riskLevel` | string | 否 | 风险等级：`ReadOnly` / `LowRisk` / `Moderate` / `HighRisk`（默认 `Moderate`） |

> Agent 工具仅在 Agent 模式和 Auto 模式下可用，Chat 模式下不注册。

---

## 内容脚本注入（Content Script）

插件可以像浏览器扩展一样，把 JS/CSS 注入**主窗口**运行，直接操控主界面 DOM（改样式、加浮层、重塑布局、加按钮徽标等）。需要声明 `ui.inject` capability。

### 注入定义

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 注入项 ID（插件内唯一，如 `main-ui`） |
| `matches` | string[] | 否 | 目标区域名（信息性，见下表）；`["*"]` 表示始终注入 |
| `styles` | string[] | 否 | CSS 文件路径（相对插件根目录），注入为全局 `<style>` |
| `scripts` | string[] | 否 | JS 文件路径，执行时以 `marcel` 运行时对象为唯一参数 |
| `runAt` | string | 否 | 注入时机：`idle`（默认，空闲时）/ `instant`（立即） |
| `order` | number | 否 | 多插件排序权重（越小越早，默认 100） |

```jsonc
{
  "injections": [
    {
      "id": "main-ui",
      "matches": ["*"],
      "styles": ["theme.css"],
      "scripts": ["content.js"],
      "runAt": "idle",
      "order": 100
    }
  ]
}
```

> `matches` 是信息性字段——JS/CSS 总是全局注入，插件通过 `marcel.events.on('ui:region-mounted', ...)` 决定是否对某区域生效。这避免主应用在区域切换时反复重执行脚本。

### 区域名（`data-region`）

主应用在关键布局区域标记了 `data-region` 属性，`matches` 和 `marcel.dom.waitForRegion()` 使用这些名字：

| 区域名 | 说明 |
|--------|------|
| `sidebar` | 左侧面板（顶层布局区域） |
| `center` | 中央内容区（顶层布局区域） |
| `agent` | 右侧 Agent 面板（顶层布局区域） |
| `terminal` | 终端组件根 |
| `settings` | 设置页根 |
| `sessions` | 会话/连接列表 |
| `skills` | 技能列表 |
| `mcp` | MCP 列表 |
| `agent-panel` | Agent 面板内容 |

### `marcel` 运行时 API

每个被注入的 JS 文件以 `marcel` 对象为唯一参数执行：

```js
// content.js
export default function (marcel) { /* 不支持，见下方说明 */ }
```

> 注意：注入脚本不是 ES 模块，不能用 `export`/`import`。它是一段普通 JS，通过 `new Function('marcel', code)` 执行，顶层 `await` 可用。

#### `marcel.dom`

| 成员 | 类型 | 说明 |
|------|------|------|
| `querySelector(sel)` | `(string) => Element \| null` | 等价 `document.querySelector` |
| `querySelectorAll(sel)` | `(string) => Element[]` | 等价 `document.querySelectorAll` |
| `body` | `HTMLElement` | `document.body` |
| `head` | `HTMLHeadElement` | `document.head` |
| `ready(cb)` | `(fn) => void` | 空闲回调（`requestIdleCallback` 退化到 `setTimeout`） |
| `waitForRegion(region, timeoutMs?)` | `(string, number?) => Promise<HTMLElement \| null>` | 等待 `[data-region=...]` 出现，超时返回 null |

#### `marcel.overlay`

| 成员 | 类型 | 说明 |
|------|------|------|
| `create(opts?)` | `({className?}) => HTMLDivElement` | 创建浮层 div，挂到共享容器 `#marcel-overlays`，标记 `data-plugin-id` |
| `dismiss(el)` | `(HTMLElement) => void` | 移除浮层 |

共享容器 `#marcel-overlays` 是 `position:fixed; inset:0; pointer-events:none` 的覆盖层。`create()` 返回的 div 默认 `pointer-events:auto`，插件自行定位/填充。禁用插件时主应用自动清除该插件的所有浮层。

#### `marcel.ipc`

| 成员 | 类型 | 说明 |
|------|------|------|
| `call(cmd, args?)` | `(string, object?) => Promise<unknown>` | 调用插件 IPC 命令，走 `plugin-request` 管道，受 capability 检查 |

```js
const session = await marcel.ipc.call('session.active');
const out = await marcel.ipc.call('ssh_exec', { sessionId: session.sessionId, command: 'uptime' });
```

#### `marcel.events`

| 成员 | 类型 | 说明 |
|------|------|------|
| `on(eventName, cb)` | `(string, fn) => () => void` | 订阅事件，返回取消函数 |
| `emit(eventName, data?)` | `(string, unknown?) => void` | 发射本地事件（插件间/自身） |

`on` 统一处理两类事件：
- **UI 桥事件**（`ui:*`）和插件自定事件（`<pluginId>:*`）：本地内存总线，无网络往返
- **后端事件**（如 `ssh://status/*`）：自动调用 `events.subscribe` IPC 订阅，按模式匹配转发

##### UI 桥事件

| 事件 | Payload | 说明 |
|------|---------|------|
| `ui:nav-change` | `{ from: string \| null, to: string }` | 活跃视图切换 |
| `ui:region-mounted` | `{ region: string, el: HTMLElement }` | 区域 DOM 节点挂载 |
| `ui:region-unmounted` | `{ region: string, el: HTMLElement }` | 区域 DOM 节点卸载 |

##### 后端事件

与 `events` capability 的可订阅事件一致（`ssh://status/*`、`agent://stream/*` 等），通配符匹配。

#### `marcel.onCleanup(fn)`

注册清理回调。插件禁用/刷新/重试时按 LIFO 顺序调用。插件应在此移除自己添加的 DOM 节点、监听器、定时器。

```js
const interval = setInterval(tick, 5000);
marcel.onCleanup(() => clearInterval(interval));
```

#### `marcel.log`

| 成员 | 说明 |
|------|------|
| `info(...args)` / `warn(...args)` / `error(...args)` | 带 `[plugin:<id>/<injId>]` 前缀的 console 输出，便于排查 |

### 错误隔离边界

- 同步抛错 + 顶层 `await` 的 rejected promise → 捕获并写入注入状态，设置页显示红点 + 重试按钮
- 插件自己写的裸 `setTimeout(async ...)` / 自由 `fetch` 的未捕获 rejection → **不**被引擎捕获，走浏览器默认行为，不崩溃主 UI
- 同步死循环会阻塞主窗口 → 开启**注入安全模式**（设置 → 插件）跳过所有注入自救，重启后生效

---

## 配置视图

插件可以提供自定义配置界面，在设置页的插件卡片中通过"配置"按钮打开。

### 声明配置视图

在 `plugin.json` 中添加 `configView` 字段：

```jsonc
{
  "id": "my-plugin",
  "configView": "config.html",
  "capabilities": ["fs.read", "fs.write"],
  // ...
}
```

`configView` 是相对于插件根目录的入口文件路径。

### 配置文件

配置文件固定为插件目录下的 `config.json`。插件通过专用命令读写此文件，无需关心路径。

### 配置命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `config.read` | 无 | `string` | 读取 `config.json` 内容 |
| `config.write` | `{content}` | `void` | 写入 `config.json` |
| `config.saved` | 无 | `{ok: true}` | 通知主应用保存完成，自动关闭配置弹窗 |

这些命令需要 `fs.read` / `fs.write` capability。

### 安全限制

- `config.read` / `config.write` **只能**读写 `config.json`，不能访问其他文件
- 路径由主应用硬编码，插件无法指定其他路径
- 写入时自动创建 `config.json`（如果不存在）

### 保存流程

```javascript
const { emit, listen } = window.__TAURI__.event;

async function saveConfig(config) {
  const id = Date.now().toString();
  
  // 1. 写入配置
  const unlisten = await listen(`plugin-response-${id}`, async (e) => {
    if (!e.payload.ok) {
      console.error('保存失败:', e.payload.data);
      unlisten();
      return;
    }
    
    // 2. 通知主应用保存完成
    const saveId = Date.now().toString();
    await emit('plugin-request', {
      id: saveId,
      pluginId: 'my-plugin',
      cmd: 'config.saved',
      args: {}
    });
    unlisten();
  });
  
  await emit('plugin-request', {
    id,
    pluginId: 'my-plugin',
    cmd: 'config.write',
    args: { content: JSON.stringify(config, null, 2) }
  });
}
```

### 配置弹窗行为

- 弹窗尺寸：`xl`（896px 宽，80vh 高）
- 关闭方式：点击关闭按钮、按 ESC、点击遮罩、调用 `config.saved`
- WebView 生命周期：打开时创建，关闭时销毁

---

## Capability 系统

| Capability | 授予权限 | 安全等级 |
|-----------|---------|---------|
| `ssh.list` | 查询 SSH 会话与连接信息 | 低 |
| `ssh.exec` | 执行远程命令 | 高 |
| `sftp.read` | 读取远程文件 | 中 |
| `sftp.write` | 写入远程文件 | 高 |
| `fs.read` | 读取本地文件（仅限插件目录） | 中 |
| `fs.write` | 写入本地文件（仅限插件目录） | 高 |
| `net.request` | 发起 HTTP/HTTPS 网络请求 | 高 |
| `notification` | 发送系统通知 | 低 |
| `events` | 订阅应用事件 | 低 |
| `ui.inject` | 注入主界面（JS/CSS），访问主窗口 DOM | 高 |

### `ssh.list` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `ssh_list_sessions` | 无 | `string[]` | 列出所有会话 ID |
| `session.active` | 无 | `{sessionId, connectionId, status, configId} \| null` | 获取当前活跃会话 |
| `session.info` | `{sessionId}` | `{sessionId, connectionId, status, createdAt, configId} \| null` | 查询会话详情 |
| `connection.info` | `{connectionId}` | `{id, name, host, port, username, group} \| null` | 查询保存的连接信息 |
| `connection.list` | 无 | `Array<{id, name, host, port, username, group}>` | 列出所有保存的连接 |

> `session.info` 返回的 `connectionId` 是连接标签（如 `root@1.2.3.4:22`），`configId` 是保存的连接 ID（可用于 `connection.info` 查询详情）。

### `ssh.exec` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `ssh_exec` | `{sessionId, command}` | `string` | 在远程服务器执行命令并返回输出 |

### `sftp.read` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `sftp_read_file` | `{sessionId, path}` | `{content, mtime}` | 读取远程文件（最大 2MB，UTF-8） |

### `sftp.write` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `sftp_write_file` | `{sessionId, path, content}` | `void` | 写入远程文件（创建或覆盖） |

### `fs.read` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `fs.read` | `{path}` | `string` | 读取插件目录下的本地文件 |

`path` 相对于插件根目录，不允许 `../`。

### `fs.write` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `fs.write` | `{path, content}` | `void` | 写入插件目录下的本地文件 |

`path` 相对于插件根目录，自动创建中间目录，不允许 `../`。

### `net.request` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `net.request` | `{url, method?, headers?, body?}` | `{status, headers, body, url}` | HTTP 请求 |

支持 GET、POST、PUT、DELETE、PATCH、HEAD。超时 20 秒，响应体最大 256KB。

### `notification` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `notification` | `{title, body}` | `void` | 发送系统通知 |

标题自动添加 `[插件ID]` 前缀。

### `events` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `events.subscribe` | `{events: string[]}` | `{subscribed: string[]}` | 订阅事件，支持通配符（如 `ssh://status/*`） |
| `events.unsubscribe` | `{events: string[]}` | `{unsubscribed: string[]}` | 取消订阅事件 |

#### 可订阅事件

| 事件模式 | 说明 | Payload |
|----------|------|---------|
| `ssh://status/*` | SSH 连接状态变化 | `SshStatus`（connected/disconnected/error） |
| `agent://stream/*` | Agent 任务流 | `StreamEvent`（textDelta/toolCall/done/error） |
| `agent://plan/*` | Agent 计划流 | `PlanStreamEvent` |
| `sftp-upload-progress` | SFTP 上传进度 | `{uploadId, written, total}` |
| `sftp-upload-done` | SFTP 上传完成 | `{uploadId}` |
| `sftp-download-progress` | SFTP 下载进度 | `{downloadId, written, total}` |
| `sftp-download-done` | SFTP 下载完成 | `{downloadId}` |

#### 接收事件

订阅后，通过 `plugin-event-<pluginId>` 事件接收：

```javascript
await listen('plugin-event-my-plugin', (e) => {
  // e.payload = { event: 'ssh://status/xxx', data: { status: 'connected' } }
});
```

### 授权模型

- 插件在 `plugin.json` 中声明需要的 capabilities
- 用户可在设置页逐项授权/收回
- 未声明的 capability 无法使用
- 首次安装时所有声明的 capability 默认授权

---

## IPC 协议

### 请求格式

```json
{
  "id": "请求唯一标识（字符串，用于匹配响应）",
  "pluginId": "插件 ID",
  "cmd": "要执行的命令",
  "args": { "参数对象" }
}
```

通过 `emit('plugin-request', ...)` 发送。

### 响应格式

成功：
```json
{ "ok": true, "data": { "返回数据" } }
```

失败：
```json
{ "ok": false, "data": "错误信息" }
```

通过 `listen('plugin-response-<id>', ...)` 接收。

### HTTP API 端点

除了事件 IPC，插件还可以通过 `plugin://` 协议的 HTTP API 端点调用命令：

```
POST plugin://<pluginId>/api/<cmd>
Content-Type: application/json

{ "参数对象" }
```

响应格式与事件 IPC 相同：`{ "ok": true, "data": ... }` 或 `{ "ok": false, "data": "错误信息" }`。

#### 示例

```javascript
const res = await fetch('plugin://my-plugin/api/ssh_exec', {
  method: 'POST',
  body: JSON.stringify({ sessionId: 'xxx', command: 'uptime' }),
});
const { ok, data } = await res.json();
if (ok) {
  console.log('输出:', data);
}
```

#### 限制

- HTTP API 支持所有后端命令和插件域命令
- 虚拟命令（`session.active` 等）通过后端状态实现，行为可能与前端略有差异
- 同步执行，长时间命令可能阻塞 WebView 网络线程

### 示例

```javascript
const { emit, listen } = window.__TAURI__.event;

const id = '1';
await listen(`plugin-response-${id}`, (e) => {
  if (e.payload.ok) {
    console.log('成功:', e.payload.data);
  } else {
    console.error('失败:', e.payload.data);
  }
});
await emit('plugin-request', {
  id,
  pluginId: 'my-plugin',
  cmd: 'session.active',
  args: {}
});
```

---

## 安全边界

- Capability 检查在主 WebView 的 IPC 代理层执行
- 插件无法绕过 capability 检查直接调用后端命令
- `fs.read` / `fs.write` 限制在插件目录内，路径穿越被拒绝
- `net.request` 支持 HTTP 和 HTTPS，无域名限制
- `sftp.read` / `sftp.write` 需要有效的 SSH 会话 ID
- `plugin://` 协议有路径穿越保护
- 禁用的插件 WebView 返回 403

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-06-26 | 初始版本 |
| 1.1.0 | 2026-06-27 | 补全 capability 实现；拆分为开发指南 + API 参考 |
| 1.2.0 | 2026-06-27 | 新增 `events` capability；新增 HTTP API 端点 |
| 1.3.0 | 2026-06-28 | 新增 `configView` 配置视图功能；支持 `config.read`/`config.write`/`config.saved` 命令 |
| 1.4.0 | 2026-07-02 | 新增内容脚本注入（`injections` 字段 + `ui.inject` capability + `marcel` 运行时 API + `data-region` 区域标记 + UI 事件桥 + 注入安全模式） |
