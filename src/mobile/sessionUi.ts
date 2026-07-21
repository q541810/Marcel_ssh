import type { Session, SessionStatus } from '@/lib/types';

export type TerminalPanelMode =
  | 'list'
  | 'terminal'
  | 'connecting'
  | 'error'
  | 'disconnected';

export function shouldShowConnectionList(
  sessions: Record<string, Session>,
  activeSessionId: string | null,
): boolean {
  if (!activeSessionId) return true;
  return sessions[activeSessionId] == null;
}

export function resolveTerminalPanelMode(
  sessions: Record<string, Session>,
  activeSessionId: string | null,
): TerminalPanelMode {
  if (!activeSessionId) return 'list';
  const session = sessions[activeSessionId];
  if (!session) return 'list';
  switch (session.status) {
    case 'connected':
      return 'terminal';
    case 'connecting':
      return 'connecting';
    case 'error':
      return 'error';
    case 'disconnected':
      return 'disconnected';
    default:
      return 'list';
  }
}

/**
 * Keep inactive tab panels mounted for terminal buffer keep-alive.
 * Re-adding the animation class on activation replays the enter animation.
 */
export function panelVisibilityClass(active: boolean): string {
  return active ? 'mobile-panel-enter flex h-full min-h-0 flex-col' : 'hidden';
}

export function canReconnectSession(
  session: Session | null | undefined,
): boolean {
  if (!session?.configId) return false;
  return session.status === 'disconnected' || session.status === 'error';
}

export function sessionStatusLabel(status: SessionStatus): string {
  switch (status) {
    case 'connecting':
      return '连接中…';
    case 'connected':
      return '已连接';
    case 'disconnected':
      return '已断开';
    case 'error':
      return '连接失败';
    default:
      return status;
  }
}

/** Prefer the saved connection's friendly name; fall back to the user@host label. */
export function resolveSessionDisplayName(
  session: Session | null | undefined,
  connections: ReadonlyArray<{ id: string; name: string }>,
): string {
  if (!session) return '';
  if (session.configId) {
    const conn = connections.find((c) => c.id === session.configId);
    const name = conn?.name.trim();
    if (name) return name;
  }
  return session.connectionId;
}

export function listSessionsToDisconnectBeforeNewConnect(
  sessions: Record<string, Session>,
  excludeId?: string,
): string[] {
  return Object.keys(sessions).filter((id) => id !== excludeId);
}
