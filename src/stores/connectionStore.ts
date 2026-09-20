import { create } from "zustand";
import type { SavedConnection } from "@/lib/types";
import * as tauri from "@/lib/tauri";
import type { ConnectionOrderEntry } from "@/lib/tauri";
import { getErrorMessage } from "@/lib/errors";

interface ConnectionState {
  connections: SavedConnection[];
  activeConnectionId: string | null;
  loading: boolean;
  error: string | null;

  fetchConnections: () => Promise<void>;
  addConnection: (connection: SavedConnection) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  /** 应用拖拽后的顺序（组内重排 / 跨组移入 / 拖动分组）：乐观更新，失败回滚。 */
  applyConnectionOrder: (entries: ConnectionOrderEntry[]) => Promise<void>;
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
      set({ connections });
    } catch (err) {
      set({ error: getErrorMessage(err) });
    } finally {
      set({ loading: false });
    }
  },

  addConnection: async (connection: SavedConnection) => {
    set({ loading: true, error: null });
    try {
      await tauri.saveConnection(connection);
      await get().fetchConnections();
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
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
      set({ error: getErrorMessage(err), loading: false });
    }
  },

  setActiveConnection: (id: string | null) => {
    set({ activeConnectionId: id });
  },

  /**
   * 拖拽排序落库。**乐观更新**：拖完手一松，列表立刻是新顺序（拖拽必须跟手），
   * 后端失败再整体回滚并报错——后端是权威，本地绝不留下与磁盘不一致的顺序。
   * 请求里没有的连接保持原相对顺序补到末尾（与后端 `apply_order` 同一口径）。
   */
  applyConnectionOrder: async (entries: ConnectionOrderEntry[]) => {
    const prev = get().connections;
    const byId = new Map(prev.map((c) => [c.id, c]));
    const next: SavedConnection[] = [];
    for (const entry of entries) {
      const conn = byId.get(entry.id);
      if (!conn) continue;
      byId.delete(entry.id);
      const group = entry.group ?? undefined;
      next.push(conn.group === group ? conn : { ...conn, group });
    }
    for (const conn of byId.values()) next.push(conn);

    set({ connections: next, error: null });
    try {
      await tauri.applyConnectionOrder(entries);
    } catch (err) {
      set({ connections: prev, error: getErrorMessage(err) });
    }
  },
}));
