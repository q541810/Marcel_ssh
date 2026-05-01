import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Session, ConnectionConfig } from '@/lib/types';
import * as tauri from '@/lib/tauri';

interface SessionState {
  sessions: Record<string, Session>;
  activeSessionId: string | null;

  connect: (config: ConnectionConfig) => Promise<string>;
  disconnect: (sessionId: string) => Promise<void>;
  setActiveSession: (sessionId: string | null) => void;
  getActiveSession: () => Session | null;
  updateSessionStatus: (sessionId: string, status: Session['status']) => void;
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
    };

    set((state) => ({
      sessions: { ...state.sessions, [tempId]: session },
      activeSessionId: tempId,
    }));

    try {
      const sessionId = await tauri.sshConnect(config);

      // Listen for backend status events for this session
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
      set((state) => {
        const updated = { ...state.sessions };
        const existing = updated[tempId];
        if (existing) {
          updated[tempId] = { ...existing, status: 'error' };
        }
        return { sessions: updated };
      });
      throw err;
    }
  },

  disconnect: async (sessionId: string) => {
    try {
      await tauri.sshDisconnect(sessionId);
    } catch (err) {
      console.warn('Disconnect error (session may already be closed):', err);
    } finally {
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

  updateSessionStatus: (sessionId: string, status: Session['status']) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...session, status } },
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
        store.updateSessionStatus(sessionId, 'error');
      }
    },
  );
  statusListeners.set(sessionId, unlisten);
}
