import type { Session } from '@/lib/types';

export type AgentEmptyStateReason =
  | 'no-session'
  | 'connecting'
  | 'disconnected'
  | 'error'
  | 'no-config'
  | 'ready';

export function canSendAgentPrompt(
  session: Session | null | undefined,
  /**
   * 会话忙不忙 —— 有任务在跑、**或正在压缩上下文**都算。
   *
   * 由调用方算好（`isRunning || isCompacting`，或 `conversationIsBusy`），别只传
   * 其中之一：压缩不是任务，只看 `isRunning` 时它完全隐形，而这期间发出去的消息
   * 会被随后落下的压缩卡盖到后面、被归档边界从后续请求里抹掉。
   */
  busy: boolean,
  draft: string,
  hasAttachments = false,
): boolean {
  if (busy) return false;
  if (!session || session.status !== 'connected') return false;
  if (!session.configId) return false;
  return draft.trim().length > 0 || hasAttachments;
}

export function agentEmptyStateReason(
  session: Session | null | undefined,
): AgentEmptyStateReason {
  if (!session) return 'no-session';
  switch (session.status) {
    case 'connecting':
      return 'connecting';
    case 'disconnected':
      return 'disconnected';
    case 'error':
      return 'error';
    case 'connected':
      return session.configId ? 'ready' : 'no-config';
    default:
      return 'no-session';
  }
}

export function resolveAgentIds(
  session: Session | null | undefined,
): { sessionId: string; configId: string } | null {
  if (!session?.id || !session.configId) return null;
  return { sessionId: session.id, configId: session.configId };
}
