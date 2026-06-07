import { create } from 'zustand';
import type { McpServer, McpServerInput, McpServerRuntimeStatus } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';

interface McpState {
  servers: McpServer[];
  statuses: Record<string, McpServerRuntimeStatus>;
  loading: boolean;
  error: string | null;
  fetchServers: () => Promise<void>;
  addServer: (input: McpServerInput) => Promise<void>;
  updateServer: (id: string, input: McpServerInput) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  toggleServer: (id: string) => Promise<void>;
  refreshTools: (id: string) => Promise<void>;
}

function indexStatuses(statuses: McpServerRuntimeStatus[]) {
  return Object.fromEntries(statuses.map((status) => [status.serverId, status]));
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  statuses: {},
  loading: false,
  error: null,

  fetchServers: async () => {
    set({ loading: true, error: null });
    try {
      const response = await tauri.mcpListServers();
      set({ servers: response.servers, statuses: indexStatuses(response.statuses) });
    } catch (err) {
      set({ error: getErrorMessage(err) });
    } finally {
      set({ loading: false });
    }
  },

  addServer: async (input) => {
    set({ loading: true, error: null });
    try {
      const server = await tauri.mcpAddServer(input);
      await get().fetchServers();
      await get().refreshTools(server.id);
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
      throw err;
    }
  },

  updateServer: async (id, input) => {
    set({ loading: true, error: null });
    try {
      await tauri.mcpUpdateServer(id, input);
      await get().fetchServers();
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
      throw err;
    }
  },

  deleteServer: async (id) => {
    set({ loading: true, error: null });
    try {
      await tauri.mcpDeleteServer(id);
      await get().fetchServers();
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },

  toggleServer: async (id) => {
    set((state) => ({
      servers: state.servers.map((server) => (server.id === id ? { ...server, enabled: !server.enabled } : server)),
    }));
    try {
      await tauri.mcpToggleServer(id);
      await get().fetchServers();
    } catch (err) {
      set({ error: getErrorMessage(err) });
      await get().fetchServers();
    }
  },

  refreshTools: async (id) => {
    set({ error: null });
    try {
      await tauri.mcpRefreshTools(id);
      await get().fetchServers();
    } catch (err) {
      set({ error: getErrorMessage(err) });
      await get().fetchServers();
    }
  },
}));
