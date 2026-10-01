import { sessionConversationBindingManager } from '@/stores/sessionConversationBindingManager';
import { isDebugConnection, isDebugSession } from '@/lib/debugServer';

export function useSessionLifecycle() {
  return {
    onConnected: async (connectionId: string, sessionId: string) => {
      if (isDebugConnection(connectionId) || isDebugSession(sessionId)) return;
      await sessionConversationBindingManager.onSessionConnected(connectionId, sessionId);
    },
    onDisconnected: (connectionId: string, sessionId?: string) => {
      if (isDebugConnection(connectionId) || isDebugSession(sessionId)) return;
      if (sessionId) {
        sessionConversationBindingManager.onSessionDisconnected(sessionId, connectionId);
      } else {
        sessionConversationBindingManager.onSessionDisconnected('', connectionId);
      }
    },
  };
}
