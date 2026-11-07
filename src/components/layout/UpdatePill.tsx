import { useEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useUpdateStore, isUpdateVisible } from '@/stores/updateStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useIsBusy } from '@/hooks/useBusyWork';
import { openExternalLink } from '@/lib/externalLinks';
import { getErrorMessage } from '@/lib/errors';
import { updatePercent } from '@/lib/updateProgress';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';

/**
 * 标题栏更新药丸（双端同源的更新状态在桌面端的唯一入口）：
 *
 * - 下载中：版本 + 百分比，不打断任何操作（手机端没有标题栏，下载进度走系统通知栏）；
 * - 就绪：点击展开气泡，「立即安装」/「稍后」。**「稍后」只隐藏本次提示，
 *   不取消安装** —— Windows 退出应用时仍会静默装上（文案里写明这一点，
 *   避免用户以为点「稍后」就等于不更新）；
 * - 仅提示（未开自动下载 / 该版本没给更新包 / 平台不支持后台下载）：
 *   气泡里给「后台下载」（平台支持时）与「去浏览器下载」两条路；
 * - 失败：气泡里给失败原因 + 重试，而不是一个点掉就消失的无信息提示。
 */
export default function UpdatePill() {
  const state = useUpdateStore((s) => s.state);
  const capabilities = useUpdateStore((s) => s.capabilities);
  // 更新方式：决定药丸是否出现（「关闭」模式下不展示任何更新提示）。
  const updateMode = useSettingsStore((s) => s.settings?.updateMode ?? 'auto');
  const dismissedVersion = useUpdateStore((s) => s.dismissedVersion);
  const failureDismissed = useUpdateStore((s) => s.failureDismissed);
  const installNow = useUpdateStore((s) => s.installNow);
  const download = useUpdateStore((s) => s.download);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const dismissFailure = useUpdateStore((s) => s.dismissFailure);

  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 药丸 + 气泡的整体容器：outside click 关闭气泡时排除自身
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 有任务在跑（Agent 任务 / 后台作业 / 传输）或有活跃 SSH 会话 → 安装（会退出
  // 应用 / 重启）前必须确认。「任务在跑」的口径与关闭窗口时的退出确认同源
  // （`useIsBusy`，只订阅一个布尔 —— 标题栏常驻，不能跟着任务/传输每个 tick 重渲）：
  // 之前这里只看当前激活的那一个任务，后台任务和作业都漏了。
  const agentBusy = useIsBusy();
  const sshBusy = useSessionStore((s) =>
    Object.values(s.sessions).some(
      (x) => x.status === 'connecting' || x.status === 'connected',
    ),
  );

  const active = isUpdateVisible(state, dismissedVersion, failureDismissed, updateMode);
  const status = state.status;

  useEffect(() => {
    if (!active) setOpen(false);
    setError(null);
    setBusy(false);
  }, [active, status]);

  // 气泡打开时点击外部关闭（capture 阶段，避免被标题栏拖拽逻辑吞掉）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [open]);

  const version = 'version' in state ? state.version : '';
  const percent =
    state.status === 'downloading'
      ? updatePercent(state.downloaded, state.total)
      : 0;
  const canBackgroundDownload = capabilities?.silentDownload === true;
  const installLabel =
    capabilities?.installKind === 'apk' ? '立即安装' : '立即重启更新';

  const pillText = useMemo(() => {
    switch (state.status) {
      case 'downloading':
        return `正在后台下载 ${version}${state.total > 0 ? ` ${percent}%` : ''}`;
      case 'ready':
        return `新版本 ${version} 已就绪，点击选择安装`;
      case 'available':
        return `新版本 ${version} 可用，点击查看选项`;
      case 'failed':
        return `自动更新失败：${state.message}`;
      default:
        return '';
    }
  }, [state, version, percent]);

  if (!active) return null;

  const runInstall = async () => {
    setBusy(true);
    setError(null);
    try {
      await installNow();
      // Windows 会退出应用、Android 会切到系统安装界面，成功不需要收尾
    } catch (e) {
      setError(getErrorMessage(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    setConfirmOpen(false);
  };

  const onInstallClick = () => {
    if (agentBusy || sshBusy) {
      setConfirmOpen(true);
      return;
    }
    void runInstall();
  };

  const runDownload = async () => {
    setBusy(true);
    setError(null);
    try {
      await download();
      setOpen(false);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const base =
    'mx-1 h-[18px] rounded-full px-1.5 text-caption leading-[18px] font-medium select-none transition-colors duration-120 whitespace-nowrap';

  return (
    <>
      <div className="relative" ref={rootRef}>
        {state.status === 'downloading' ? (
          <span
            className={`${base} border border-edge-subtle bg-surface-raised text-fg-secondary cursor-default`}
            title={pillText}
          >
            <span className="inline-block motion-reduce:animate-none animate-pulse">
              ↓
            </span>{' '}
            {version}
            {state.total > 0 && (
              <span className="text-fg-tertiary"> {percent}%</span>
            )}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={`${base} cursor-pointer focus-ring ${
              state.status === 'ready'
                ? 'border border-indigo-500/30 bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25'
                : state.status === 'failed'
                  ? 'border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                  : 'border border-edge-subtle bg-fill text-fg-secondary hover:bg-fill-strong'
            }`}
            title={pillText}
          >
            {state.status === 'ready'
              ? `✓ ${version}`
              : state.status === 'failed'
                ? '更新失败'
                : `↑ 新版本 ${version}`}
          </button>
        )}

        {open && state.status !== 'downloading' && (
          <div className="absolute top-7 left-0 z-50 w-72 rounded-xl surface-glass p-3">
            {state.status === 'ready' && (
              <>
                <p className="mb-1 text-meta text-fg">
                  新版本{' '}
                  <span className="font-medium text-indigo-300">{version}</span>{' '}
                  已下载完成。
                </p>
                <p className="mb-3 text-caption leading-relaxed text-fg-tertiary">
                  {capabilities?.installKind === 'apk'
                    ? '点击后在系统安装界面确认安装，装完自动重启到新版本。'
                    : '点「稍后」只是不再提示；你退出应用时它仍会自动安装。'}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    className="!px-3 !text-meta"
                    loading={busy}
                    onClick={onInstallClick}
                  >
                    {installLabel}
                  </Button>
                  <Button
                    variant="secondary"
                    className="!px-3 !text-meta"
                    onClick={() => {
                      dismiss(version);
                      setOpen(false);
                    }}
                  >
                    稍后
                  </Button>
                </div>
              </>
            )}

            {state.status === 'available' && (
              <>
                <p className="mb-1 text-meta text-fg">
                  新版本{' '}
                  <span className="font-medium text-indigo-300">{version}</span>{' '}
                  可用。
                </p>
                <p className="mb-3 text-caption leading-relaxed text-fg-tertiary">
                  {canBackgroundDownload
                    ? '可在后台下载，下载完再决定什么时候装；也可以直接去浏览器下载。'
                    : '当前平台不支持后台自动更新，请前往下载页手动安装。'}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {canBackgroundDownload && (
                    <Button
                      variant="primary"
                      className="!px-3 !text-meta"
                      loading={busy}
                      onClick={() => void runDownload()}
                    >
                      后台下载
                    </Button>
                  )}
                  <Button
                    variant={canBackgroundDownload ? 'secondary' : 'primary'}
                    className="!px-3 !text-meta"
                    onClick={() => openExternalLink(state.releaseUrl)}
                  >
                    去下载页
                  </Button>
                  <Button
                    variant="secondary"
                    className="!px-3 !text-meta"
                    onClick={() => {
                      dismiss(version);
                      setOpen(false);
                    }}
                  >
                    稍后
                  </Button>
                </div>
              </>
            )}

            {state.status === 'failed' && (
              <>
                <p className="mb-1 text-meta text-amber-300">自动更新失败</p>
                <p className="mb-3 text-caption leading-relaxed text-fg-secondary">
                  {state.message}
                </p>
                <div className="flex items-center gap-2">
                  {canBackgroundDownload && (
                    <Button
                      variant="primary"
                      className="!px-3 !text-meta"
                      loading={busy}
                      onClick={() => void runDownload()}
                    >
                      重试下载
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    className="!px-3 !text-meta"
                    onClick={dismissFailure}
                  >
                    知道了
                  </Button>
                </div>
              </>
            )}

            {error && (
              <p className="mt-2 text-caption leading-relaxed text-red-400">
                {error}
              </p>
            )}
          </div>
        )}
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => !busy && setConfirmOpen(false)}
        title="现在安装更新？"
        size="sm"
      >
        <div className="space-y-4 p-4">
          <div className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" aria-hidden="true" />
            <p className="text-body leading-relaxed text-amber-100/90">
              当前有正在运行的任务（Agent 任务、后台作业、文件传输）或 SSH 会话，安装会中断它们。
            </p>
          </div>
          <p className="text-body leading-relaxed text-fg-secondary">
            {capabilities?.installKind === 'apk'
              ? '接下来会打开系统安装界面，确认后应用会重启到新版本。'
              : '应用将退出并静默安装新版本，完成后自动重新打开。'}
          </p>
          {error && <p className="text-body text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="secondary"
              onClick={() => setConfirmOpen(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button variant="primary" onClick={() => void runInstall()} loading={busy}>
              确认安装
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
