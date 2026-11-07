import { create } from "zustand";
import type { RemotePlatform, SavedConnection } from "@/lib/types";
import * as tauri from "@/lib/tauri";
import type { ConnectionOrderEntry } from "@/lib/tauri";
import { getErrorMessage } from "@/lib/errors";
import { groupNameOf, toOrderEntries } from "@/lib/connectionOrder";
import { createDebugServer, isDebugConnection, mergeDebugServer } from '@/lib/debugServer';

interface ConnectionState {
  connections: SavedConnection[];
  activeConnectionId: string | null;
  loading: boolean;
  /**
   * 是否至少读回过一次后端的真值（启动快照或 `fetchConnections`，成败都算「问过了」）。
   * 初始 `connections: []` 只是占位，不等于「用户没有连接」：UI 想画空态，必须先看这个，
   * 否则启动那几十毫秒会先闪一下「暂无已保存的连接」再跳出真实列表。
   */
  loaded: boolean;
  error: string | null;

  /** `silent`：后台静默刷新（跨设备同步落地后用），不翻 loading、不闪动列表。 */
  fetchConnections: (opts?: { silent?: boolean }) => Promise<void>;
  addConnection: (connection: SavedConnection) => Promise<void>;
  addDebugServer: () => void;
  /** `deleteMemories` = 同时删掉这台机器的长期记忆（确认框里的复选框）。 */
  /**
   * `deleteConversations` = 同时彻底删掉这台机器的对话；不勾则对话被归档保留，
   * 在历史页「已删除的服务器」里还找得到。
   */
  removeConnection: (
    id: string,
    deleteMemories?: boolean,
    deleteConversations?: boolean,
  ) => Promise<void>;
  /** 应用拖拽后的顺序（组内重排 / 跨组移入 / 拖动分组）：乐观更新，失败回滚。 */
  applyConnectionOrder: (entries: ConnectionOrderEntry[]) => Promise<void>;
  /** 重命名分组：批量更新该组所有连接的 group 字段。 */
  renameGroup: (oldName: string, newName: string) => Promise<void>;
  setActiveConnection: (id: string | null) => void;
  /** 保存自动探测到的远端平台；失败不打扰连接流程，只回滚本地标记。 */
  setRemotePlatform: (id: string, platform: RemotePlatform) => Promise<void>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  loading: false,
  loaded: false,
  error: null,

  fetchConnections: async (opts) => {
    const silent = opts?.silent === true;
    if (!silent) set({ loading: true, error: null });
    try {
      const connections = await tauri.getConnections();
      set((state) => ({ connections: mergeDebugServer(connections, state.connections) }));
    } catch (err) {
      set({ error: getErrorMessage(err) });
    } finally {
      set(silent ? { loaded: true } : { loading: false, loaded: true });
    }
  },

  addConnection: async (connection: SavedConnection) => {
    if (isDebugConnection(connection.id)) return;
    set({ loading: true, error: null });
    try {
      await tauri.saveConnection(connection);
      await get().fetchConnections();
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },

  addDebugServer: () => {
    set((state) => state.connections.some((connection) => isDebugConnection(connection.id))
      ? state
      : { connections: [...state.connections, createDebugServer()] });
  },

  removeConnection: async (id: string, deleteMemories = false, deleteConversations = false) => {
    if (isDebugConnection(id)) {
      set((state) => ({
        connections: state.connections.filter((connection) => connection.id !== id),
        activeConnectionId: state.activeConnectionId === id ? null : state.activeConnectionId,
      }));
      return;
    }
    set({ loading: true, error: null });
    try {
      await tauri.deleteConnection(id, deleteMemories, deleteConversations);
      const { activeConnectionId } = get();
      if (activeConnectionId === id) {
        set({ activeConnectionId: null });
      }
      await get().fetchConnections();
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },

  setRemotePlatform: async (id: string, platform: RemotePlatform) => {
    const target = get().connections.find((connection) => connection.id === id);
    if (!target || target.remotePlatform === platform) return;

    const previous = target.remotePlatform;
    set((state) => ({
      connections: state.connections.map((connection) =>
        connection.id === id ? { ...connection, remotePlatform: platform } : connection,
      ),
    }));

    try {
      await tauri.setConnectionRemotePlatform(id, platform);
    } catch (err) {
      console.warn('持久化远端系统标识失败:', err);
      set((state) => ({
        connections: state.connections.map((connection) =>
          connection.id === id ? { ...connection, remotePlatform: previous } : connection,
        ),
      }));
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
      const savedEntries = entries.filter((entry) => !isDebugConnection(entry.id));
      if (savedEntries.length > 0) await tauri.applyConnectionOrder(savedEntries);
    } catch (err) {
      set({ connections: prev, error: getErrorMessage(err) });
    }
  },

  /**
   * 重命名分组：批量更新该组所有连接的 group 字段。
   * 乐观更新，失败回滚。空名字或纯空白当作「未分组」。
   */
  renameGroup: async (oldName: string, newName: string) => {
    const trimmedNew = newName.trim();
    if (trimmedNew === oldName) return; // 没改

    const prev = get().connections;
    const next = prev.map((conn) => {
      if (groupNameOf(conn) !== oldName) return conn;
      // 新名字为空 = 移到「未分组」
      const group = trimmedNew === '' ? undefined : trimmedNew;
      return { ...conn, group };
    });

    set({ connections: next, error: null });
    try {
      const savedEntries = toOrderEntries(next.filter((connection) => !isDebugConnection(connection.id)));
      if (savedEntries.length > 0) await tauri.applyConnectionOrder(savedEntries);
    } catch (err) {
      set({ connections: prev, error: getErrorMessage(err) });
    }
  },
}));
