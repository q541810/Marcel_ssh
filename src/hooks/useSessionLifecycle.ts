import { sessionConversationBindingManager } from '@/stores/sessionConversationBindingManager';

export function useSessionLifecycle() {
  return {
    onConnected: async (connectionId: string, sessionId: string) => {
      await sessionConversationBindingManager.onSessionConnected(connectionId, sessionId);
    },
    onDisconnected: (connectionId: string, sessionId?: string) => {
      if (sessionId) {
        sessionConversationBindingManager.onSessionDisconnected(sessionId, connectionId);
      } else {
        sessionConversationBindingManager.onSessionDisconnected('', connectionId);
      }
    },
  };
}
