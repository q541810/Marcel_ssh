import { create } from 'zustand';
import type { SavedConnection } from '@/lib/types';
import * as tauri from '@/lib/tauri';

interface ConnectionState {
  connections: SavedConnection[];
  activeConnectionId: string | null;
  loading: boolean;
  error: string | null;

  fetchConnections: () => Promise<void>;
  addConnection: (connection: SavedConnection) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  setActiveConnection: (id: string | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  loading: false,
  error: null,

  fetchConnections: async () => {
    set({ loading: true, error: null });
    try {
      const connections = await tauri.getConnections();
      set({ connections, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  addConnection: async (connection: SavedConnection) => {
    set({ loading: true, error: null });
    try {
      await tauri.saveConnection(connection);
      await get().fetchConnections();
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  removeConnection: async (id: string) => {
    set({ loading: true, error: null });
    try {
      await tauri.deleteConnection(id);
      const { activeConnectionId } = get();
      if (activeConnectionId === id) {
        set({ activeConnectionId: null });
      }
      await get().fetchConnections();
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  setActiveConnection: (id: string | null) => {
    set({ activeConnectionId: id });
  },
}));
