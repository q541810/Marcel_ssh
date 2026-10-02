# Marcel SSH MCP Server

把 Marcel SSH 的 SSH / SFTP 能力通过 [MCP](https://modelcontextprotocol.io) 暴露给外部
AI agent（Claude Code、zcode、DeepSeek Harness 等）。外部 agent 调用这些工具，就像调用
它自己的工具一样。

---

## 快速开始

### 方式一（推荐）：用设置页

**设置 → 工具能力 → 让外部 Agent 接入 Marcel SSH**

界面上直接给出**可以原样粘贴的客户端配置**（已填好本机可执行文件的绝对路径），
点一下复制就行。不需要敲命令行，也不需要知道这个功能在后端怎么工作。

两种接入方式在这里都能配：

- **stdio**（默认，绝大多数场景）：配置粘过去即可。不需要保持任何东西在运行——
  客户端会自己启动 Marcel SSH。
- **HTTP**：在这里打开开关，服务就跑起来了；端口、令牌、连接地址都在界面上，
  令牌可以直接复制，不用去翻日志。

> 你保存的连接会自动对外可用，无需重复配置。

### 方式二：命令行

适合脚本化、CI、或你本来就在终端里干活的场景。

```bash
marcel-ssh --mcp-server
```

进程进入无头模式：**不启动 GUI**，从 stdin 读 JSON-RPC、往 stdout 写结果，
日志走 stderr。

可选参数：

| 参数 | 说明 |
|------|------|
| `--config-dir <path>` | 指定配置目录（默认与 GUI 同一个目录） |
| `MARCEL_CONFIG_DIR` | 同上，环境变量形式 |

> **配置目录**：无头模式默认读**与 GUI 完全相同的目录**
> （Windows `%APPDATA%\com.marcel.ssh`、macOS `~/Library/Application Support/com.marcel.ssh`、
> Linux `$XDG_CONFIG_HOME/com.marcel.ssh` 或 `~/.config/com.marcel.ssh`）。
> 所以你在 UI 里存好的连接，外部 agent 直接就能用，无需重复配置。

客户端配置：

```json
{
  "mcpServers": {
    "marcel-ssh": {
      "command": "C:\\Program Files\\Marcel SSH\\marcel-ssh.exe",
      "args": ["--mcp-server"]
    }
  }
}
```

macOS / Linux 把 `command` 换成对应的可执行文件路径即可。

**zcode** 等其它客户端：形状相同（`mcpServers` → 名字 → `command` + `args`），
按各自文档放到对应配置文件。

### 验证

让 agent 调用一次 `list_connections`。能列出你在 Marcel SSH 里保存的连接就通了。

---

## HTTP 模式（可选）

> **在设置页也能开**（设置 → 工具能力 → 让外部 Agent 接入 Marcel SSH）：开关一开服务
> 就跑起来，端口/令牌/地址都在界面上，直接复制。下面讲的是命令行等价操作，
> 以及两种方式共同的边界。

stdio 适用于**绝大多数场景**——Claude Code、zcode、DSH 都是「启动子进程、走管道」
的模型，用上面的配置就够了。

HTTP 模式用于：需要**常驻服务**、**多个客户端同时接入**、或客户端只支持 HTTP/SSE 时。

```bash
marcel-ssh --mcp-server --mcp-http
```

启动时会把一个自动生成的访问令牌打印到 **stderr**：

```
[Marcel SSH] 已自动生成访问令牌（客户端需在 Authorization 头里带它）：

    a1b2c3d4....（64 位 hex）

[Marcel SSH] 本次启动有效，重启会换新令牌。要固定下来请用 --mcp-token。
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `--mcp-http` | 关 | 启用 HTTP 传输 |
| `--mcp-port` | `8765` | 监听端口 |
| `--mcp-bind` | `127.0.0.1` | 绑定地址。**默认仅本机** |
| `--mcp-token` | 自动生成 | 访问令牌 |

客户端配置（示例）：

```json
{
  "mcpServers": {
    "marcel-ssh": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <上面那个令牌>" }
    }
  }
}
```

### ⚠️ HTTP 模式的安全边界

**stdio 可以不审批，HTTP 不行**——这是两者最本质的差别，请务必理解：

stdio 的安全前提是「客户端必须能启动这个进程」，而那已经意味着它拿到了本机执行
权限，且通道是父子进程间的私有管道。**HTTP 把这条前提整个拆掉**：任何能访问该端口
的进程都能调用这些工具，而这些工具是在你所有服务器上执行**无审批**的任意命令。

所以 HTTP 模式默认就是收紧的：

- **默认只绑 `127.0.0.1`**。要局域网访问必须显式改 `--mcp-bind`，此时启动日志会打
  风险警告。
- **强制令牌**，没有令牌直接拒绝启动（不是「可选认证」）。
- **限流** 60 次/秒，防止本机进程把它当高频执行通道刷。

**不要把 `--mcp-bind` 改成 `0.0.0.0` 然后暴露到公网。** 那等于把你所有服务器的
无审批 root shell 挂在网上。真要远程用，走 SSH 隧道或 Tailscale 之类的私有网络。

---

## 工具清单

共 9 个基础工具，外加 1 个**可选**的 `agent_task`（需要 Marcel SSH 里配好 LLM 模型
才会出现在清单里）。

### `list_connections`

列出所有已保存的连接（**不含**密码、私钥等敏感字段；临时连接会带 `temporary: true`）。

```jsonc
// 参数：无
// 返回：
[
  { "id": "conn-1", "name": "生产服务器", "host": "prod.example.com",
    "port": 22, "user": "deploy", "temporary": false }
]
```

拿到 `id` 后用它作为其它工具的 `connection_id`。

### `ssh_execute`

在远程服务器上执行一条命令。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `connection_id` | string | ✅ | 连接 ID |
| `command` | string | ✅ | shell 命令 |
| `timeout_ms` | integer | | 超时毫秒，默认 30000，范围 1000–300000 |

```jsonc
// 返回
{ "stdout": "...", "stderr": "", "exit_code": 0 }
```

> `exit_code` 非 0 是**命令的结果**，不是工具调用失败。`grep -q`、`test -f`
> 这类命令成功时也没有任何输出，别靠输出判断成败。
>
> exec 通道上 stdout 与 stderr 合流，统一从 `stdout` 返回；`stderr` 恒为空串
> （保留字段以稳定结构）。

### `get_working_directory`

取远程当前工作目录。用于把相对路径解析成绝对路径。

```jsonc
// 参数：connection_id
// 返回：{ "connection_id": "conn-1", "working_directory": "/home/deploy" }
```

### `create_connection`

**动态创建临时连接**，不写入配置文件。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 连接名（仅用于识别） |
| `host` | string | ✅ | 主机地址 |
| `port` | integer | | 默认 22 |
| `username` | string | ✅ | 用户名 |
| `auth_method` | string | ✅ | `"password"` 或 `"private_key"` |
| `password` | string | | `auth_method=password` 时必填 |
| `private_key_path` | string | | `auth_method=private_key` 时必填 |
| `passphrase` | string | | 私钥密码短语（如有加密） |

```jsonc
// 返回
{ "connection_id": "mcp-temp-<uuid>", "name": "...", "host": "...",
  "port": 22, "username": "...", "temporary": true }
