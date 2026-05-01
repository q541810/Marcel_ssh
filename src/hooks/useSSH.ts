import { useCallback } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { sshSendInput } from '@/lib/tauri';
import type { ConnectionConfig } from '@/lib/types';

export function useSSH() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const connectSession = useSessionStore((s) => s.connect);
  const disconnectSession = useSessionStore((s) => s.disconnect);
  const getActiveSession = useSessionStore((s) => s.getActiveSession);

  const activeSession = getActiveSession();
  const isConnected = activeSession?.status === 'connected';

  const connect = useCallback(
    async (config: ConnectionConfig) => {
      return connectSession(config);
    },
    [connectSession],
  );

  const disconnect = useCallback(
    async (sessionId: string) => {
      return disconnectSession(sessionId);
    },
    [disconnectSession],
  );

  const sendInput = useCallback(
    async (data: string) => {
      if (!activeSessionId) return;
      await sshSendInput(activeSessionId, data);
    },
    [activeSessionId],
  );

  return {
    connect,
    disconnect,
    sendInput,
    activeSession,
    sessions,
    isConnected,
  };
}
