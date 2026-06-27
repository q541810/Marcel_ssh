# Marcel SSH 插件 API 契约

本文档定义 Marcel SSH 插件系统的完整 API 契约。插件开发者应以此为准。

---

## 目录结构

```
<app-config-dir>/plugins/
  <plugin-id>/
    plugin.json          # 必须。插件 manifest。
    webview/
      index.html         # 插件 WebView 入口文件
      style.css          # 可选。样式文件。
      icon.svg           # 可选。插件图标。
      ...                # 其他前端资源
```

- `<app-config-dir>` 因平台而异：
  - Windows: `C:\Users\<user>\AppData\Roaming\com.marcel.ssh\`
  - macOS: `~/Library/Application Support/com.marcel.ssh/`
  - Linux: `~/.config/com.marcel.ssh/`
- 可通过设置页的"插件目录"复制完整路径。
- `plugin-id` 必须是合法的文件夹名（字母、数字、连字符、下划线）。
- `webview/` 目录下的资源通过 `plugin://<plugin-id>/<path>` 协议加载。
- 资源路径不能越界（不允许 `../`）。

---

## plugin.json Manifest 格式

```jsonc
{
  // 必须。插件唯一标识符，与文件夹名一致。
  "id": "my-plugin",

  // 必须。语义化版本号。
  "version": "1.0.0",

  // 必须。插件显示名称。
  "name": "我的插件",

  // 可选。发布者名称。
  "publisher": "developer",

  // 可选。插件描述。
  "description": "这是一个示例插件",

  // 可选。声明需要的权限。参见 Capability 系统。
  "capabilities": ["ssh.list", "sftp.read"],

  // 可选。插件提供的视图（面板）。参见视图定义。
  "views": [
    {
      "id": "main",
      "mount": "sidebar",
      "title": "我的面板",
      "icon": { "kind": "svg", "src": "icon.svg" },
      "navGroup": "top",
      "order": 100,
      "entry": "webview/index.html",
      "exclusive": false
    }
  ],

  // 可选。插件提供的 Agent 工具。参见 Agent 工具定义。
  "agentTools": [
    {
      "name": "my_tool",
      "description": "执行自定义操作",
      "command": "echo {{message}}",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string", "description": "消息内容" }
        },
        "required": ["message"]
      },
      "riskLevel": "ReadOnly"
    }
  ]
}
```

### 字段说明

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

---

## 视图定义

视图定义插件在 Marcel SSH UI 中显示的面板。

### 字段说明

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
// SVG 图标
{ "kind": "svg", "src": "icon.svg" }

// 图片图标
{ "kind": "img", "src": "icon.png" }
```

- `src` 是相对于插件根目录的路径。
- 通过 `plugin://<plugin-id>/<src>` 协议加载。

---

## Agent 工具定义

Agent 工具让插件为 Marcel SSH 的 AI Agent 提供自定义命令。

### 字段说明

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 工具名称（Agent 调用时使用） |
| `description` | string | 是 | 工具描述（Agent 可见） |
| `command` | string | 是 | 命令模板。`{{param}}` 为参数占位符 |
| `parameters` | JSON Schema | 否 | 参数 JSON Schema |
| `riskLevel` | string | 否 | 风险等级：`ReadOnly` / `LowRisk` / `Moderate` / `HighRisk`（默认 `Moderate`） |

### 命令模板

命令模板使用 `{{param_name}}` 语法引用参数。调用时参数值会替换占位符。

示例：
- 模板：`echo {{message}}`
- 参数：`{ "message": "hello" }`
- 执行：`echo hello`

### 风险等级

| 等级 | 说明 |
|------|------|
| `ReadOnly` | 只读操作，不会修改系统状态 |
| `LowRisk` | 低风险操作，可能创建临时文件 |
| `Moderate` | 中等风险，需要用户确认 |
| `HighRisk` | 高风险操作，需要安全沙箱审查 |

