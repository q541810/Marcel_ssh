import { create } from 'zustand';
import type { FolderUploadPhase } from '@/hooks/sftpUploadStatus';

export type TransferKind = 'upload' | 'folder-upload' | 'download';

export type TransferStatus =
  | 'queued'
  | 'active'
  | 'cancelling'
  | 'done'
  | 'error'
  | 'cancelled';

/** upload + folder-upload 共用上传道，download 独占下载道 */
export type TransferLane = 'upload' | 'download';

export interface TransferItem {
  id: string;
  kind: TransferKind;
  sessionId: string;
  fileName: string;
  /** 上传源路径 / 下载保存路径 */
  localPath: string;
  remotePath: string;
  flat?: boolean;
  phase?: FolderUploadPhase;
  written: number;
  total: number;
  statusText: string;
  createdAt: number;
  finishedAt?: number;
}

const FINISHED_STATUSES: ReadonlySet<TransferStatus> = new Set(['done', 'error', 'cancelled']);
const MAX_FINISHED_ITEMS = 50;

export function isFinished(status: TransferStatus): boolean {
  return FINISHED_STATUSES.has(status);
}

export function laneOf(kind: TransferKind): TransferLane {
  return kind === 'download' ? 'download' : 'upload';
}

export interface StoredTransferItem extends TransferItem {
  status: TransferStatus;
}

interface TransferCenterState {
  items: Record<string, StoredTransferItem>;
  order: string[];

  open: boolean;
  setOpen: (open: boolean) => void;

  addItem: (item: TransferItem) => void;
  updateItem: (id: string, patch: Partial<StoredTransferItem>) => void;
  removeItem: (id: string) => void;
  clearFinished: () => void;
}

export const useTransferStore = create<TransferCenterState>((set) => ({
  items: {},
  order: [],
  open: false,

  setOpen: (open) => set({ open }),

  addItem: (item) =>
    set((state) => {
      if (state.items[item.id]) return state;
      let items: Record<string, StoredTransferItem> = {
        ...state.items,
        [item.id]: { ...item, status: 'queued' },
      };
      let order = [...state.order, item.id];
      // 完成项超上限时裁剪最旧的完成项
      const finishedIds = order.filter((id) => isFinished(items[id].status));
      if (finishedIds.length > MAX_FINISHED_ITEMS) {
        const toDrop = new Set(finishedIds.slice(0, finishedIds.length - MAX_FINISHED_ITEMS));
        order = order.filter((id) => !toDrop.has(id));
        items = Object.fromEntries(order.map((id) => [id, items[id]]));
      }
      return { items, order };
    }),

  updateItem: (id, patch) =>
    set((state) => {
      const current = state.items[id];
      if (!current) return state;
      // 终态不可回退到进行中
      if (
        isFinished(current.status) &&
        patch.status !== undefined &&
        !isFinished(patch.status)
      ) {
        return state;
      }
      return { items: { ...state.items, [id]: { ...current, ...patch } } };
    }),

  removeItem: (id) =>
    set((state) => {
      if (!state.items[id]) return state;
      const items = { ...state.items };
      delete items[id];
      return { items, order: state.order.filter((x) => x !== id) };
    }),

  clearFinished: () =>
    set((state) => {
      const order = state.order.filter((id) => !isFinished(state.items[id].status));
      if (order.length === state.order.length) return state;
      return {
        order,
        items: Object.fromEntries(order.map((id) => [id, state.items[id]])),
      };
    }),
}));

// ---------------------------------------------------------------------------
// Selectors（纯函数，可单测）
// ---------------------------------------------------------------------------

type TransferSnapshot = Pick<TransferCenterState, 'items' | 'order'>;

export function selectByLane(state: TransferSnapshot, lane: TransferLane): StoredTransferItem[] {
  return state.order
    .map((id) => state.items[id])
    .filter((item) => laneOf(item.kind) === lane);
}

export function selectActiveOf(state: TransferSnapshot, lane: TransferLane): StoredTransferItem | null {
  return (
    selectByLane(state, lane).find(
      (item) =>
        (item.status === 'active' || item.status === 'cancelling') &&
        // sysopen 项由后端 sftp-sysopen-state 事件驱动状态，不进 pump 调度，
        // 不能占用 lane（否则会挡住普通 upload/download 任务启动）。
        !item.id.startsWith('sysopen-'),
    ) ?? null
  );
}

export function selectQueuedOf(state: TransferSnapshot, lane: TransferLane): StoredTransferItem[] {
  return selectByLane(state, lane).filter((item) => item.status === 'queued');
}

export function selectBadgeCount(state: TransferSnapshot): number {
  return state.order.filter((id) => !isFinished(state.items[id].status)).length;
}
