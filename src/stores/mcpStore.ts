import { create } from 'zustand';
import type { McpServer, McpServerInput, McpServerRuntimeStatus } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';

/**
 * Post-write refresh policy (single source of truth):
 * - add: refresh when server.enabled
 * - update: refresh when input.enabled
 * - delete: never
 * - toggle: backend does not clear tools cache; FE still refreshes when turning on
 */

interface McpState {
  servers: McpServer[];
  statuses: Record<string, McpServerRuntimeStatus>;
  loading: boolean;
  refreshingIds: Record<string, boolean>;
  error: string | null;
  fetchServers: (opts?: { silent?: boolean }) => Promise<void>;
  addServer: (input: McpServerInput) => Promise<void>;
  updateServer: (id: string, input: McpServerInput) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  toggleServer: (id: string) => Promise<void>;
  refreshTools: (id: string) => Promise<void>;
}

function indexStatuses(statuses: McpServerRuntimeStatus[]) {
  return Object.fromEntries(statuses.map((status) => [status.serverId, status]));
}

export const useMcpStore = create<McpState>((set, get) => {
  const afterWrite = async (opts: { refreshId?: string; refreshWhen?: boolean }) => {
    await get().fetchServers({ silent: true });
    if (opts.refreshId && opts.refreshWhen) {
      await get().refreshTools(opts.refreshId);
    }
  };

  return {
    servers: [],
    statuses: {},
    loading: false,
    refreshingIds: {},
    error: null,

    fetchServers: async (opts) => {
      const silent = opts?.silent === true;
      if (!silent) set({ loading: true, error: null });
      try {
        const response = await tauri.mcpListServers();
        set({
          servers: response.servers,
          statuses: indexStatuses(response.statuses),
          error: null,
        });
      } catch (err) {
        set({ error: getErrorMessage(err) });
      } finally {
        if (!silent) set({ loading: false });
      }
    },

    addServer: async (input) => {
      try {
        const server = await tauri.mcpAddServer(input);
        await afterWrite({ refreshId: server.id, refreshWhen: server.enabled });
      } catch (err) {
        set({ error: getErrorMessage(err) });
        throw err;
      }
    },

    updateServer: async (id, input) => {
      try {
        await tauri.mcpUpdateServer(id, input);
        await afterWrite({ refreshId: id, refreshWhen: input.enabled });
      } catch (err) {
        set({ error: getErrorMessage(err) });
        throw err;
      }
    },

    deleteServer: async (id) => {
      try {
        await tauri.mcpDeleteServer(id);
        await afterWrite({});
      } catch (err) {
        await get().fetchServers({ silent: true });
        set({ error: getErrorMessage(err) });
      }
    },

    toggleServer: async (id) => {
      const prev = get().servers.find((s) => s.id === id);
      const willEnable = prev ? !prev.enabled : false;
      set((state) => ({
        servers: state.servers.map((server) =>
          server.id === id ? { ...server, enabled: !server.enabled } : server,
        ),
      }));
      try {
        await tauri.mcpToggleServer(id);
        await afterWrite({ refreshId: id, refreshWhen: willEnable });
      } catch (err) {
        await get().fetchServers({ silent: true });
        set({ error: getErrorMessage(err) });
      }
    },

    refreshTools: async (id) => {
      if (get().refreshingIds[id]) return;
      set((state) => ({
        refreshingIds: { ...state.refreshingIds, [id]: true },
        error: null,
      }));
      try {
        await tauri.mcpRefreshTools(id);
        await get().fetchServers({ silent: true });
      } catch (err) {
        await get().fetchServers({ silent: true });
        set({ error: getErrorMessage(err) });
      } finally {
        set((state) => {
          const next = { ...state.refreshingIds };
          delete next[id];
          return { refreshingIds: next };
        });
      }
    },
  };
});
