/**
 * jumpResolve.ts —— 把一条跳转请求（`messageJumpStore`）解析成「要对准的消息 id（+ 小标题）」。
 *
 * 三种目标共用同一个入口，执行器（`AgentTranscript` → 列表句柄 → `useMessageJump`）只认 id：
 * - text：提问前那段正文（`questionJump`）；
 * - tool：某次工具调用那一行（`subagentThread.resolveToolCallMessageId`）；
 * - thread：某个子对话的时间线卡（`subagentThread.resolveSubagentThreadMessageId`）。
 * 解析不到返回 null（消息可能还在载入；调用方会等到请求过期）。
 */
import type { AgentMessage } from './types';
import type { MessageJumpRequest } from '@/stores/messageJumpStore';
import { resolveQuestionJump } from './questionJump';
import { resolveSubagentThreadMessageId, resolveToolCallMessageId } from './subagentThread';

export interface JumpTarget {
  readonly id: string;
  readonly anchor?: string;
}

export function resolveJumpRequest(
  messages: readonly AgentMessage[],
  request: Pick<MessageJumpRequest, 'kind' | 'toolCallId' | 'anchor'>,
): JumpTarget | null {
  switch (request.kind ?? 'text') {
    case 'tool': {
      const id = resolveToolCallMessageId(messages, request.toolCallId);
      return id ? { id } : null;
    }
    case 'thread': {
      const id = resolveSubagentThreadMessageId(messages, request.toolCallId);
      return id ? { id } : null;
    }
    case 'text': {
      const hit = resolveQuestionJump(messages, request.toolCallId, request.anchor);
      return hit ? { id: hit.message.id, anchor: hit.anchor } : null;
    }
  }
}
