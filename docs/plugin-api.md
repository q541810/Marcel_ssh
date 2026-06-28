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
| `configView` | string | 否 | 配置视图入口文件路径（相对于插件根目录） |

---

## 视图定义

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 视图唯一标识（在插件内简短即可，如 `main`。最终 ID 自动拼接为 `<plugin-id>.<view-id>`） |
| `mount` | string | 是 | 挂载点：`sidebar` / `center` / `bottom` / `agent` |
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
| `center` | 中央主面板。通常与终端共存。 |
| `bottom` | 底部面板。显示为底部 Tab。 |
| `agent` | 右侧 Agent 面板。 |

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
