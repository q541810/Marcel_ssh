import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Session, ConnectionConfig } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import { terminalInstanceManager } from '@/components/terminal/TerminalInstanceManager';

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
    // Allow a new failure banner if reconnect fails; keep stdin disabled
    terminalInstanceManager.prepareReconnect(sessionId);

    try {
      await tauri.sshReconnect(sessionId, connectionId, trustNewHostKey);
      void attachSessionStatusListener(sessionId);
      terminalInstanceManager.onReconnected(sessionId);
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
      // Connect failed before a live session — still show banner + disable stdin
      terminalInstanceManager.showDisconnectBanner(sessionId, 'error', errorMessage);
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
    const session = get().sessions[sessionId];
    if (!session) return;

    const prev = session.status;
    // Side effects outside set(); banner is idempotent via disconnectBannerShown
    if (status === 'disconnected' && prev !== 'disconnected') {
      const reason = errorMessage?.trim() || '连接已关闭';
      const kind = reason === '已主动断开连接' ? 'manual' : 'disconnected';
      terminalInstanceManager.showDisconnectBanner(sessionId, kind, reason);
    } else if (status === 'error' && prev !== 'error') {
      terminalInstanceManager.showDisconnectBanner(
        sessionId,
        'error',
        errorMessage?.trim() || '未知错误',
      );
    } else if (status === 'connected' && prev !== 'connected') {
      terminalInstanceManager.onReconnected(sessionId);
    } else if (status === 'connecting') {
      terminalInstanceManager.setStdinEnabled(sessionId, false);
    }

    set((state) => {
      const current = state.sessions[sessionId];
      if (!current) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            status,
            errorMessage:
              status === 'error' || status === 'disconnected' ? errorMessage : undefined,
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

function parseStatusPayload(
  payload: unknown,
): { status: Session['status']; reason?: string } | null {
  // Legacy plain strings
  if (payload === 'connected') return { status: 'connected' };
  if (payload === 'disconnected') return { status: 'disconnected', reason: '连接已关闭' };

  if (typeof payload !== 'object' || payload === null) return null;
  const obj = payload as Record<string, unknown>;

  // serde externally-tagged: { "disconnected": { "reason": "..." } }
  if ('disconnected' in obj) {
    const inner = obj.disconnected;
    if (typeof inner === 'object' && inner !== null) {
      const reason = (inner as Record<string, unknown>).reason;
      return {
        status: 'disconnected',
        reason: typeof reason === 'string' && reason.trim() ? reason : '连接已关闭',
      };
    }
    return { status: 'disconnected', reason: '连接已关闭' };
  }

  // { "error": "..." }  (tuple variant Error(String))
  if ('error' in obj) {
    const errorMessage =
      typeof obj.error === 'string' && obj.error.trim() ? obj.error : '未知错误';
    return { status: 'error', reason: errorMessage };
  }

  // { "connected": null } or just nested form
  if ('connected' in obj) return { status: 'connected' };

  return null;
}

async function attachSessionStatusListener(sessionId: string) {
  if (statusListeners.has(sessionId)) return;

  const unlisten = await listen<unknown>(
    `ssh://status/${sessionId}`,
    (event) => {
      const parsed = parseStatusPayload(event.payload);
      if (!parsed) return;
      const store = useSessionStore.getState();
      if (parsed.status === 'connected') {
        store.updateSessionStatus(sessionId, 'connected');
      } else if (parsed.status === 'disconnected') {
        store.updateSessionStatus(sessionId, 'disconnected', parsed.reason);
        const fn = statusListeners.get(sessionId);
        if (fn) {
          fn();
          statusListeners.delete(sessionId);
        }
      } else if (parsed.status === 'error') {
        store.updateSessionStatus(sessionId, 'error', parsed.reason);
      }
    },
  );
  statusListeners.set(sessionId, unlisten);
}
