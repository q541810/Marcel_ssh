# Tasks

- [x] Task 1: 后端 - 创建 SQLite 会话管理模块
  - [x] 创建 `src-tauri/src/agent/conversation.rs`，定义 `AgentConversation` 结构体
  - [x] 实现 SQLite 数据库初始化（使用 rusqlite），创建 `conversations` 和 `messages` 表
  - [x] 实现 CRUD 函数：创建会话、列出会话、加载消息、保存消息、删除会话
  - [x] 在 `AppState` 中新增 `conversation_db` 字段

- [x] Task 2: 后端 - 新增 Tauri Commands
  - [x] 在 `src/commands/agent.rs` 中新增以下 commands：
    - `agent_create_conversation`
    - `agent_list_conversations`
    - `agent_load_conversation`
    - `agent_delete_conversation`
    - `agent_delete_conversations_by_session`
  - [x] 在 `src/lib.rs` 中注册新 commands

- [x] Task 3: 后端 - Cargo.toml 依赖更新
  - [x] 在 `src-tauri/Cargo.toml` 中添加 `rusqlite` 依赖（with: "bundled"）

- [x] Task 4: 前端 - 类型定义和 IPC 封装
  - [x] 在 `src/lib/types.ts` 中新增 `AgentConversation` 类型
  - [x] 在 `src/lib/tauri.ts` 中新增对应的 IPC 调用函数

- [x] Task 5: 前端 - agentStore 重构为会话管理
  - [x] 重构 `agentStore.ts`：将全局 `messages` 替换为 `conversations: Record<convId, AgentMessage[]>`
  - [x] 新增 `activeConversationId` 状态
  - [x] 新增 `switchConversation`、`newConversation`、`loadConversation` 操作
  - [x] 修改 `startTask` 以传入当前 `conversationId` 作为 history 来源

- [x] Task 6: 前端 - AgentPanel UI 改造
  - [x] 在 AgentPanel 头部右侧新增"新建会话"和"历史会话"按钮
  - [x] 实现历史会话抽屉/侧边面板
  - [x] 按钮样式与"智能助手"标题保持同高度
  - [x] 更新消息显示逻辑以使用当前活跃会话的消息

- [x] Task 7: 前端 - sessionStore 断开连接清理
  - [x] 在 `sessionStore.ts` 的 `disconnect` 操作中调用 agentStore 清理对应 SSH session 的会话数据

- [x] Task 8: 验证与测试
  - [x] 验证：新建会话功能正常
  - [x] 验证：历史会话列表和切换正常
  - [x] 验证：断开 SSH 连接后前端清理，重新连接后可查看历史
  - [x] 验证：运行 `cargo check` 编译通过
  - [x] 验证：运行 `pnpm tsc --noEmit` 编译通过

# Task Dependencies

- Task 2 depends on Task 1, Task 3
- Task 4 depends on Task 2
- Task 5 depends on Task 4
- Task 6 depends on Task 5
- Task 7 depends on Task 5
- Task 8 depends on Task 6, Task 7