> **注意**：Agent 工具仅在 Agent 模式和 Auto 模式下可用，Chat 模式下不会注册插件工具。

---

## Capability 系统

Capability 定义插件可以调用的后端命令。

### 可用 Capability

| Capability | 授予权限 | 安全等级 |
|-----------|---------|---------|
| `ssh.list` | 列出 SSH 会话、获取当前活跃会话、查询会话/连接信息 | 低 |
| `ssh.exec` | 执行远程命令 | 高 |
| `sftp.read` | 读取远程文件 | 中 |
| `sftp.write` | 写入远程文件 | 高 |
| `fs.read` | 读取本地文件（仅限插件目录） | 中 |
| `fs.write` | 写入本地文件（仅限插件目录） | 高 |
| `net.request` | 发起 HTTP/HTTPS 网络请求 | 高 |
| `notification` | 发送系统通知 | 低 |

### `ssh.list` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `ssh_list_sessions` | 无 | `string[]` | 后端：列出所有会话 ID |
| `session.active` | 无 | `{sessionId, connectionId, status, configId} \| null` | 前端：获取当前活跃会话 |
| `session.info` | `{sessionId: string}` | `{sessionId, connectionId, status, createdAt, configId} \| null` | 前端：通过会话 ID 查询会话信息 |
| `connection.info` | `{connectionId: string}` | `{id, name, host, port, username, group} \| null` | 前端：通过连接 ID 查询保存的连接信息 |
| `connection.list` | 无 | `Array<{id, name, host, port, username, group}>` | 前端：列出所有保存的连接 |

> `session.info` 返回的 `connectionId` 是连接标签（如 `root@1.2.3.4:22`），`configId` 是保存的连接 ID（可用于 `connection.info` 查询详情）。

### `ssh.exec` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `ssh_exec` | `{sessionId: string, command: string}` | `string` | 在远程服务器执行命令并返回输出 |

### `sftp.read` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `sftp_read_file` | `{sessionId: string, path: string}` | `{content: string, mtime: number}` | 读取远程文件内容（最大 2MB，UTF-8） |

> 需要先通过 `session.active` 获取 `sessionId`。

### `sftp.write` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `sftp_write_file` | `{sessionId: string, path: string, content: string}` | `void` | 写入远程文件（创建或覆盖） |

> 需要先通过 `session.active` 获取 `sessionId`。

### `fs.read` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `fs.read` | `{path: string}` | `string` | 读取插件目录下的本地文件 |

> `path` 是相对于插件根目录的路径（如 `config/data.json`）。路径不能越界（不允许 `../`）。

### `fs.write` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `fs.write` | `{path: string, content: string}` | `void` | 写入插件目录下的本地文件 |

> `path` 是相对于插件根目录的路径。自动创建中间目录。路径不能越界。

### `net.request` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `net.request` | `{url: string, method?: string, headers?: object, body?: string}` | `{status: number, headers: object, body: string, url: string}` | 发起 HTTP/HTTPS 请求 |

> 支持 GET、POST、PUT、DELETE、PATCH、HEAD 方法。超时 20 秒。响应体最大 256KB。

### `notification` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `notification` | `{title: string, body: string}` | `void` | 发送系统通知 |

> 通知标题会自动添加 `[插件ID]` 前缀。

### 授权模型

- 插件在 `plugin.json` 中声明需要的 capabilities。
- 用户可以在设置页逐项授权/收回。
- 如果插件未声明某 capability，则无法使用对应功能。
- 如果用户未显式授权（插件首次安装），所有声明的 capability 默认授权。

### 安全边界

- Capability 检查在主 webview 的 IPC 代理层执行。
- 插件无法绕过 capability 检查直接调用后端命令。
- `fs.read` 和 `fs.write` 限制在插件目录内，路径穿越会被拒绝。
- `net.request` 支持 HTTP 和 HTTPS，无域名限制。
- `sftp.read` 和 `sftp.write` 需要有效的 SSH 会话 ID。

---

