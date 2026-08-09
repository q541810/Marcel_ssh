/**
 * 等待 pairJoin 后的首轮同步（scheduler.start → pull）落定。
 *
 * 成功判定：
 * - 见过 pulling/pushing 后回到 idle
 * - 或短宽限内一直 idle（极快完成 / 空账户）且已 configured
 *
 * 失败：state=error；超时：timeout（默认 60s，与 UI 文案对齐）。
 */

import { useSyncStore } from '@/stores/syncStore';
import type { SyncState } from '@/lib/types';

export type InitialSyncWaitResult = 'idle' | 'timeout' | 'error';

const DEFAULT_TIMEOUT_MS = 180_000;
/** pairJoin 返回后 start() 异步拉起；极快 pull 可能错过 busy 事件 */
const IDLE_GRACE_MS = 2_500;

function currentState(): SyncState {
  return useSyncStore.getState().summary?.state ?? 'notConfigured';
}

function isConfigured(): boolean {
  return useSyncStore.getState().summary?.configured === true;
}

export function waitForInitialSyncPull(options?: {
  timeoutMs?: number;
}): Promise<InitialSyncWaitResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let sawBusy = false;

    const finish = (result: InitialSyncWaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      unsub();
      resolve(result);
    };

    const evaluate = (state: SyncState) => {
      if (settled) return;
      if (state === 'pulling' || state === 'pushing') {
        sawBusy = true;
        return;
      }
      if (state === 'error') {
        finish('error');
        return;
      }
      if (state === 'idle' && sawBusy) {
        finish('idle');
      }
    };

    const unsub = useSyncStore.subscribe((s) => {
      evaluate(s.summary?.state ?? 'notConfigured');
    });

    // 立即读一次（可能已在 pulling）
    evaluate(currentState());

    // 宽限：若一直 idle 且已配置，视为首轮已完成（或无需同步）
    const graceTimer = setTimeout(() => {
      if (settled || sawBusy) return;
      if (currentState() === 'idle' && isConfigured()) {
        finish('idle');
      }
    }, IDLE_GRACE_MS);

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      // 超时瞬间若已 idle，仍按成功（宽限竞态）
      if (currentState() === 'idle' && isConfigured()) {
        finish('idle');
        return;
      }
      finish('timeout');
    }, timeoutMs);
  });
}
