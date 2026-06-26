# Marcel SSH 插件 API 契约

本文档定义 Marcel SSH 插件系统的完整 API 契约。插件开发者应以此为准。

---

## 目录结构

```
~/.marcel/plugins/
  <plugin-id>/
    plugin.json          # 必须。插件 manifest。
    webview/
      index.html         # 插件 WebView 入口文件
      style.css          # 可选。样式文件。
      icon.svg           # 可选。插件图标。
      ...                # 其他前端资源
```

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
      "id": "my-plugin.main",
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
| `id` | string | 是 | 视图唯一标识（格式：`<plugin-id>.<view-id>`） |
| `mount` | string | 是 | 挂载点：`sidebar` / `center` / `bottom` / `agent` |
| `title` | string | 是 | 显示标题 |
| `icon` | IconDef | 否 | 图标定义 |
| `navGroup` | string | 否 | 导航分组：`top` / `bottom`（sidebar 视图必须） |
| `order` | number | 否 | 排序权重（越小越靠前，默认 100） |
| `entry` | string | 是 | WebView 入口文件路径（相对于插件根目录） |
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

---

## Capability 系统

Capability 定义插件可以调用的后端命令。

### 可用 Capability

| Capability | 授予权限 |
|-----------|---------|
| `ssh.list` | 列出 SSH 会话、获取当前活跃会话、查询会话/连接信息 |
| `ssh.exec` | 执行远程命令 |
| `sftp.read` | 读取远程文件 |
| `sftp.write` | 写入远程文件 |
| `fs.read` | 读取本地文件 |
| `fs.write` | 写入本地文件 |
| `net.request` | 发起网络请求 |
| `notification` | 发送通知 |

### `ssh.list` 授权的命令

| 命令 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `ssh_list_sessions` | 无 | `string[]` | 后端：列出所有会话 ID |
| `session.active` | 无 | `{sessionId, connectionId, status, configId} \| null` | 前端：获取当前活跃会话 |
| `session.info` | `{sessionId: string}` | `{sessionId, connectionId, status, createdAt, configId} \| null` | 前端：通过会话 ID 查询会话信息 |
| `connection.info` | `{connectionId: string}` | `{id, name, host, port, username, group} \| null` | 前端：通过连接 ID 查询保存的连接信息 |
| `connection.list` | 无 | `Array<{id, name, host, port, username, group}>` | 前端：列出所有保存的连接 |

> `session.info` 返回的 `connectionId` 是连接标签（如 `root@1.2.3.4:22`），`configId` 是保存的连接 ID（可用于 `connection.info` 查询详情）。

### 授权模型

- 插件在 `plugin.json` 中声明需要的 capabilities。
- 用户可以在设置页逐项授权/收回。
- 如果插件未声明某 capability，则无法使用对应功能。
- 如果用户未显式授权（插件首次安装），所有声明的 capability 默认授权。

### 安全边界

- Capability 检查在主 webview 的 IPC 代理层执行。
- 插件无法绕过 capability 检查直接调用后端命令。
- 高危 capability（`ssh.exec`、`fs.write`、`net.request`）需要用户显式授权。

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
      "id": "server-monitor.dashboard",
      "mount": "sidebar",
      "title": "监控面板",
      "icon": { "kind": "svg", "src": "icon.svg" },
      "navGroup": "top",
      "order": 100,
      "entry": "webview/index.html",
      "exclusive": false
    },
    {
      "id": "server-monitor.bottom",
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
