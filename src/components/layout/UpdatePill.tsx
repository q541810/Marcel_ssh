import { useEffect, useMemo, useRef, useState } from 'react';
import { useUpdateStore, isUpdateVisible } from '@/stores/updateStore';
import { useAgentStore } from '@/stores/agentStore';
import { useSessionStore } from '@/stores/sessionStore';
import { openExternalLink } from '@/lib/externalLinks';
import { formatMb, updatePercent } from '@/lib/updateProgress';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';

const mb = formatMb;

/**
 * 标题栏更新药丸（双端同源的更新状态在桌面端的唯一入口）：
 *
 * - 下载中：版本 + 百分比，不打断任何操作（手机端另有顶部细进度条）；
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

  // Agent 任务运行中 / 有活跃 SSH 会话 → 安装（会退出应用 / 重启）前必须确认
  const agentBusy = useAgentStore((s) => {
    const t = s.activeTaskId ? s.tasks[s.activeTaskId] : null;
    return (
      t?.status === 'planning' ||
      t?.status === 'executing' ||
      t?.status === 'waiting_approval'
    );
  });
  const sshBusy = useSessionStore((s) =>
    Object.values(s.sessions).some(
      (x) => x.status === 'connecting' || x.status === 'connected',
    ),
  );

  const active = isUpdateVisible(state, dismissedVersion, failureDismissed);
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
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const base =
    'mx-1 h-[18px] rounded-full px-1.5 text-[10px] leading-[18px] font-medium select-none transition-colors whitespace-nowrap';

  return (
    <>
      <div className="relative" ref={rootRef}>
        {state.status === 'downloading' ? (
          <span
            className={`${base} border border-zinc-700/60 bg-zinc-800/80 text-zinc-300 cursor-default`}
            title={pillText}
          >
            <span className="inline-block motion-reduce:animate-none animate-pulse">
              ↓
            </span>{' '}
            {version}
            {state.total > 0 && (
              <span className="text-zinc-500"> {percent}%</span>
            )}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={`${base} cursor-pointer ${
              state.status === 'ready'
                ? 'border border-indigo-500/30 bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25'
                : state.status === 'failed'
                  ? 'border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                  : 'border border-zinc-700/60 bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700/80'
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
          <div className="absolute top-7 left-0 z-50 w-72 rounded-xl border border-zinc-700 bg-zinc-900/95 p-3 shadow-xl backdrop-blur">
            {state.status === 'ready' && (
              <>
                <p className="mb-1 text-xs text-zinc-200">
                  新版本{' '}
                  <span className="font-medium text-indigo-300">{version}</span>{' '}
                  已下载完成。
                </p>
                <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
                  {capabilities?.installKind === 'apk'
                    ? '点击后在系统安装界面确认安装，装完自动重启到新版本。'
                    : '点「稍后」只是不再提示；你退出应用时它仍会自动安装。'}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    className="!px-3 !py-1.5 !text-xs"
                    loading={busy}
                    onClick={onInstallClick}
                  >
                    {installLabel}
                  </Button>
                  <Button
                    variant="secondary"
                    className="!px-3 !py-1.5 !text-xs"
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
                <p className="mb-1 text-xs text-zinc-200">
                  新版本{' '}
                  <span className="font-medium text-indigo-300">{version}</span>{' '}
                  可用。
                </p>
                <p className="mb-3 text-[11px] leading-relaxed text-zinc-500">
                  {canBackgroundDownload
                    ? '可在后台下载，下载完再决定什么时候装；也可以直接去浏览器下载。'
                    : '当前平台不支持后台自动更新，请前往下载页手动安装。'}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {canBackgroundDownload && (
                    <Button
                      variant="primary"
                      className="!px-3 !py-1.5 !text-xs"
                      loading={busy}
                      onClick={() => void runDownload()}
                    >
                      后台下载
                    </Button>
                  )}
                  <Button
                    variant={canBackgroundDownload ? 'secondary' : 'primary'}
                    className="!px-3 !py-1.5 !text-xs"
                    onClick={() => openExternalLink(state.releaseUrl)}
                  >
                    去下载页
                  </Button>
                  <Button
                    variant="secondary"
                    className="!px-3 !py-1.5 !text-xs"
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
                <p className="mb-1 text-xs text-amber-300">自动更新失败</p>
                <p className="mb-3 text-[11px] leading-relaxed text-zinc-400">
                  {state.message}
                </p>
                <div className="flex items-center gap-2">
                  {canBackgroundDownload && (
                    <Button
                      variant="primary"
                      className="!px-3 !py-1.5 !text-xs"
                      loading={busy}
                      onClick={() => void runDownload()}
                    >
                      重试下载
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    className="!px-3 !py-1.5 !text-xs"
                    onClick={dismissFailure}
                  >
                    知道了
                  </Button>
                </div>
              </>
            )}

            {error && (
              <p className="mt-2 text-[11px] leading-relaxed text-red-400">
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
      >
        <div className="space-y-4">
          <p className="text-sm text-zinc-300">
            当前有正在运行的 Agent 任务或 SSH 会话，安装会中断它们。
            <br />
            {capabilities?.installKind === 'apk'
              ? '接下来会打开系统安装界面，确认后应用会重启到新版本。'
              : '应用将退出并静默安装新版本，完成后自动重新打开。'}
          </p>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
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
