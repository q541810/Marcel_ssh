import { create } from 'zustand';
import type {
  AgentMessage,
  AgentConversation,
  StoredMessage,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { storedMessageToAgentMessage, clearIntermediateReasoning } from './messageConversion';
import { useTaskStore } from './taskStore';

export interface ConversationState {
  conversations: Record<string, AgentConversation>;
  messages: Record<string, AgentMessage[]>;
  activeConversationId: string | null;

  addMessage: (message: AgentMessage) => void;
  clearMessages: () => void;
  newConversation: (sessionId: string, connectionId: string) => Promise<string>;
  switchConversation: (conversationId: string) => Promise<void>;
  loadConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  clearConnectionConversations: (connectionId: string) => void;
  loadConnectionConversations: (connectionId: string) => Promise<void>;
  getCurrentMessages: () => AgentMessage[];
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: {},
  messages: {},
  activeConversationId: null,

  addMessage: (message: AgentMessage) => {
    const convId = get().activeConversationId;
    if (!convId) return;
    set((state) => ({
      messages: {
        ...state.messages,
        [convId]: [...state.messages[convId], message],
      },
    }));
  },

  clearMessages: () => {
    const convId = get().activeConversationId;
    if (!convId) return;
    set((state) => ({
      messages: { ...state.messages, [convId]: [] },
    }));
  },

  newConversation: async (sessionId: string, connectionId: string) => {
    const id = await tauri.agentCreateConversation(sessionId);
    const now = new Date().toISOString();
    set((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          id,
          connectionId,
          title: '新会话',
          createdAt: now,
          updatedAt: now,
        },
      },
      messages: { ...state.messages, [id]: [] },
      activeConversationId: id,
    }));
    await get().loadConnectionConversations(connectionId);
    return id;
  },

  switchConversation: async (conversationId: string) => {
    const stored = await tauri.agentLoadConversation(conversationId);
    const msgs: AgentMessage[] = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
      activeConversationId: conversationId,
    }));
    useTaskStore.setState({ activeTaskId: null });
  },

  loadConversation: async (conversationId: string) => {
    const stored = await tauri.agentLoadConversation(conversationId);
    const msgs: AgentMessage[] = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
      activeConversationId: conversationId,
    }));
    useTaskStore.setState({ activeTaskId: null });
  },

  deleteConversation: async (conversationId: string) => {
    await tauri.agentDeleteConversation(conversationId);
    set((state) => {
      const { [conversationId]: _, ...conversations } = state.conversations;
      const { [conversationId]: __, ...messages } = state.messages;
      return {
        conversations,
        messages,
        activeConversationId:
          state.activeConversationId === conversationId
            ? Object.keys(conversations)[0] || null
            : state.activeConversationId,
      };
    });
  },

  clearConnectionConversations: (connectionId: string) => {
    const convs = get().conversations;
    const toRemove = Object.values(convs)
      .filter((c) => c.connectionId === connectionId)
      .map((c) => c.id);
    set((state) => {
      const conversations = { ...state.conversations };
      const messages = { ...state.messages };
      for (const id of toRemove) {
        delete conversations[id];
        delete messages[id];
      }
      return {
        conversations,
        messages,
        activeConversationId:
          state.activeConversationId && toRemove.includes(state.activeConversationId)
            ? Object.keys(conversations)[0] || null
            : state.activeConversationId,
      };
    });
  },

  loadConnectionConversations: async (connectionId: string) => {
    const convs = await tauri.agentListConversationsByConnection(connectionId);

    const loadedMessages: Record<string, AgentMessage[]> = {};
    for (const conv of convs) {
      const stored = await tauri.agentLoadConversation(conv.id);
      loadedMessages[conv.id] = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
    }

    set((state) => {
      const incomingConvIds = new Set(convs.map((c) => c.id));

      const toRemove = Object.values(state.conversations)
        .filter((c) => c.connectionId === connectionId && !incomingConvIds.has(c.id))
        .map((c) => c.id);

      const newConversations: Record<string, AgentConversation> = { ...state.conversations };
      const newMessages: Record<string, AgentMessage[]> = { ...state.messages };

      for (const id of toRemove) {
        delete newConversations[id];
        delete newMessages[id];
      }

      for (const conv of convs) {
        newConversations[conv.id] = conv;
        newMessages[conv.id] = loadedMessages[conv.id];
      }

      const firstConvId = convs.length > 0 ? convs[0].id : null;
      const isActiveStillValid = state.activeConversationId && newConversations[state.activeConversationId];

      return {
        conversations: newConversations,
        messages: newMessages,
        activeConversationId: isActiveStillValid ? state.activeConversationId : (firstConvId || state.activeConversationId || null),
      };
    });
  },

  getCurrentMessages: () => {
    const convId = get().activeConversationId;
    if (!convId) return [];
    return get().messages[convId] || [];
  },
}));