## IPC 协议

插件 WebView 通过事件与主应用通信。

### 请求格式

插件发送 `plugin-request` 事件：

```json
{
  "id": "请求唯一标识（用于匹配响应）",
  "pluginId": "插件 ID",
  "cmd": "要执行的命令",
  "args": { "参数对象" }
}
```

> `cmd` 可以是后端命令（如 `ssh_list_sessions`）或前端虚拟命令（如 `session.active`）。参见 Capability 系统中的命令列表。

### 响应格式

主应用发送 `plugin-response-<id>` 事件：

```json
{
  "ok": true,
  "data": { "返回数据" }
}
```

或错误：

```json
{
  "ok": false,
  "data": "错误信息"
}
```

### 调用示例

```javascript
const Tauri = window.__TAURI__;

// 发送请求
const requestId = Date.now().toString();
await Tauri.event.emit('plugin-request', {
  id: requestId,
  pluginId: 'my-plugin',
  cmd: 'ssh_list_sessions',
  args: {},
});

// 监听响应
const unlisten = await Tauri.event.listen(`plugin-response-${requestId}`, (e) => {
  if (e.payload.ok) {
    console.log('成功:', e.payload.data);
  } else {
    console.error('失败:', e.payload.data);
  }
  unlisten();
});
```

---

## WebView 入口文件要求

- 必须是合法的 HTML 文件。
- 资源引用使用相对路径（相对于 `webview/` 目录）。
- 调用 IPC 使用 `window.__TAURI__`（自动注入）。
- 背景色建议使用 `#18181b`（zinc-900）以匹配应用主题。
- 不要依赖主 webview 的 DOM 或状态——插件 WebView 是独立的 OS 窗口。

### 可用 API

```javascript
// IPC 通信
const Tauri = window.__TAURI__;
await Tauri.event.emit('plugin-request', { ... });
await Tauri.event.listen('plugin-response-xxx', (e) => { ... });
```

### 资源加载

插件 WebView 中的资源通过 `plugin://<plugin-id>/<path>` 协议加载。

```html
<!-- 加载同目录下的样式 -->
<link rel="stylesheet" href="style.css">

<!-- 加载同目录下的脚本 -->
<script src="app.js"></script>

<!-- 加载图片 -->
<img src="icon.png">
```

---

## 完整示例

```json
{
  "id": "server-monitor",
  "version": "1.0.0",
  "name": "服务器监控",
  "publisher": "marcel-ssh",
  "description": "实时监控服务器状态",
  "capabilities": ["ssh.list", "ssh.exec"],
  "views": [
    {
      "id": "dashboard",
      "mount": "sidebar",
      "title": "监控面板",
      "icon": { "kind": "svg", "src": "icon.svg" },
      "navGroup": "top",
      "order": 100,
      "entry": "webview/index.html",
      "exclusive": false
    },
    {
      "id": "log",
      "mount": "bottom",
      "title": "服务器日志",
      "order": 100,
      "entry": "webview/log.html",
      "exclusive": false
    }
  ],
  "agentTools": [
    {
      "name": "server_status",
      "description": "获取服务器运行状态（CPU、内存、磁盘）",
      "command": "top -bn1 | head -20",
      "parameters": {},
      "riskLevel": "ReadOnly"
    },
    {
      "name": "server_restart",
      "description": "重启指定服务",
      "command": "sudo systemctl restart {{service}}",
      "parameters": {
        "type": "object",
        "properties": {
          "service": {
            "type": "string",
            "description": "服务名称"
          }
        },
        "required": ["service"]
      },
      "riskLevel": "HighRisk"
    }
  ]
}
```

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-06-26 | 初始版本 |
| 1.1.0 | 2026-06-27 | 补全所有 capability 实现：`sftp.read`、`sftp.write`、`fs.read`、`fs.write`、`net.request`、`notification`；添加详细命令说明和安全约束；修正目录结构、view.id 格式、entry 默认值等文档问题 |
