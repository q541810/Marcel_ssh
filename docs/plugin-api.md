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
  "agentTools": [                 // 可选。Agent 工具定义。
    {
      "name": "read_data",
      "description": "读取插件目录下的 data.json",
      "kind": "local",           // 可选，默认 "ssh"。本地执行类型
      "handler": "fs.read",      // kind=local 时必填，内核注册的 handler 名
      "command": "{\"path\":\"data.json\"}", // kind=local 时为 JSON 固定参数
      "parameters": {},
      "riskLevel": "ReadOnly"
    }
  ],
  "injections": [...],            // 可选。内容脚本注入（需 ui.inject 权限）。
  "configView": "config.html",    // 可选。配置视图入口文件。
  "systemPromptSection": "system-prompt.md" // 可选。Agent system prompt 静态段文件路径。
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
| `systemPromptSection` | string | 否 | Agent system prompt 静态段文件路径（相对插件根目录），详见 [systemPromptSection 章节](#systempromptsection) |

---

## 视图定义

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 视图唯一标识（在插件内简短即可，如 `main`。最终 ID 自动拼接为 `<plugin-id>.<view-id>`） |
| `mount` | string | 是 | 挂载点：`sidebar`（左侧面板）/ `settings`（设置页）。未知值在加载时拒绝 |
| `title` | string | 是 | 显示标题 |
| `icon` | IconDef | 否 | 图标定义 |
| `navGroup` | string | 否 | 导航分组：`top` / `bottom`。sidebar 视图需设置此项才会出现在 NavRail 上；不设置则视图仍注册但不显示在导航栏 |
| `order` | number | 否 | 排序权重（越小越靠前，默认 100） |
| `entry` | string | 是 | WebView 入口文件路径（相对于插件根目录） |
| `exclusive` | boolean | 否 | 是否独占模式（默认 false）。设为 `true` 时该视图通过 NavRail 切换激活后会**独占中央面板**，同时隐藏 sidebar 和 agent 面板（如设置页） |

### 挂载点

| 挂载点 | 说明 |
|--------|------|
| `sidebar` | 左侧面板。需要设置 `navGroup`。 |
| `settings` | 设置页面。视图注册为设置页的子页。 |

> `agent` 和 `center` 挂载点已被内置面板占用，**插件 manifest 中声明将被拒绝加载**。`bottom` 挂载点已移除（原为终端底部 tab）。

### 图标定义

```jsonc
{ "kind": "svg", "src": "icon.svg" }   // SVG 图标
{ "kind": "img", "src": "icon.png" }   // 图片图标
{ "kind": "emoji", "src": "🎉" }       // Emoji 图标
```

`src` 是相对于插件根目录的路径，通过 `plugin://<plugin-id>/<src>` 协议加载。`kind` 枚举已严格校验，未知值（如 `"bitmap"`）在 manifest 加载时报错。

---

## Agent 工具定义

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 工具名称（Agent 调用时使用） |
| `description` | string | 是 | 工具描述（Agent 可见） |
| `kind` | string | 否 | 执行类型：`"ssh"`（默认，在远程服务器执行命令）或 `"local"`（在用户本机调用内核注册的 handler）。未知值在 manifest 加载时报错 |
| `handler` | string | 否 | `kind=local` 时必填，指向内核注册的通用本地 handler 名称（如 `"fs.read"`）。`kind=ssh` 时忽略。详见 [通用本地 handler](#通用本地-handler) |
| `command` | string | 否 | `kind=ssh` 时为 SSH 命令模板；`kind=local` 时为 JSON 对象字符串（fixed_params）。详见下方说明 |
| `parameters` | JSON Schema | 否 | 参数 JSON Schema |
| `riskLevel` | string | 否 | 风险等级：`"ReadOnly"` / `"LowRisk"` / `"Moderate"` / `"HighRisk"` / `"Destructive"`（默认 `"Moderate"`）。**严格校验**——未知值（如 `"Medium"`、`"moderate"` 小写）在 manifest 加载时报错，不再静默降级为 `Moderate` |

> Agent 工具仅在 Agent 模式和 Auto 模式下可用，Plan 模式下不注册。

### `kind=ssh` 示例（默认，远程执行）

```json
{
  "name": "server_status",
  "description": "获取服务器运行状态",
  "command": "top -bn1 | head -20",
  "parameters": {},
  "riskLevel": "ReadOnly"
}
```

### `kind=local` 示例（本地执行）

```json
{
  "name": "read_data",
  "description": "读取插件目录下的 data.json",
  "kind": "local",
  "handler": "fs.read",
  "command": "{\"path\":\"data.json\"}",
  "parameters": {},
  "riskLevel": "ReadOnly"
}
```

`kind=local` 工具的 `command` 字段被解析为 JSON 对象作为 fixed_params，与模型传入的 params 合并后传给 handler。fixed_params 优先级高，可防止模型覆盖 `path` 等敏感字段。`command` 字段中的字符串值支持 [模板上下文变量](#模板上下文变量) 替换（如 `{"path":"memories/{{__host_port__}}.jsonl"}`）。

> `kind=local` 时，handler 调用前会做 capability 检查（插件必须声明对应 handler 要求的 capability）；handler 未注册时该工具被跳过并写 warn 日志，不影响其他工具加载。

---

## 通用本地 handler

内核启动时注册了一组通用本地 handler，任何插件都可以通过 `kind=local` + `handler=<name>` 调用，无需自己实现执行逻辑。当前注册的 handler 列表：

| handler 名 | kind | capability | 参数 | 返回值 | 说明 |
|---|---|---|---|---|---|
| `fs.read` | local | `fs.read` | `{path}` | `{content: string}` | 读取插件目录下指定路径文件（路径穿越拒绝），返回文件全文 |
| `fs.write` | local | `fs.write` | `{path, content}` | `{bytes_written: number}` | 覆盖写插件目录下文件（自动建中间目录，路径穿越拒绝） |
| `fs.append` | local | `fs.write` | `{path, content}` | `{bytes_written: number}` | 追加写插件目录下文件（自动建父目录，路径穿越拒绝），返回本次追加的字节数 |
| `session.info` | local | `ssh.list` | 无 | `{session_id, host, port, username, connection_id}` | 当前活跃会话详情。无活跃会话时返回错误 |
| `connection.info` | local | `ssh.list` | 无 | `{host, port, username, connection_id}` | 当前会话对应的连接详情。无活跃会话时返回错误 |
| `host_port` | local | `ssh.list` | 无 | `{host_port: string}` | 当前会话的 `host:port` 字符串（如 `"1.2.3.4:22"`），无活跃会话时返回错误 |

> 说明：
> - `fs.append` 复用 `fs.write` 的 capability（写操作），不新增 capability 类型。它是 `fs.write` 的"追加模式"变体。
> - `path` 参数相对于插件根目录，由内核拼接 `<app-config-dir>/plugins/<plugin-id>/<path>` 后解析，含 `../` 的路径被拒绝。
> - handler 内部不感知调用它的插件，`__plugin_id` 由 `PluginAgentTool` 在调用前自动注入到 params，插件 manifest 不需要也无法手动传该字段。
> - 内核不暴露动态注册接口，handler 列表硬编码在启动时注册（避免安全风险）。如果未来有插件需要新的本地能力，需在内核侧新增 handler。

### `kind=local` 工具的 `command` 字段（fixed_params 机制）

`kind=local` 时，`command` 字段不再被当作 SSH 命令模板，而是被解析为 **JSON 对象字符串**，作为固定参数（fixed_params）：

```json
{
  "name": "memory_save",
  "kind": "local",
  "handler": "fs.append",
  "command": "{\"path\":\"memories/{{__host_port__}}.jsonl\"}",
  "parameters": {
    "type": "object",
    "properties": {
      "entry": { "type": "string" }
    },
    "required": ["entry"]
  }
}
```

调用时参数合并顺序：

1. 模型按 `parameters` schema 传入 params（如 `{entry: "..."}`）
2. 内核将 `command` 解析为 JSON 对象（如 `{path: "memories/...jsonl"}`）
3. **fixed_params 覆盖模型同名参数**（`model_obj.insert(k, v)`），模型无法覆盖 `path` 等敏感字段
4. 内核注入 `__plugin_id`（fs handler 用于路径解析）
5. 对所有顶层字符串值做 [模板上下文变量](#模板上下文变量) 替换
6. 把合并后的 params 传给 handler

设计意图：插件作者把 `path` 写死在 `command` 字段里（可含上下文变量模板），不暴露给模型的 `parameters` schema，从根本上防止模型写到任意路径。模型只能控制 `entry`/`content` 等业务字段。

> `command` 不是合法 JSON 对象时（如 `kind=local` 但 `command` 是空字符串或非 JSON），fixed_params 退化为空对象并写 warn 日志，工具仍可调用（此时模型参数全部生效，慎用）。

---

## 模板上下文变量

工具的 `command` 字段（`kind=ssh` 的命令模板 / `kind=local` 的 fixed_params 字符串值）渲染时，自动注入当前会话的只读上下文变量，无需模型每次自己传 host/port 等值。共 7 个变量：

| 变量 | 示例值 | 说明 |
|---|---|---|
| `{{__host__}}` | `1.2.3.4` | 当前会话 SSH 主机 IP |
| `{{__port__}}` | `22` | 当前会话 SSH 端口 |
| `{{__host_port__}}` | `1.2.3.4_22` | `host` 与 `port` 用下划线 `_` 拼接的隔离 key（注意与 `host_port` handler 返回的 `host:port` 形式不同） |
| `{{__session_id__}}` | `sess_xxx` | 当前会话 ID |
| `{{__connection_id__}}` | `conn_xxx` | 当前会话对应的保存连接 ID（configId） |
| `{{__username__}}` | `root` | 登录用户名 |
| `{{__timestamp__}}` | `1720000000` | 当前 Unix 时间戳（秒），同一工具调用内多次引用返回同一值 |

### 渲染顺序

1. **先注入上下文变量**：把 `{{__host__}}` 等 7 个变量替换为当前会话的真实值
2. **再替换模型参数**：把 `{{paramName}}` 替换为模型传入的 params

> 顺序很重要：上下文变量先消费掉 `{{__host__}}` 占位符，模型即使传入 `__host: "evil.com"` 也无法覆盖（占位符已被替换，模型参数的 `__host` 找不到对应占位符匹配）。

### 无活跃会话时的行为

Agent 模式下理论上不会无会话。若会话被中途关闭等原因导致无法获取会话信息，所有上下文变量替换为**空字符串**并写一条 warn 日志，工具调用不阻塞（让模型自行判断响应）。

### 示例

```json
{
  "name": "memory_save",
  "kind": "local",
  "handler": "fs.append",
  "command": "{\"path\":\"memories/{{__host_port__}}.jsonl\"}",
  "parameters": {
    "type": "object",
    "properties": {
      "entry": { "type": "string", "description": "一行 JSON 字符串，id 用 mem_<当前时间戳>_4位随机hex" }
    }
  }
}
```

`{{__host_port__}}` 在调用时被替换为 `1.2.3.4_22`，作为 fixed_params 的 `path` 值传给 `fs.append` handler。

> 上下文变量**只**在 `command` 字段（`kind=ssh` 的命令模板 / `kind=local` 的 fixed_params 字符串值）和 [systemPromptSection](#systempromptsection) 文件内容中替换。工具的 `description`、`parameters` schema 等其他字段**不**做变量替换——请把引导文字写在 description 自然语言里（如上例"用 mem_<当前时间戳>_4位随机hex"），不要依赖占位符。

---

## systemPromptSection

插件可以在 Agent 的 system prompt 末尾追加一段**静态提示文本**，让模型每次开始对话就自动看到（如"你之前可能记过关于这台机器的事情，需要时调 memory_recall 查看"）。

| 属性 | 值 |
|------|------|
| manifest 字段 | `systemPromptSection` |
| 类型 | `string`（文件路径，相对插件根目录） |
| 必填 | 否 |
| 生效模式 | Agent 模式 / Auto 模式（Plan 模式下不拼接） |
| 长度上限 | 单段 2000 字符，超过截断并写 warn 日志 |
| 支持变量 | [模板上下文变量](#模板上下文变量)（如 `{{__host_port__}}`） |
| 不支持 | 动态占位符（如 `{{memory_index}}`、`{{user_count}}` 等业务变量），内核不做任何业务数据渲染 |

### 用法

在 manifest 中声明字段，指向插件目录下的一个静态文件（通常用 `.md` 后缀）：

```json
{
  "id": "my-plugin",
  "systemPromptSection": "system-prompt.md"
}
```

`system-prompt.md` 内容示例（纯静态文本，含上下文变量）：

```markdown
## 我的插件

当前连接为 {{__host_port__}}。你拥有以下工具：

- read_data：读取本插件数据
- write_data：写入本插件数据

会话开始时请主动调用 read_data 加载已有数据。
```

### 行为规则

- **拼接位置**：在 system prompt 末尾（user_section 之后）追加，多个插件按插件加载顺序依次拼接
- **变量替换**：读取文件原文后，对 7 个 [上下文变量](#模板上下文变量) 做替换，让段落能引用当前会话信息
- **静态文本**：内核只做上下文变量替换，**不渲染任何动态占位符**。如果插件需要动态数据（如索引、计数），由模型主动调用工具获取，内核不主动注入
- **长度截断**：单段超过 2000 字符时截断并写 warn 日志
- **文件读取失败**：跳过该插件段落，写 warn 日志，不阻塞会话启动
- **插件禁用 / 未声明该字段**：不注入，不读文件
- **缓存**：按文件 mtime 失效，避免每次构建 system prompt 都重新读盘

> 与 [agentTools](#agent-工具定义) 一致，`systemPromptSection` 仅在 Agent 模式和 Auto 模式下生效，Plan 模式下不拼接。

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
| `runAt` | string | 否 | 注入时机：`"idle"`（默认，空闲时）或 `"instant"`（立即）。**严格校验**——未知值在 manifest 加载时报错 |
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
| `skills` | Skill 列表 |
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

下列是常用事件，**任何进入插件事件扇出的事件都可订阅**（支持通配符）。来源包括后端 `emit_event`，以及前端桥接（如会话 Tab 切换）：

| 事件模式 | 说明 | Payload |
|----------|------|---------|
| `ssh://status/*` | SSH 连接状态变化 | `SshStatus`（connected/disconnected/error） |
| `ssh://session-active` | 当前激活的 SSH 会话 Tab 变化（点 Tab / 新连接激活 / 断开后自动切下一个） | `{ sessionId, connectionId, previousSessionId, previousConnectionId }`（无会话时 `sessionId`/`connectionId` 为 `null`） |
| `agent://stream/*` | Agent 任务流 | `StreamEvent`（textDelta/toolCall/done/error） |
| `agent://plan/*` | Agent 计划流 | `PlanStreamEvent` |
| `sftp-upload-progress` | SFTP 上传进度 | `{uploadId, written, total}` |
| `sftp-upload-done` | SFTP 上传完成 | `{uploadId}` |
| `sftp-download-progress` | SFTP 下载进度 | `{downloadId, written, total}` |
| `sftp-download-done` | SFTP 下载完成 | `{downloadId}` |

> 上表只列出主要事件。其他未列出的后端事件（如 `notification-sound`、approval 相关事件等）只要进入 `plugin://events`，同样可通过 `events.subscribe` 订阅。

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

HTTP API 仅支持以下命令子集（远少于后端实际命令数）：

| 命令 | 对应 capability |
|------|----------------|
| `ssh_list_sessions` / `ssh.list` | `ssh.list` |
| `session.active` / `session.info` | `ssh.list` |
| `connection.info` / `connection.list` | `ssh.list` |
| `ssh_exec` | `ssh.exec` |
| `sftp_read_file` / `sftp.read` | `sftp.read` |
| `sftp_write_file` / `sftp.write` | `sftp.write` |
| `plugin_fs_read` / `fs.read` | `fs.read` |
| `plugin_fs_write` / `fs.write` | `fs.write` |
| `plugin_http_request` / `net.request` | `net.request` |
| `plugin_send_notification` / `notification` | `notification` |
| `events.subscribe` / `events.unsubscribe` | `events` |

其他后端命令（如 `sftp_list_dir`、`sftp_upload`、`agent_start_task` 等）**不支持**通过 HTTP API 调用。

- 虚拟命令（`session.active` 等）通过后端状态实现，**不返回前端 store 派生字段**（如 `createdAt`）。如需含 `configId`/`createdAt` 的数据，请使用事件 IPC 通道
- HTTP API 的 capability 检查**与事件 IPC 一致**：同时校验 manifest 声明、插件启用状态和用户在设置页的授权状态（三层授权，via `plugins::auth` 模块）
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

- 事件 IPC 和 HTTP API **均执行相同的三层授权检查**（manifest 声明 + 用户授权 + 插件启用状态），由 `plugins::auth` 模块统一实现
- 插件无法绕过 manifest 中未声明的 capability
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
| 1.5.0 | 2026-07-03 | 新增插件本地工具类型（`kind=local` + `handler`）；新增 6 个通用本地 handler；新增 7 个模板上下文变量；新增 `systemPromptSection` 静态段拼接 |
| 1.6.0 | 2026-07-04 | **架构重构**：manifest 枚举字段严格校验（`mount`/`kind`/`riskLevel`/`runAt`/icon `kind` 未知值报错，不再静默降级）；挂载点缩减为 `sidebar` + `settings`（移除 `bottom`/`agent`/`center`）；HTTP API 授权与事件 IPC 统一为三层检查（消除用户撤销能力对 HTTP API 无效的安全漏洞）；插件注册表后端有状态化（`PluginRegistry` + mtime 缓存 + diff 刷新）；新增 `plugin_reload` command 和 `plugin-registry-changed` 事件；command→capability 映射改为 Rust 单一真源 |
