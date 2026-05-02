# 添加联网搜索 Tool 实施计划

## 概述

为 Marcel SSH Agent 添加一个联网搜索工具，使 Agent 能够通过搜索引擎获取互联网信息，辅助回答用户问题和执行任务。

## 技术方案

### 工具名称: `web_search`

**功能**: 通过搜索引擎查询互联网信息，返回搜索结果摘要。

**风险等级**: `ReadOnly`（仅读取网络信息，不修改任何数据）

**实现方式**: 使用 `reqwest` crate 发起 HTTP 请求，调用搜索引擎 API 或抓取搜索结果页面。

***

## 实施步骤

### 1. 创建工具实现文件 `src-tauri/src/agent/tools/web_search.rs`

实现 `AgentTool` trait，包含：

```rust
// 工具结构
pub struct WebSearchTool;

// AgentTool trait 实现
- name(): "web_search"
- description(): 描述工具功能
- parameters_schema(): 
  {
    "query": { "type": "string", "description": "搜索关键词" },
    "num_results": { "type": "integer", "description": "返回结果数量 (default: 5, max: 10)" }
  }
- risk_level(): RiskLevel::ReadOnly
- execute(): 执行搜索逻辑
```

**执行逻辑**:

1. 使用 `reqwest` 发起 HTTP 请求到搜索引擎
2. 解析搜索结果（HTML 或 JSON API）
3. 提取标题、摘要、链接等信息
4. 格式化为结构化的文本返回
5. 结果截断防止过长

**实现选项**:

* 使用免费的搜索 API（如 DuckDuckGo HTML 接口）

* 或抓取搜索引擎结果页面并解析

### 2. 注册工具到 `src-tauri/src/agent/tools/mod.rs`

在文件中：

1. 添加模块声明：`pub mod web_search;`
2. 在 `with_builtins()` 中注册：`r.register(Arc::new(web_search::WebSearchTool::new()));`
3. 更新内置工具数量注释（10 → 11）
4. 更新工具列表注释

### 3. 更新 `AGENTS.md` 文档

在 **4.3 Tool-Use 架构** 部分的工具表格中添加：

| Tool 名称      | 功能        | 风险等级     | 实现方式                        |
| ------------ | --------- | -------- | --------------------------- |
| `web_search` | 联网搜索互联网信息 | ReadOnly | `agent/tools/web_search.rs` |

### 4. 更新单元测试

在 `mod.rs` 的测试中：

1. 更新工具数量断言（10 → 11）
2. 在工具名称列表中添加 `"web_search"`

***

## 安全考虑

1. **只读操作**: 工具仅发起 GET 请求，不修改任何数据
2. **结果截断**: 搜索结果需要截断，防止过长内容影响 LLM 上下文
3. **超时设置**: HTTP 请求需设置合理的超时时间（建议 10 秒）
4. **错误处理**: 网络错误、超时等情况需优雅处理并返回有意义的错误信息
5. **速率限制**: 避免频繁请求，可在工具层面添加简单的冷却机制

## 依赖项

* `reqwest` 已在 `Cargo.toml` 中声明，无需新增依赖

* 可能需要 `scraper` 或 `html5ever` 等 HTML 解析库（如果需要解析搜索结果页面）

## 预期输出格式

```
搜索结果: "查询关键词"
=====================

1. [标题]
   摘要内容...
   链接: https://...

2. [标题]
   摘要内容...
   链接: https://...

(共 X 条结果)
```

***

## 文件变更清单

| 文件                                        | 操作 | 说明   |
| ----------------------------------------- | -- | ---- |
| `src-tauri/src/agent/tools/web_search.rs` | 新建 | 工具实现 |
| `src-tauri/src/agent/tools/mod.rs`        | 修改 | 注册工具 |
| `AGENTS.md`                               | 修改 | 更新文档 |

