import type { AgentMessage } from '@/lib/types';
import type { StreamHandler } from '@/stores/agentStreamHandlers';

/**
 * 流处理器测试用的假 handler：把状态记在自己内部，不碰真实 store。
 *
 * 放在非 `.test.` 文件里是必须的：vitest 会把被 import 的 `.test.ts` 整个文件
 * 再跑一遍，跨文件复用测试桩会让那些用例重复执行（本仓库踩过一次，用例数翻倍）。
 *
 * 它只服务 `agentStreamHandlers.test.ts`（纯函数式的事件处理测试）。
 * `agentStreamManager.test.ts` 刻意不用它 —— 那边断言的是真实 store 状态，
 * 所以直接用生产 adapter（`createDefaultStreamHandler`）。
 */
export type MockStreamHandler = StreamHandler & {
  _messages: Record<string, AgentMessage[]>;
  _taskStatuses: Record<string, string>;
};

export function mockHandler(messages: Record<string, AgentMessage[]> = {}): MockStreamHandler {
  const msgs = { ...messages };
  const taskStatuses: Record<string, string> = {};
  const tasks: Record<string, { conversationId: string; sessionId: string; status: string }> = {};
  const conversations: Record<string, { id: string; connectionId?: string }> = {};
  let subConvCount = 0;

  return {
    _messages: msgs,
    _taskStatuses: taskStatuses,
    updateMessages(convId, updater) {
      msgs[convId] = updater(msgs[convId] || []);
    },
    updateTaskStatus(taskId, status) {
      taskStatuses[taskId] = status;
    },
    getTaskStatus(taskId) {
      return taskStatuses[taskId];
    },
    getMessages(convId) {
      return msgs[convId] || [];
    },
    clearActiveTaskIf(_taskId) {},
    setPlan() {},
    getTask(taskId) {
      return tasks[taskId];
    },
    getConversation(conversationId) {
      return conversations[conversationId];
    },
    registerSubTask(task) {
      tasks[task.id] = {
        conversationId: task.conversationId,
        sessionId: task.sessionId,
        status: task.status,
      };
    },
    registerSubConversation(args) {
      conversations[args.conversationId] = {
        id: args.conversationId,
        connectionId: args.connectionId,
      };
      const loadingId = `loading-${++subConvCount}`;
      msgs[args.conversationId] = [
        ...(msgs[args.conversationId] ?? []),
        { id: loadingId, role: 'assistant', content: '', isLoading: true } as AgentMessage,
      ];
      return loadingId;
    },
    recordContextUsage() {},
  };
}
