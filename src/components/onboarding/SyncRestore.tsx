/**
 * 引导前置「同步账户恢复」流程（桌面 / 移动共用）。
 *
 * 状态机：form → syncing → done
 * - form：服务器 + 配置码 + 账户密码，样式与 MobileSyncPairPage / SyncSettingsSection 保持一致
 * - syncing：pairJoin 成功后等待首轮 pull（waitForInitialSyncPull）
 * - done：idle 自动进入主界面；timeout/error 提示后台继续，手动进入
 *
 * 设计决策：
 * - 只提供「加入已有账户」。创建新账户留在设置页，引导里不出现"手抄配置码"这种重操作。
 * - 提交加入即视为同意同步声明（写入 hasAcceptedSyncDisclaimer），避免之后进设置页再弹一次。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Info, RefreshCw, TriangleAlert } from 'lucide-react';
import { useSyncStore } from '@/stores/syncStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { waitForInitialSyncPull, type InitialSyncWaitResult } from '@/lib/waitForInitialSync';
import { OFFICIAL_SYNC_SERVER_URL } from '@/lib/constants';
import { SYNC_DISCLAIMER_BODY, SYNC_DISCLAIMER_TITLE } from '@/lib/syncDisclaimer';

type RestorePhase = 'form' | 'syncing' | 'done';

interface SyncRestoreFlowProps {
  /** 流程收尾：idle 自动触发（1.8s 停顿），或用户点"进入应用" */
  onDone: () => void;
}

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500';

const primaryBtnClass =
  'w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-500 active:bg-indigo-500 disabled:opacity-50';

export function SyncRestoreFlow({ onDone }: SyncRestoreFlowProps) {
  const pairJoin = useSyncStore((s) => s.pairJoin);
  const actionLoading = useSyncStore((s) => s.actionLoading);
  const storeError = useSyncStore((s) => s.error);
  const clearError = useSyncStore((s) => s.clearError);
  const progress = useSyncStore((s) => s.summary?.progress ?? null);
  const updateSettings = useSettingsStore((s) => s.update);

  const [serverSource, setServerSource] = useState<'official' | 'custom'>('official');
  const [customServerUrl, setCustomServerUrl] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [disclaimerOpen, setDisclaimerOpen] = useState(false);
  const [phase, setPhase] = useState<RestorePhase>('form');
  const [result, setResult] = useState<InitialSyncWaitResult | null>(null);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolvedServerUrl =
    serverSource === 'official' ? OFFICIAL_SYNC_SERVER_URL : customServerUrl.trim();
  const canSubmit = !actionLoading && !!resolvedServerUrl && !!joinCode.trim();

  // 首轮同步干净结束（idle）后稍作停留，自动进入主界面
  useEffect(() => {
    if (phase !== 'done' || result !== 'idle') return;
    doneTimerRef.current = setTimeout(onDone, 1800);
    return () => {
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    };
  }, [phase, result, onDone]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    clearError();
    try {
      await pairJoin(resolvedServerUrl, joinCode.trim(), accountPassword);
    } catch {
      return; // 错误已在 syncStore.error 展示
    }
    setPhase('syncing');
    // 加入动作即视为同意同步声明；失败非致命（设置页会再弹一次）
    try {
      await updateSettings({ hasAcceptedSyncDisclaimer: true });
    } catch {
      /* ignore */
    }
    const r = await waitForInitialSyncPull();
    setResult(r);
    setPhase('done');
  }, [canSubmit, clearError, pairJoin, resolvedServerUrl, joinCode, accountPassword, updateSettings]);

  // ── syncing ──────────────────────────────────────────────
  if (phase === 'syncing') {
    const pr = progress && progress.total > 0 ? progress : null;
    const pct = pr ? Math.min(100, Math.round((pr.done / pr.total) * 100)) : null;
    return (
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <RefreshCw className="mb-4 h-6 w-6 animate-spin text-zinc-400" />
        <div className="text-sm font-medium text-zinc-200">正在恢复配置</div>
        {pr && pct !== null ? (
          <>
            <div className="mt-3 h-1.5 w-52 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-indigo-500 transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
              正在拉取 {pr.done}/{pr.total} 项 · {pct}%
            </p>
          </>
        ) : (
          <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
            首次同步可能需要 1 分钟，请不要关闭应用
          </p>
        )}
      </div>
    );
  }

  // ── done ─────────────────────────────────────────────────
  if (phase === 'done') {
    const clean = result === 'idle';
    return (
      <div className="flex flex-col items-center px-6 py-12 text-center">
        {clean ? (
          <Check className="mb-4 h-8 w-8 text-emerald-400" />
        ) : (
          <TriangleAlert className="mb-4 h-8 w-8 text-amber-400" />
        )}
        <div className="text-sm font-medium text-zinc-200">
          {clean ? '恢复完成' : '已加入账户'}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
          {clean
            ? '配置与数据已同步到本机，正在进入…'
            : '首次同步将在后台继续，可稍后在「设置 → 跨设备同步」查看进度'}
        </p>
        <button type="button" onClick={onDone} className={`${primaryBtnClass} mt-6 max-w-xs`}>
          进入应用
        </button>
      </div>
    );
  }

  // ── form ─────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      {storeError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-300">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span className="min-w-0 flex-1 break-words">{storeError}</span>
          <button type="button" onClick={clearError} className="flex-shrink-0 text-red-400">
            ✕
          </button>
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-xs text-zinc-400">同步服务器</label>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['official', 'Marcel 官方服务器'],
              ['custom', '自定义服务器地址'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setServerSource(value)}
              className={`rounded-lg border py-2.5 text-sm ${
                serverSource === value
                  ? 'border-indigo-500 bg-indigo-600/20 text-indigo-200'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {serverSource === 'custom' && (
        <div>
          <label className="mb-1.5 block text-xs text-zinc-400">自定义服务器地址</label>
          <input
            value={customServerUrl}
            onChange={(e) => setCustomServerUrl(e.target.value)}
            placeholder="https://sync.example.com"
            className={inputClass}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
          />
        </div>
      )}

      <div>
        <label className="mb-1.5 block text-xs text-zinc-400">配置码</label>
        <input
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
          placeholder="32 位配置码"
          className={`${inputClass} font-mono`}
          maxLength={32}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      <div>
        <label className="mb-1.5 block text-xs text-zinc-400">账户密码</label>
        <input
          type="password"
          value={accountPassword}
          onChange={(e) => setAccountPassword(e.target.value)}
          placeholder="新账户必填；旧账户可留空"
          className={inputClass}
          autoComplete="current-password"
        />
      </div>

      {/* 免责声明：摘要 + 内联展开全文；提交即视为同意 */}
      <div className="flex items-start gap-2 text-xs leading-relaxed text-zinc-500">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <span>
          端到端加密，服务端不存储密码。加入即表示已阅读并同意
          <button
            type="button"
            onClick={() => setDisclaimerOpen((v) => !v)}
            className="text-indigo-400 underline decoration-indigo-400/40 underline-offset-2"
          >
            《{SYNC_DISCLAIMER_TITLE}声明》
          </button>
        </span>
      </div>
      {disclaimerOpen && (
        <div className="max-h-44 overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs leading-relaxed text-zinc-500">
          {SYNC_DISCLAIMER_BODY}
        </div>
      )}

      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        className={primaryBtnClass}
      >
        {actionLoading ? (
          <span className="inline-flex items-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin" />
            处理中…
          </span>
        ) : (
          '加入账户'
        )}
      </button>
    </div>
  );
}
