import { useConversationStore } from '@/stores/agentStore';

export function useSessionLifecycle() {
  return {
    onConnected: (connectionId: string) => {
      const currentConvs = useConversationStore.getState().conversations;
      const hasConvsForConnection = Object.values(currentConvs).some(
        (c) => c.connectionId === connectionId,
      );
      if (!hasConvsForConnection) {
        void useConversationStore.getState().loadConnectionConversations(connectionId);
      }
    },
    onDisconnected: (connectionId: string) => {
      useConversationStore.getState().clearConnectionConversations(connectionId);
    },
  };
}
