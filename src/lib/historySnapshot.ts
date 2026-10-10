import type { AgentMessage, ToolCallInfo } from './types';

/** 会话原始事实的 IPC 形状；请求角色、压缩边界和工具协议由 Rust 投影。 */
export interface HistoryMessage {
  role: AgentMessage['role'];
  content: string;
  reasoningContent?: string;
  imagePaths?: string[];
  toolCalls?: HistoryToolCall[];
  toolCall?: HistoryToolCall;
  toolResult?: {
    toolName: string;
    result?: string;
    arguments?: Record<string, unknown>;
    toolCallId?: string;
  };
  compaction?: {
    status: 'running' | 'done';
    summary?: string;
  };
  isLoading?: boolean;
  dbId?: string;
}

interface HistoryToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export type HistorySnapshotEntry =
  | {
      kind: 'stored';
      id: string;
      /** null 是显式清除：live 可能已经隐藏了落库时仍保留的中间思考。 */
      reasoningContent: string | null;
      /** 行已不存在时保留本次看见的事实，不把缺行误解成清空历史。 */
      fallback: HistoryMessage;
    }
  | { kind: 'transient'; message: HistoryMessage };

export interface HistorySnapshot {
  entries: HistorySnapshotEntry[];
}

function snapshotToolCall(call: ToolCallInfo): HistoryToolCall {
  return {
    id: call.id,
    name: call.name,
    ...(call.arguments !== undefined ? { arguments: call.arguments } : {}),
  };
}

function snapshotMessage(message: AgentMessage): HistoryMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.reasoningContent !== undefined ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.imagePaths !== undefined ? { imagePaths: message.imagePaths } : {}),
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls.map(snapshotToolCall) } : {}),
    ...(message.toolCall !== undefined ? { toolCall: snapshotToolCall(message.toolCall) } : {}),
    ...(message.toolResult !== undefined ? {
      toolResult: {
        toolName: message.toolResult.toolName,
        ...(message.toolResult.result !== undefined ? { result: message.toolResult.result } : {}),
        ...(message.toolResult.arguments !== undefined ? { arguments: message.toolResult.arguments } : {}),
        ...(message.toolResult.toolCallId !== undefined ? { toolCallId: message.toolResult.toolCallId } : {}),
      },
    } : {}),
    ...(message.compaction !== undefined ? {
      compaction: {
        status: message.compaction.status,
        ...(message.compaction.summary !== undefined ? { summary: message.compaction.summary } : {}),
      },
    } : {}),
    ...(message.isLoading !== undefined ? { isLoading: message.isLoading } : {}),
    ...(message.dbId !== undefined ? { dbId: message.dbId } : {}),
  };
}

/**
 * 按当前顺序冻结消息事实，不过滤通知/骨架、不合成 tool_calls、不生成 checkpoint。
 *
 * 已加载行通过 dbId 引用，缺少 DB 身份的 live 消息保留原始必要字段。
 * 两种来源都保留必要原始字段，避免缺行时丢掉此前可见内容；这一步迁移的是
 * 上下文构建语义，不借迁移改变 live 与重载原本不同的历史形状。
 */
export function createHistorySnapshot(messages: readonly AgentMessage[]): HistorySnapshot {
  return {
    entries: messages.map((message) => {
      // 按实际 IPC 的 JSON 形状冻结嵌套参数，也兼容较旧的移动 WebView。
      const raw: HistoryMessage = JSON.parse(JSON.stringify(snapshotMessage(message)));
      return message.dbId
        ? { kind: 'stored', id: message.dbId, reasoningContent: message.reasoningContent ?? null, fallback: raw }
        : { kind: 'transient', message: raw };
    }),
  };
}
