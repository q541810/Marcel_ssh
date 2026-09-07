import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { formatSize } from "@/lib/sftp-helpers";
import {
  formatFolderUploadStatus,
  type FolderStatusPayload,
} from "@/hooks/sftpUploadStatus";
import { useTransferStore } from "./transferStore";
import { initTransferScheduler } from "./transferScheduler";
import { flyToTransferCenter } from "./transferFlyAnimation";
import type { SysopenStateEvent } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Listener handles (module-level, persist across component unmounts)
// ---------------------------------------------------------------------------

let progressUnlisten: UnlistenFn | null = null;
let doneUnlisten: UnlistenFn | null = null;
let folderStatusUnlisten: UnlistenFn | null = null;
let downloadProgressUnlisten: UnlistenFn | null = null;
let downloadDoneUnlisten: UnlistenFn | null = null;
let sysopenStateUnlisten: UnlistenFn | null = null;
let agentStartUnlisten: UnlistenFn | null = null;
let agentFinishedUnlisten: UnlistenFn | null = null;

let attached = false;

interface ProgressPayload {
  uploadId: string;
  written: number;
  total: number;
}

interface DonePayload {
  uploadId: string;
}

interface DownloadProgressPayload {
  downloadId: string;
  written: number;
  total: number;
}

interface DownloadDonePayload {
  downloadId: string;
}

/** agent-transfer-start 事件载荷（后端 agent/transfer.rs emit_start）。 */
interface AgentTransferStartPayload {
  transferId: string;
  kind: 'upload' | 'download';
  sessionId: string;
  fileName: string;
  localPath: string;
  remotePath: string;
  total: number;
  taskId: string;
  targetHostLabel?: string | null;
}

