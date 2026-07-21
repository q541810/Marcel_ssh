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
  isRunning: boolean,
  draft: string,
): boolean {
  if (isRunning) return false;
  if (!session || session.status !== 'connected') return false;
  if (!session.configId) return false;
  return draft.trim().length > 0;
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
