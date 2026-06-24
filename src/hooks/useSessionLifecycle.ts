import { useConversationStore } from '@/stores/agentStore';
import { useSessionStore } from '@/stores/sessionStore';

export function useSessionLifecycle() {
  return {
    onConnected: async (connectionId: string, sessionId: string) => {
      await useConversationStore.getState().loadConnectionConversations(connectionId);
      const currentConvs = useConversationStore.getState().conversations;
      const hasConvsForConnection = Object.values(currentConvs).some(
        (c) => c.connectionId === connectionId,
      );
      if (!hasConvsForConnection) {
        await useConversationStore.getState().newConversation(sessionId, connectionId);
      }
    },
    onDisconnected: (connectionId: string) => {
      const sessions = useSessionStore.getState().sessions;
      const stillActive = Object.values(sessions).some((s) => s.configId === connectionId);
      if (!stillActive) {
        useConversationStore.getState().clearConnectionConversations(connectionId);
      }
    },
  };
}
