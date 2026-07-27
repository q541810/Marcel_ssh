import {
  sftpUploadStream,
  sftpUploadFolderStream,
  sftpDownloadStream,
  sftpCancelUpload,
  sftpCancelDownload,
  sftpCancelSysopen,
} from '@/lib/tauri';
import { getErrorMessage } from '@/lib/sftp-helpers';
import { useSessionStore } from './sessionStore';
import { flyToTransferCenter } from './transferFlyAnimation';
import {
  useTransferStore,
  laneOf,
  selectActiveOf,
  selectQueuedOf,
  type TransferItem,
  type TransferLane,
} from './transferStore';

const CANCELLED_MSGS = new Set(['上传已取消', '下载已取消']);

// 模块级：每条车道当前运行项 id
const running: Record<TransferLane, string | null> = {
  upload: null,
  download: null,
};

// 完成回调（不进 zustand，避免序列化函数）
const finishedCallbacks = new Map<string, (item: TransferItem & { status: string }) => void>();

export function createTransferId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isSessionAlive(sessionId: string): boolean {
  const session = useSessionStore.getState().sessions[sessionId];
  return session !== undefined && session.status !== 'disconnected' && session.status !== 'error';
}

function finalize(id: string, patch: { status: 'done' | 'error' | 'cancelled'; statusText: string }) {
  const { updateItem, items } = useTransferStore.getState();
  updateItem(id, { ...patch, finishedAt: Date.now() });
  const cb = finishedCallbacks.get(id);
  finishedCallbacks.delete(id);
  const item = useTransferStore.getState().items[id] ?? items[id];
  if (cb && item) cb(item);
}

async function runItem(item: TransferItem): Promise<void> {
  if (item.kind === 'upload') {
    await sftpUploadStream(item.sessionId, item.remotePath, item.localPath, item.id);
  } else if (item.kind === 'folder-upload') {
    await sftpUploadFolderStream(
      item.sessionId,
      item.localPath,
      item.remotePath,
      item.id,
      item.flat ?? false,
    );
  } else {
    await sftpDownloadStream(item.sessionId, item.remotePath, item.localPath, item.id);
  }
}

function startingText(item: TransferItem): string {
  if (item.kind === 'download') return `正在下载 ${item.fileName} ...`;
  if (item.kind === 'folder-upload') return '正在检查远端解压工具';
  return `正在上传 ${item.fileName} ...`;
}

function pump(lane: TransferLane): void {
  if (running[lane] !== null) return;
  const state = useTransferStore.getState();
  if (selectActiveOf(state, lane)) return;
  const next = selectQueuedOf(state, lane)[0];
  if (!next) return;

  if (!isSessionAlive(next.sessionId)) {
    finalize(next.id, { status: 'error', statusText: '会话已断开，任务已跳过' });
    pump(lane);
    return;
  }

  running[lane] = next.id;
  state.updateItem(next.id, { status: 'active', statusText: startingText(next) });

  void runItem(next)
    .then(() => {
      // 单文件上传/下载通常已由 done 事件终结；folder-upload 以命令 resolve 为完成信号
      const item = useTransferStore.getState().items[next.id];
      if (item && (item.status === 'active' || item.status === 'cancelling')) {
        finalize(next.id, {
          status: 'done',
          statusText:
            next.kind === 'download' ? `${next.fileName} 下载完成` : `${next.fileName} 上传完成`,
        });
      } else {
        // 事件已终结，仍需触发回调
        const cb = finishedCallbacks.get(next.id);
        finishedCallbacks.delete(next.id);
        if (cb && item) cb(item);
      }
    })
    .catch((err) => {
      const msg = getErrorMessage(err);
      if (CANCELLED_MSGS.has(msg)) {
        finalize(next.id, {
          status: 'cancelled',
          statusText:
            next.kind === 'download' ? `${next.fileName} 下载已取消` : `${next.fileName} 上传已取消`,
        });
      } else {
        finalize(next.id, {
          status: 'error',
          statusText: next.kind === 'download' ? `下载失败：${msg}` : `上传失败：${msg}`,
        });
      }
    })
    .finally(() => {
      running[lane] = null;
      pump(lane);
    });
}

/** 入队一个传输任务并启动对应车道。onFinished 在任务到达终态时回调一次。 */
export function enqueueTransfer(
  item: TransferItem,
  onFinished?: (item: TransferItem & { status: string }) => void,
): void {
  const store = useTransferStore.getState();
  store.addItem(item);
  if (onFinished && useTransferStore.getState().items[item.id]) {
    finishedCallbacks.set(item.id, onFinished);
  }
  // 视觉反馈：一个小图标从用户刚操作处飞入传输中心（§7 空间一致性 / §13 因果性）
  flyToTransferCenter(item.kind === 'download' ? 'download' : 'upload');
  pump(laneOf(item.kind));
}

/** 取消一个传输：排队中直接标记取消；进行中通知 Rust 中止，终态由命令 reject 落地。 */
export function cancelTransfer(id: string): void {
  const state = useTransferStore.getState();
  const item = state.items[id];
  if (!item) return;

  if (item.status === 'queued') {
    finalize(id, { status: 'cancelled', statusText: '已取消' });
    return;
  }
  if (item.status !== 'active') return;

  state.updateItem(id, { status: 'cancelling', statusText: `正在取消 ${item.fileName} ...` });
  if (item.kind === 'upload' && id.startsWith('sysopen-')) {
    void sftpCancelSysopen(id).catch(() => {});
    finalize(id, { status: 'cancelled', statusText: '已取消监视' });
  } else {
    const cancel = item.kind === 'download' ? sftpCancelDownload : sftpCancelUpload;
    void cancel(id).catch(() => {});
  }
}

let sessionSubscribed = false;

/** 订阅会话状态：会话断开时使其所有排队任务失败。幂等。 */
export function initTransferScheduler(): void {
  if (sessionSubscribed) return;
  sessionSubscribed = true;
  useSessionStore.subscribe((state, prev) => {
    if (state.sessions === prev.sessions) return;
    const transfer = useTransferStore.getState();
    for (const id of transfer.order) {
      const item = transfer.items[id];
      if (item.status !== 'queued') continue;
      if (!isSessionAlive(item.sessionId)) {
        finalize(id, { status: 'error', statusText: '会话已断开，任务已跳过' });
      }
    }
  });
}

/** 测试专用：清空车道与回调状态。 */
export function _resetForTests(): void {
  running.upload = null;
  running.download = null;
  finishedCallbacks.clear();
}
