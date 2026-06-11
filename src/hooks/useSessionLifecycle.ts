import { useConversationStore } from '@/stores/agentStore';

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
      useConversationStore.getState().clearConnectionConversations(connectionId);
    },
  };
}