function progressText(
  action: "上传" | "下载" | "回传",
  written: number,
  total: number,
): string {
  const pct = total > 0 ? Math.round((written * 100) / total) : 0;
  // 防御：written 理论上不会超过 total（后端增长检测会提前终止），
  // 但展示层仍 clamp，避免任何异常数据下出现 101% 之类的进度。
  const clamped = Math.min(100, Math.max(0, pct));
  return `${action} ${formatSize(written)} / ${formatSize(total)} (${clamped}%)`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Attach module-level listeners for SFTP upload/download progress events.
 *  Idempotent: subsequent calls are no-ops. */
export async function attachTransferListeners() {
  if (attached) return;

  initTransferScheduler();

  try {
    progressUnlisten = await listen<ProgressPayload>(
      "sftp-upload-progress",
      (event) => {
        const { uploadId, written, total } = event.payload;
        const state = useTransferStore.getState();
        const item = state.items[uploadId];
        if (!item || (item.status !== "active" && item.status !== "cancelling"))
          return;

        if (item.kind === "upload") {
          state.updateItem(uploadId, {
            written,
            total,
            statusText: progressText("上传", written, total),
          });
        } else if (item.kind === "folder-upload") {
          state.updateItem(uploadId, {
            written,
            total,
            statusText: formatFolderUploadStatus({
              uploadId,
              phase: "uploading",
              written,
              total,
            }),
          });
        }
      },
    );

    doneUnlisten = await listen<DonePayload>("sftp-upload-done", (event) => {
      const { uploadId } = event.payload;
      const state = useTransferStore.getState();
      const item = state.items[uploadId];
      // folder-upload 以命令 resolve 为完成信号（done 事件只代表压缩包上传完毕）
      if (!item || item.kind !== "upload" || item.status !== "active") return;
      state.updateItem(uploadId, {
        status: "done",
        written: item.total,
        statusText: `${item.fileName} 上传完成`,
        finishedAt: Date.now(),
      });
    });

    folderStatusUnlisten = await listen<FolderStatusPayload>(
      "sftp-folder-upload-status",
      (event) => {
        const { uploadId, phase } = event.payload;
        const state = useTransferStore.getState();
        const item = state.items[uploadId];
        if (!item || item.kind !== "folder-upload") return;
        if (item.status !== "active" && item.status !== "cancelling") return;
        state.updateItem(uploadId, {
          phase,
          statusText: formatFolderUploadStatus(event.payload),
        });
      },
    );

    downloadProgressUnlisten = await listen<DownloadProgressPayload>(
      "sftp-download-progress",
      (event) => {
        const { downloadId, written, total } = event.payload;
        const state = useTransferStore.getState();
        const item = state.items[downloadId];
        if (!item || item.kind !== "download") return;
        if (item.status !== "active" && item.status !== "cancelling") return;
        state.updateItem(downloadId, {
          written,
          total,
          statusText: progressText("下载", written, total),
        });
      },
    );

    downloadDoneUnlisten = await listen<DownloadDonePayload>(
      "sftp-download-done",
      (event) => {
        const { downloadId } = event.payload;
        const state = useTransferStore.getState();
        const item = state.items[downloadId];
        if (!item || item.kind !== "download" || item.status !== "active")
          return;
        state.updateItem(downloadId, {
          status: "done",
          written: item.total,
          statusText: `${item.fileName} 下载完成`,
          finishedAt: Date.now(),
        });
      },
    );

    // sysopen 状态：统一驱动「下载」与「监视回传」两张卡片。
    // 不复用标准 progress/done 事件——那些会强制把文案覆盖为「下载完成/上传完成」，丢失 sysopen 语义。
    sysopenStateUnlisten = await listen<SysopenStateEvent>(
      "sftp-sysopen-state",
      (event) => {
        const { downloadId, uploadId, phase } = event.payload;
        const state = useTransferStore.getState();
        const dl = state.items[downloadId];
        const ul = state.items[uploadId];

        switch (phase.kind) {
          case "downloading":
            if (dl && (dl.status === "active" || dl.status === "cancelling")) {
              state.updateItem(downloadId, {
                written: phase.written,
                total: phase.total,
                statusText: progressText("下载", phase.written, phase.total),
              });
            }
            break;
          case "opened":
            // 下载完成 + 系统应用已打开：下载卡片落 done。
            if (dl && dl.status === "active") {
              state.updateItem(downloadId, {
                status: "done",
                written: dl.total,
                statusText: "已用系统应用打开",
                finishedAt: Date.now(),
              });
            }
            // 视觉引导：飞一个上传球到传输中心，告诉用户「现在开始监视，改动会回传到这里」。
            flyToTransferCenter("upload");
            break;
          case "monitoring":
            if (ul && (ul.status === "active" || ul.status === "cancelling")) {
              state.updateItem(uploadId, {
                statusText: "监视中：保存后自动同步",
              });
            }
            break;
          case "syncing":
            if (ul && (ul.status === "active" || ul.status === "cancelling")) {
              state.updateItem(uploadId, {
                written: phase.written,
                total: phase.total,
                statusText: progressText("回传", phase.written, phase.total),
              });
            }
            break;
          case "synced":
            // 一次回传完成，但仍继续监视（保持 active）。
            if (ul && ul.status === "active") {
              state.updateItem(uploadId, {
                written: ul.total,
                statusText: "已同步，继续监视",
              });
            }
            break;
          case "cancelled":
            // 下载阶段取消：下载卡片落 cancelled；监视阶段取消：下载卡片已 done，保持不变。
            if (dl && (dl.status === "active" || dl.status === "cancelling")) {
              state.updateItem(downloadId, {
                status: "cancelled",
                statusText: "已取消",
                finishedAt: Date.now(),
              });
            }
            if (ul && (ul.status === "active" || ul.status === "cancelling")) {
              state.updateItem(uploadId, {
                status: "cancelled",
                statusText: "已取消监视",
                finishedAt: Date.now(),
              });
            }
            break;
          case "failed":
            if (dl && (dl.status === "active" || dl.status === "cancelling")) {
              state.updateItem(downloadId, {
                status: "error",
                statusText: phase.message,
                finishedAt: Date.now(),
              });
            }
            if (ul && (ul.status === "active" || ul.status === "cancelling")) {
              state.updateItem(uploadId, {
                status: "error",
                statusText: phase.message,
                finishedAt: Date.now(),
              });
            }
            break;
        }
      },
    );
    // Agent 传输开始事件：后端 agent 工具发起传输时通知前端建传输中心条目。
    // 条目 source='agent'——只展示/可取消，不进 user 双道调度（后端互斥
    // 保证 agent 传输一次一个）。后续 progress/done 事件按同一 id 更新。
    agentStartUnlisten = await listen<AgentTransferStartPayload>(
      "agent-transfer-start",
      (event) => {
        const p = event.payload;
        const store = useTransferStore.getState();
        // 幂等：同 id 已存在（重放/重复事件）不覆盖。
        if (store.items[p.transferId]) return;
        const isDownload = p.kind === "download";
        store.addItem({
          id: p.transferId,
          kind: isDownload ? "download" : "upload",
          sessionId: p.sessionId,
          fileName: p.fileName,
          localPath: p.localPath,
          remotePath: p.remotePath,
          written: 0,
          total: p.total,
          statusText: isDownload ? `正在下载 ${p.fileName} ...` : `正在上传 ${p.fileName} ...`,
          createdAt: Date.now(),
          source: "agent",
          taskId: p.taskId,
        });
        // 直接置 active：agent 传输后端已开始，不走前端 pump 调度。
        store.updateItem(p.transferId, { status: "active" });
        flyToTransferCenter(isDownload ? "download" : "upload");
      },
    );
    // Agent 传输终态事件：条目置 done/error/cancelled（agent 条目不经前端
    // scheduler，终态由后端显式通知；否则会永久停在 active/cancelling）。
    agentFinishedUnlisten = await listen<{
      transferId: string;
      status: "done" | "error" | "cancelled";
      message?: string | null;
    }>("agent-transfer-finished", (event) => {
      const { transferId, status, message } = event.payload;
      const store = useTransferStore.getState();
      const item = store.items[transferId];
      if (!item || item.source !== "agent") return;
      if (status === "done") {
        store.updateItem(transferId, {
          status: "done",
          written: item.total,
          statusText: `${item.fileName} 传输完成`,
          finishedAt: Date.now(),
        });
      } else if (status === "cancelled") {
        store.updateItem(transferId, {
          status: "cancelled",
          statusText: message ? `已取消：${message}` : "已取消",
          finishedAt: Date.now(),
        });
      } else {
        store.updateItem(transferId, {
          status: "error",
          statusText: message ? `传输失败：${message}` : "传输失败",
          finishedAt: Date.now(),
        });
      }
    });
    attached = true;
  } catch (err) {
    detachTransferListeners();
    throw err;
  }
}

/** Detach all module-level listeners. Call only on app teardown. */
export function detachTransferListeners() {
  progressUnlisten?.();
  doneUnlisten?.();
  folderStatusUnlisten?.();
  downloadProgressUnlisten?.();
  downloadDoneUnlisten?.();
  sysopenStateUnlisten?.();
  agentStartUnlisten?.();
  agentFinishedUnlisten?.();
  progressUnlisten = null;
  doneUnlisten = null;
  folderStatusUnlisten = null;
  downloadProgressUnlisten = null;
  downloadDoneUnlisten = null;
  sysopenStateUnlisten = null;
  agentStartUnlisten = null;
  agentFinishedUnlisten = null;
  attached = false;
}
