import { create } from 'zustand';
import type { SavedConnection } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { withLoading } from './createCrudStore';

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

  fetchConnections: () => withLoading(set, async () => {
    const connections = await tauri.getConnections();
    set({ connections });
  }),

  addConnection: (connection: SavedConnection) => withLoading(set, async () => {
    await tauri.saveConnection(connection);
    await get().fetchConnections();
  }),

  removeConnection: (id: string) => withLoading(set, async () => {
    await tauri.deleteConnection(id);
    const { activeConnectionId } = get();
    if (activeConnectionId === id) {
      set({ activeConnectionId: null });
    }
    await get().fetchConnections();
  }),

  setActiveConnection: (id: string | null) => {
    set({ activeConnectionId: id });
  },
}));
