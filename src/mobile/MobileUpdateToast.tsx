import { useEffect, useState } from 'react';
import { ArrowUpCircle, DownloadCloud, Loader2, TriangleAlert } from 'lucide-react';
import { openExternalLink } from '@/lib/externalLinks';
import { useUpdateStore, isUpdateVisible } from '@/stores/updateStore';
import MobileSheet from './ui/MobileSheet';

/**
 * 移动端更新浮层（sheet）：与桌面标题栏药丸共用同一份后端状态
 * （`useUpdateStore` ← `update://state`），两端只差安装动作本身。
 *
 * - `ready`：安装包已下载并校验完成 → 「立即安装」拉起系统安装器 /「稍后」；
 * - `available`：仅提示（关了自动更新、该版本没给安装包、或不支持后台下载）
 *   → 「后台下载」或「去下载页」/「稍后」；
 * - `failed`：自动更新失败 → 展示原因 + 「重试下载」/「知道了」（每会话一次）；
 * - `downloading`：不弹浮层（避免打断），由 `MobileUpdateProgress` 顶部细线承接。
 *
 * 「稍后」只隐藏本次提示：Android 的安装必须由用户在系统界面确认，不存在桌面
 * 那种「点了稍后却退出时照样装上」的意外，语义两端一致（都是「暂时不处理」）。
 */
export default function MobileUpdateToast() {
  const state = useUpdateStore((s) => s.state);
  const capabilities = useUpdateStore((s) => s.capabilities);
  const dismissedVersion = useUpdateStore((s) => s.dismissedVersion);
  const failureDismissed = useUpdateStore((s) => s.failureDismissed);
  const installNow = useUpdateStore((s) => s.installNow);
  const download = useUpdateStore((s) => s.download);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const dismissFailure = useUpdateStore((s) => s.dismissFailure);

  const [busy, setBusy] = useState<'install' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = state.status;
  const visible =
    isUpdateVisible(state, dismissedVersion, failureDismissed) &&
    status !== 'downloading';

  useEffect(() => {
    if (!visible) {
      setBusy(null);
      setError(null);
    }
  }, [visible]);

  if (!visible) return null;

  const version = 'version' in state ? state.version : '';
  const canBackgroundDownload = capabilities?.silentDownload === true;
  const isApk = capabilities?.installKind === 'apk';

  const runInstall = async () => {
    setBusy('install');
    setError(null);
    try {
      await installNow();
      // 成功即切到系统安装界面，无需收尾
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const runDownload = async () => {
    setBusy('download');
    setError(null);
    try {
      await download();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const icon =
    status === 'ready' ? (
      <ArrowUpCircle className="h-8 w-8 text-indigo-400" />
    ) : status === 'failed' ? (
      <TriangleAlert className="h-8 w-8 text-amber-400" />
    ) : (
      <DownloadCloud className="h-8 w-8 text-indigo-400" />
    );

  const title =
    status === 'ready'
      ? `新版本 ${version} 已就绪`
      : status === 'failed'
        ? '自动更新失败'
        : `发现新版本 ${version}`;

  const description =
    status === 'ready'
      ? isApk
        ? '安装包已下载并校验完成。点击后在系统安装界面确认，装完自动重启到新版本。'
        : '安装包已下载并校验完成，退出应用时会自动安装。'
      : status === 'failed'
        ? state.message
        : canBackgroundDownload
          ? '可以在后台下载安装包，下载完再决定什么时候安装；也可以直接去下载页。'
          : '前往下载页获取最新版本并安装。安装后可直接覆盖当前版本。';

  return (
    <MobileSheet
      open
      onClose={() => {
        if (busy) return;
        if (status === 'failed') dismissFailure();
        else if (version) dismiss(version);
      }}
      title={title}
      maxHeightClassName="max-h-[70dvh]"
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy != null}
            onClick={() => {
              if (status === 'failed') dismissFailure();
              else if (version) dismiss(version);
            }}
            className="flex-1 rounded-xl bg-zinc-800 px-3 py-3 text-sm font-medium text-zinc-200 active:bg-zinc-700 disabled:opacity-50"
          >
            稍后
          </button>

          {status === 'ready' && (
            <button
              type="button"
              disabled={busy != null}
              onClick={() => void runInstall()}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-3 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-50"
            >
              {busy === 'install' && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
              立即安装
            </button>
          )}

          {status === 'available' && canBackgroundDownload && (
            <button
              type="button"
              disabled={busy != null}
              onClick={() => void runDownload()}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-3 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-50"
            >
              {busy === 'download' && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
              后台下载
            </button>
          )}

          {status === 'available' && !canBackgroundDownload && (
            <button
              type="button"
              onClick={() => openExternalLink(state.releaseUrl)}
              className="flex-1 rounded-xl bg-indigo-600 px-3 py-3 text-sm font-medium text-white active:bg-indigo-500"
            >
              去下载
            </button>
          )}

          {status === 'failed' && canBackgroundDownload && (
            <button
              type="button"
              disabled={busy != null}
              onClick={() => void runDownload()}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-3 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-50"
            >
              {busy === 'download' && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
              重试下载
            </button>
          )}
        </div>
      }
    >
      <div className="flex flex-col items-center gap-3 px-5 py-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-500/15">
          {icon}
        </div>
        <div>
          <p className="text-base font-semibold text-zinc-100">{title}</p>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">{description}</p>
          {error && (
            <p className="mt-3 break-words text-sm leading-relaxed text-red-400">
              {error}
            </p>
          )}
        </div>
      </div>
    </MobileSheet>
  );
}