```

**凭据只存在本进程内存里，不落盘、不进系统密钥链**，进程结束即消失。
适合「一次性连接一台机器，不想留痕」的场景。

### `test_connection`

测连通性：建会话 + 跑一条探针命令，返回诊断信息。

```jsonc
// 参数：connection_id
// 返回：
{ "status": "connected", "latency_ms": 412, "server_version": "Linux 6.8.0", "error": null }
{ "status": "failed", "latency_ms": 30017, "server_version": null,
  "error": "SSH error: 连接失败: connection timed out" }
```

### `sftp_upload`

上传本地文件到远端。

| 参数 | 说明 |
|------|------|
| `connection_id` | 连接 ID |
| `local_path` | 本地文件路径 |
| `remote_path` | 远端目标路径 |

```jsonc
// 返回
{ "success": true, "bytes_transferred": 2048576, "duration_ms": 1230 }
```

写盘是**原子的**：先写 `{remote_path}.marcel-tmp` 再 rename 提交，中途失败不会把
目标文件留成半截。

### `sftp_download`

下载远端文件到本地。本地父目录不存在会自动创建。

参数：`connection_id`、`remote_path`、`local_path`。返回同上。

### `sftp_list`

列出远端目录。返回按名字排序（同一目录两次调用结果稳定）。

```jsonc
// 参数：connection_id, remote_path（可选，默认 "."）
// 返回：**裸数组**（不是 { "files": [...] }）
[
  { "name": "app.log", "path": "/var/log/app.log", "size": 1024000,
    "is_dir": false, "modified": null, "permissions": "644" }
]
```

> `remote_path` 默认 `"."`：SFTP 会话的起始目录就是登录用户的家目录，所以 `"."`
> 等价于家目录。**不要传 `"~"`**——SFTP 协议不做波浪号展开，那会被当成一个字面
> 目录名而报 ENOENT。路径请用绝对路径或 `.`。
>
> `modified` 恒为 `null`：底层 SFTP 元数据不保证提供 mtime，给不出就如实报 null，
> 不编造一个 `0`。

### `sftp_delete`

删除远端文件或目录。

| 参数 | 说明 |
|------|------|
| `connection_id` | 连接 ID |
| `remote_path` | 目标路径 |
| `recursive` | 是否递归删目录，默认 `false`（此时目录必须为空） |

⚠️ 不可恢复。

### `agent_task`（可选）

把一个**自然语言的复杂任务**交给 Marcel SSH 的无头 agent 去跑：它会自己规划步骤、
调用上面那些工具、根据中间结果决定下一步，最后交回结论。

**注意**：只要以 `--mcp-server` 启动，这个工具就会出现在 `tools/list` 里，不会因为
「没配模型」而隐藏。没配模型时调用它，会返回一个 `status: "failed"` 且 `error` 说明
「尚未配置模型渠道与 API Key」的结果——按提示配好即可。

之所以不做「没配就不列出」的门控：API Key 存在系统密钥链里，启动时无法廉价地
判断某个渠道是否真的可用；与其给一个可能误判的清单，不如让它在真正用不了时
给出**说清楚原因**的失败。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `connection_id` | string | ✅ | 连接 ID |
| `task` | string | ✅ | 任务描述（自然语言） |
| `timeout_seconds` | integer | | 总超时，默认 300 |
| `max_steps` | integer | | 工具调用步数上限，默认 25 |

```jsonc
// 返回
{
  "status": "completed",
  "result": "……结论与说明……",
  "steps": [
    { "tool": "ssh_execute", "arguments": { "command": "df -h" }, "ok": true,
      "output_summary": "……" }
  ],
  "tool_calls": 3
}
```

**什么时候用 `agent_task` 而不是 `ssh_execute`**：

- 任务要多步、且**下一步取决于上一步的输出**（「先看磁盘，满了再找大文件」）
- 需要边查边改（部署、迁移、排查）
- 你自己编排要来回好几轮，而一句话就能说清

**什么时候别用**：单条命令、明确的文件传输——那些直接用基础工具，省时省 LLM 开销。

**它不会替你越权**：连接不存在、命令失败，它会如实报告并停下来，不会自作主张换一台
机器执行。

> 这个工具会调用 LLM，**消耗你自己的 API 额度**，且每次调用都是完整的一轮
> agent 循环。别拿它做基础工具能做的事。

---

## 安全模型

理解这一节很重要，因为它决定了你该在什么场合接哪些 agent。

### 命令不经过风险评估

外部调用的命令**不经过** Marcel SSH 内置的命令风险评估（`RiskAssessor`），
也**不弹审批**。这是刻意的产品决策：

> 是你把这个 agent 接进来的。外部 agent 自负其责，Marcel SSH 不做中间人。

对比：Marcel SSH **内置** agent 执行命令时，每一条都会过风险评估，命中高危档会
被拦下或要求人工审批。内置 agent 的模型可能被远端内容诱导，所以那里必须设闸门。

**因此**：只把 MCP server 接到你信任的 agent 上。不要把 stdio 端口转给不可信来源。

`agent_task` 继承同一条信任模型：它内部跑的每一步 SSH 操作**同样不审批**。区别只是
规划由 Marcel SSH 的模型完成而不是外部 agent——闸门状态完全一样。

### 凭据边界

- 已保存连接的密码 / 私钥密码短语在**系统密钥链**里，运行时由 Rust 侧读取，
  永不经过前端，也永不进入工具返回值。
- 临时连接（`create_connection`）的凭据只在**进程内存**，不落盘。
- `list_connections` 的返回里不含任何凭据字段。

### 主机密钥

无头模式**读的是与 GUI 同一个 `known_hosts.json`**（`<配置目录>/known_hosts.json`），
所以校验语义完全一致：未知主机按 TOFU 记录，**指纹与已记录的不符一律拒绝**。
跳过 PTY、跳过 UI 事件都不影响这条——区别只在「提醒谁」，不在「放不放行」。

> 只有该文件读不出来时才会退到 `%TEMP%` 下的 fallback 记录，此时启动日志会打警告。
> 退到 fallback 仍然校验，只是那份记录与 GUI 不共享。

### 工具能碰到的本地资源

外部调用被视为可信，所以工具对本机的权限**跟着 Marcel SSH 进程走**，没有额外的路径
沙箱：

- `sftp_upload` 的 `local_path` 可以是本进程权限内的任意可读文件
- `sftp_download` 的 `local_path` 可以是本进程权限内的任意可写路径（父目录会被创建）

也就是说，接入的 agent 能够读走本机上 Marcel SSH 能读的东西、往本机写它想写的文件。
这是「外部 agent 自负其责」这条决策的直接推论，不是遗漏。如果你不能接受，
就不要把不可信的 agent 接进来。

（返回值里不含凭据是一回事，工具本身能读写本地路径是另一回事——这里说的是后者。）

### 审计

所有外部调用都走统一的 `command_exec` 管理器，命令来源标记为 `ExternalMcp`
（区别于 `User` / `Agent` / `Plugin` / `SystemTask`）。

无头模式**没有进程面板**（那是 GUI 的东西），所以这条标记的下游是日志与执行记录：
后台作业台账落在 `%TEMP%/marcel-ssh-mcp/ledger.jsonl`。

---

## 故障排查

| 现象 | 原因 / 处理 |
|------|------------|
| `list_connections` 返回空数组 | 配置目录不对。GUI 与无头模式必须指向同一目录；用 `--config-dir` 显式指定，或检查 `MARCEL_CONFIG_DIR` |
| `Connection not found` | `connection_id` 写错，或该连接已被删除。先调 `list_connections` |
| 连不上 / 认证失败 | 用 `test_connection` 看具体原因（网络、认证、主机密钥） |
| 命令超时 | 加 `timeout_ms`；注意超时返回的是**已收到的部分输出**，不是空 |
| 客户端连不上 server | 确认 `command` 路径正确、`--mcp-server` 拼写正确。日志在 stderr，用 `RUST_LOG=debug` 提高详细度 |
| Windows 下没有任何输出 | 客户端必须用**管道**接 stdin/stdout（正常 MCP 客户端都这么做）。若你在终端里手敲 `marcel-ssh --mcp-server`，它会在读 stdin 时阻塞等待——这是正常的 |

---

## 平台支持

| 平台 | MCP Server |
|------|-----------|
| Windows / macOS / Linux | ✅ |
| Android | ❌ 暂不支持 |

Android 上的限制来自进程模型：系统随时可能回收后台进程，无法保证服务稳定。
移动端仍可作为 MCP **client**（那是另一个方向，见设置页的 MCP 服务配置）。

---

## 实现位置

| 关注点 | 文件 |
|--------|------|
| 入口 / 参数 / 配置目录 | `src-tauri/src/mcp_server/cli.rs` |
| JSON-RPC 协议类型 | `src-tauri/src/mcp_server/protocol.rs` |
| stdio 传输 | `src-tauri/src/mcp_server/stdio_transport.rs` |
| HTTP 传输（认证 / 限流） | `src-tauri/src/mcp_server/http_transport.rs` |
| 工具 schema 与分发 | `src-tauri/src/mcp_server/tools.rs` |
| 会话解析 / 命令执行 | `src-tauri/src/mcp_server/external_executor.rs` |
| SFTP 动作 | `src-tauri/src/mcp_server/sftp_ops.rs` |
| 无头 agent 任务 | `src-tauri/src/mcp_server/agent_task.rs` |
| GUI 托管的服务实例 | `src-tauri/src/mcp_server/runtime.rs` |
| GUI 命令层 | `src-tauri/src/commands/mcp_server.rs` |
| 设置页 | `src/components/settings/McpServerSection.tsx` |

请求分发（方法路由、参数校验、错误码）只有一份实现，挂在
`McpServer::handle_request` 上，stdio 与 HTTP 共用——两条接入路径的工具语义与
错误码因此逐字一致。

无头连接能力在 `src-tauri/src/ssh/manager.rs` 的 `connect_headless` /
`disconnect_headless`。
