import { useCallback, useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { DownloadCloud, ExternalLink, Loader2, MessageCircle, RotateCcw } from 'lucide-react';
import { checkUpdate } from '@/lib/tauri';
import type { UpdateCheckResult } from '@/lib/types';
import { getErrorMessage } from '@/lib/errors';
import { openExternalLink, SUPPORT_URL } from '@/lib/externalLinks';
import { updatePercent } from '@/lib/updateProgress';
import { APP_LOGO, APP_NAME } from '@/lib/constants';
import {
  availableUpdateModes,
  displayUpdateMode,
  UPDATE_MODE_HINTS,
  UPDATE_MODE_LABELS,
  updateModeDescription,
} from '@/lib/updateMode';
import { MobileChoiceGroup } from '@/mobile/ui/MobileChoiceGroup';
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
  const updateMode = useSettingsStore((s) => s.settings?.updateMode ?? 'auto');
  // 本机能力：Android 支持「后台下载 + 一键安装」，其他平台只提示；
  // 不支持时「自动更新」这一档不给（避免出现点了必然失败的入口）
  const capabilities = useUpdateStore((s) => s.capabilities);
  const supportsSilentDownload = capabilities?.silentDownload === true;
  const isApk = capabilities?.installKind === 'apk';
  // 展示用的模式：平台不支持后台下载时，已存的 auto 按等价的 notify 显示
  const shownMode = displayUpdateMode(updateMode, supportsSilentDownload);
  const modeOptions = availableUpdateModes(supportsSilentDownload).map((m) => ({
    value: m,
    label: UPDATE_MODE_LABELS[m],
    desc: UPDATE_MODE_HINTS[m],
  }));
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
                    : updateMode === 'off'
                      ? '安装包已下载完成。当前更新方式是「关闭」，不会自动安装 —— 点「立即安装」才会装上。'
                      : '安装包已下载完成；不点也会在你退出应用时自动安装。'}
                </p>
              </>
            ) : supportsSilentDownload && updateMode !== 'off' && result.installerUrl ? (
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
                  下载完成后会提示你安装；也可以在下面把更新方式设为「自动更新」。
                </p>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => openExternalLink(result.releaseUrl)}
                  className="w-full rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-medium text-white active:bg-indigo-500"
                >
                  去下载
                </button>
                {updateMode === 'off' && (
                  <p className="text-center text-[11px] leading-relaxed text-zinc-500">
                    当前更新方式是「关闭」，本机不下载也不缓存安装包；想在这里直接后台下载，把下面的更新方式改成「自动更新」或「仅提醒」。
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </MobileSettingRow>

      {/* 更新方式三态（自动更新 / 仅提醒 / 关闭）：两端同一语义，移动端用竖排选项 */}
      <MobileSettingRow
        label="更新方式"
        description={updateModeDescription(shownMode, isApk)}
      >
        <MobileChoiceGroup
          ariaLabel="更新方式"
          options={modeOptions}
          value={shownMode}
          columns={1}
          onChange={(mode) => {
            setError(null);
            update({ updateMode: mode }).catch((e) => setError(getErrorMessage(e)));
          }}
        />
      </MobileSettingRow>

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
