import { useCallback, useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { DownloadCloud, ExternalLink, Loader2, MessageCircle, RotateCcw } from 'lucide-react';
import { checkUpdate } from '@/lib/tauri';
import type { UpdateCheckResult } from '@/lib/types';
import { getErrorMessage } from '@/lib/errors';
import { openExternalLink, SUPPORT_URL } from '@/lib/externalLinks';
import { updatePercent } from '@/lib/updateProgress';
import { APP_LOGO, APP_NAME } from '@/lib/constants';
import Toggle from '@/components/ui/Toggle';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUpdateStore } from '@/stores/updateStore';
import { MobileSettingRow } from './MobileSettingRow';

const REPO_URL = 'https://github.com/q541810/Marcel_ssh';

/** About page for mobile: version, manual update check, re-run onboarding, project link. */
export function MobileAboutSection() {
  const [appVersion, setAppVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = useSettingsStore((s) => s.update);
  const autoUpdate = useSettingsStore((s) => s.settings?.autoUpdate ?? true);
  // 本机能力：Android 支持「后台下载 + 一键安装」，其他平台只提示；
  // 不支持时连开关都不展示（避免出现点了必然失败的入口）
  const capabilities = useUpdateStore((s) => s.capabilities);
  const downloadInBackground = useUpdateStore((s) => s.download);
  const installNowUpdate = useUpdateStore((s) => s.installNow);
  // 后端实时状态：下载中/已就绪时换成对应的动作（后端对这两种情况是幂等 no-op，
  // 再点「后台下载」会「什么都没发生」）
  const updateState = useUpdateStore((s) => s.state);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion('—'));
  }, []);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      setResult(await checkUpdate());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setChecking(false);
    }
  }, []);

  const handleResetOnboarding = useCallback(async () => {
    try {
      await update({ hasCompletedOnboarding: false });
      // Same as desktop: reload so the shell re-evaluates the flag cleanly.
      window.location.reload();
    } catch (err) {
      console.error('Failed to reset onboarding:', err);
    }
  }, [update]);

  const handleBackgroundDownload = useCallback(async () => {
    setDownloading(true);
    setError(null);
    try {
      await downloadInBackground();
      setResult(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDownloading(false);
    }
  }, [downloadInBackground]);

  const handleInstallNow = useCallback(async () => {
    setInstalling(true);
    setError(null);
    try {
      await installNowUpdate();
      // 成功即拉起系统安装器（桌面则退出安装），不需要收尾
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setInstalling(false);
    }
  }, [installNowUpdate]);

  return (
    <div className="flex flex-col gap-2">
      {/* App identity */}
      <div className="flex flex-col items-center py-4">
        <img
          src={APP_LOGO}
          alt={`${APP_NAME} logo`}
          className="h-24 w-24 select-none object-contain"
          draggable={false}
        />
        <div className="mt-2 text-base font-semibold text-zinc-100">
          {APP_NAME}
        </div>
        <div className="mt-0.5 font-mono text-xs text-zinc-500">
          {appVersion ? `v${appVersion}` : ''}
        </div>
      </div>

      {/* Update check */}
      <MobileSettingRow label="检查更新" description="查看是否有新版本可用">
        <button
          type="button"
          onClick={() => void handleCheck()}
          disabled={checking}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 active:bg-zinc-700 disabled:opacity-50"
        >
          {checking && <Loader2 className="h-4 w-4 animate-spin" />}
          {checking ? '检查中…' : '检查更新'}
        </button>
        {result && !result.hasUpdate && (
          <p className="mt-2 text-center text-sm text-emerald-400">
            已是最新版本
          </p>
        )}
        {error && (
          <p className="mt-2 break-words text-center text-sm text-red-400">
            {error}
          </p>
        )}
        {result?.hasUpdate && (
          <div className="mt-2 space-y-2 rounded-xl border border-indigo-800/60 bg-indigo-950/30 p-3">
            <p className="text-sm text-zinc-200">
              新版本{' '}
              <span className="font-medium text-indigo-300">
                {result.latestVersion}
              </span>{' '}
              可用
            </p>
            {updateState.status === 'downloading' ? (
              /* 已在下载：后端对重复触发是幂等 no-op，这里不给按钮，改为展示进度 */
              <p className="rounded-lg bg-indigo-500/10 px-3 py-2.5 text-center text-sm text-indigo-300">
                正在后台下载 {updateState.version} ·{' '}
                {updatePercent(updateState.downloaded, updateState.total)}%
                <span className="mt-0.5 block text-[11px] text-zinc-500">
                  下载在后台继续，离开这一页也不受影响。
                </span>
              </p>
            ) : updateState.status === 'ready' ? (
              <>
                <button
                  type="button"
                  disabled={installing}
                  onClick={() => void handleInstallNow()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-50"
                >
                  {installing ? (
                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <DownloadCloud className="h-4 w-4" />
                  )}
                  立即安装
                </button>
                <p className="text-center text-[11px] leading-relaxed text-zinc-500">
                  {capabilities?.installKind === 'apk'
                    ? '安装包已下载完成，点击后在系统安装界面确认即可。'
                    : '安装包已下载完成；不点也会在你退出应用时自动安装。'}
                </p>
              </>
            ) : capabilities?.silentDownload && result.installerUrl ? (
              <>
                <button
                  type="button"
                  disabled={downloading}
                  onClick={() => void handleBackgroundDownload()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-50"
                >
                  {downloading ? (
                    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <DownloadCloud className="h-4 w-4" />
                  )}
                  后台下载
                </button>
                <p className="text-center text-[11px] leading-relaxed text-zinc-500">
                  下载完成后会提示你安装；也可以在下方打开自动下载。
                </p>
              </>
            ) : (
              <button
                type="button"
                onClick={() => openExternalLink(result.releaseUrl)}
                className="w-full rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white active:bg-indigo-500"
              >
                去下载
              </button>
            )}
          </div>
        )}
      </MobileSettingRow>

      {/* 自动更新（仅平台支持后台安装时展示） */}
      {capabilities?.silentDownload && (
        <MobileSettingRow
          label="自动下载并安装更新"
          description="发现新版本后在非计量网络下自动后台下载，下载完成提示你安装；关闭后仅提示，需手动下载"
          trailing={
            <Toggle
              checked={autoUpdate}
              onChange={(checked) => {
                setError(null);
                update({ autoUpdate: checked }).catch((e) =>
                  setError(getErrorMessage(e)),
                );
              }}
            />
          }
        />
      )}

      {/* Re-run onboarding */}
      <MobileSettingRow label="重新引导" description="重新运行初次使用引导流程">
        <button
          type="button"
          onClick={() => void handleResetOnboarding()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 active:bg-zinc-700"
        >
          <RotateCcw className="h-4 w-4" />
          重新运行引导
        </button>
      </MobileSettingRow>

      {/* Support / feedback */}
      <MobileSettingRow label="技术支持 / Bug 反馈" description="遇到问题或想反馈建议？加入官方交流群">
        <button
          type="button"
          onClick={() => openExternalLink(SUPPORT_URL)}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 active:bg-zinc-700"
        >
          <MessageCircle className="h-4 w-4" />加入交流群
        </button>
      </MobileSettingRow>

      {/* Project link */}
      <MobileSettingRow label="项目主页" description="GitHub 仓库与问题反馈">
        <button
          type="button"
          onClick={() => openExternalLink(REPO_URL)}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 active:bg-zinc-700"
        >
          <ExternalLink className="h-4 w-4" />在 GitHub 上查看
        </button>
      </MobileSettingRow>
    </div>
  );
}
