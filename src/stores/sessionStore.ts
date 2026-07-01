import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Session, ConnectionConfig } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';

interface SessionState {
  sessions: Record<string, Session>;
  activeSessionId: string | null;

  connect: (config: ConnectionConfig) => Promise<string>;
  connectWithSavedPassword: (connectionId: string, connLabel: string, trustNewHostKey?: boolean) => Promise<string>;
  connectWithSavedPassphrase: (connectionId: string, connLabel: string, trustNewHostKey?: boolean) => Promise<string>;
  reconnect: (sessionId: string, trustNewHostKey?: boolean) => Promise<void>;
  disconnect: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string | null) => void;
  getActiveSession: () => Session | null;
  updateSessionStatus: (sessionId: string, status: Session['status'], errorMessage?: string) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: {},
  activeSessionId: null,

  connect: async (config: ConnectionConfig) => {
    const tempId = crypto.randomUUID();
    const connLabel = `${config.username}@${config.host}:${config.port}`;
    const session: Session = {
      id: tempId,
      connectionId: connLabel,
      status: 'connecting',
      createdAt: new Date().toISOString(),
      configId: config.connectionId,
    };

    set((state) => ({
      sessions: { ...state.sessions, [tempId]: session },
      activeSessionId: tempId,
    }));

    try {
      const sessionId = await tauri.sshConnect(config);

      void attachSessionStatusListener(sessionId);

      set((state) => {
        const updated = { ...state.sessions };
        delete updated[tempId];
        updated[sessionId] = {
          ...session,
          id: sessionId,
          status: 'connected',
        };
        return { sessions: updated, activeSessionId: sessionId };
      });

      return sessionId;
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      set((state) => {
        const updated = { ...state.sessions };
        const existing = updated[tempId];
        if (existing) {
          updated[tempId] = { ...existing, status: 'error', errorMessage };
        }
        return { sessions: updated };
      });
      throw err;
    }
  },

  connectWithSavedPassword: async (connectionId: string, connLabel: string, trustNewHostKey = false) => {
    const tempId = crypto.randomUUID();
    const session: Session = {
      id: tempId,
      connectionId: connLabel,
      status: 'connecting',
      createdAt: new Date().toISOString(),
      configId: connectionId,
    };

    set((state) => ({
      sessions: { ...state.sessions, [tempId]: session },
      activeSessionId: tempId,
    }));

    try {
      const sessionId = await tauri.connectWithSavedPassword(connectionId, trustNewHostKey);

      void attachSessionStatusListener(sessionId);

      set((state) => {
        const updated = { ...state.sessions };
        delete updated[tempId];
        updated[sessionId] = {
          ...session,
          id: sessionId,
          status: 'connected',
        };
        return { sessions: updated, activeSessionId: sessionId };
      });

      return sessionId;
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      set((state) => {
        const updated = { ...state.sessions };
        const existing = updated[tempId];
        if (existing) {
          updated[tempId] = { ...existing, status: 'error', errorMessage };
        }
        return { sessions: updated };
      });
      throw err;
    }
  },

  connectWithSavedPassphrase: async (connectionId: string, connLabel: string, trustNewHostKey = false) => {
    const tempId = crypto.randomUUID();
    const session: Session = {
      id: tempId,
      connectionId: connLabel,
      status: 'connecting',
      createdAt: new Date().toISOString(),
      configId: connectionId,
    };

    set((state) => ({
      sessions: { ...state.sessions, [tempId]: session },
      activeSessionId: tempId,
    }));

    try {
      const sessionId = await tauri.connectWithSavedPassphrase(connectionId, trustNewHostKey);

      void attachSessionStatusListener(sessionId);

      set((state) => {
        const updated = { ...state.sessions };
        delete updated[tempId];
        updated[sessionId] = {
          ...session,
          id: sessionId,
          status: 'connected',
        };
        return { sessions: updated, activeSessionId: sessionId };
      });

      return sessionId;
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      set((state) => {
        const updated = { ...state.sessions };
        const existing = updated[tempId];
        if (existing) {
          updated[tempId] = { ...existing, status: 'error', errorMessage };
        }
        return { sessions: updated };
      });
      throw err;
    }
  },

  reconnect: async (sessionId: string, trustNewHostKey = false) => {
    const session = get().sessions[sessionId];
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }
    const connectionId = session.configId;
    if (!connectionId) {
      throw new Error('临时连接无法自动重连，请去侧边栏重新连接');
    }

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...state.sessions[sessionId], status: 'connecting', errorMessage: undefined },
      },
    }));

    try {
      await tauri.sshReconnect(sessionId, connectionId, trustNewHostKey);
      void attachSessionStatusListener(sessionId);
      set((state) => {
        const existing = state.sessions[sessionId];
        if (!existing) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...existing, status: 'connected', errorMessage: undefined },
          },
        };
      });
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      set((state) => {
        const existing = state.sessions[sessionId];
        if (!existing) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...existing, status: 'error', errorMessage },
          },
        };
      });
      throw err;
    }
  },

  disconnect: async (sessionId: string) => {
    set((state) => {
      const updated = { ...state.sessions };
      delete updated[sessionId];
      const remainingIds = Object.keys(updated);
      const nextActiveId =
        state.activeSessionId === sessionId
          ? remainingIds[remainingIds.length - 1] ?? null
          : state.activeSessionId;
      return { sessions: updated, activeSessionId: nextActiveId };
    });
    try {
      await tauri.sshDisconnect(sessionId);
    } catch (err) {
      console.warn('Disconnect error (session may already be closed):', err);
    }
  },

  setActiveSession: (sessionId: string | null) => {
    set({ activeSessionId: sessionId });
  },

  getActiveSession: () => {
    const { sessions, activeSessionId } = get();
    if (!activeSessionId) return null;
    return sessions[activeSessionId] ?? null;
  },

  updateSessionStatus: (sessionId: string, status: Session['status'], errorMessage?: string) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            status,
            errorMessage: status === 'error' ? errorMessage : undefined,
          },
        },
      };
    });
  },
}));

/**
 * Track active backend status listeners so we don't double-subscribe.
 */
const statusListeners: Map<string, UnlistenFn> = new Map();

async function attachSessionStatusListener(sessionId: string) {
  if (statusListeners.has(sessionId)) return;

  const unlisten = await listen<unknown>(
    `ssh://status/${sessionId}`,
    (event) => {
      const payload = event.payload;
      // Backend emits SshStatus which is either a string ('connected'/'disconnected')
      // or an object { error: '...' } for the Error variant.
      const store = useSessionStore.getState();
      if (payload === 'connected') {
        store.updateSessionStatus(sessionId, 'connected');
      } else if (payload === 'disconnected') {
        store.updateSessionStatus(sessionId, 'disconnected');
        // Clean up listener
        const fn = statusListeners.get(sessionId);
        if (fn) {
          fn();
          statusListeners.delete(sessionId);
        }
      } else if (typeof payload === 'object' && payload !== null && 'error' in payload) {
        const errorMessage = typeof (payload as Record<string, unknown>).error === 'string'
          ? (payload as Record<string, unknown>).error as string
          : '未知错误';
        store.updateSessionStatus(sessionId, 'error', errorMessage);
      }
    },
  );
  statusListeners.set(sessionId, unlisten);
}
