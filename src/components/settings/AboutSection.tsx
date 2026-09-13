import { useState, useEffect, useCallback } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { checkUpdate } from '@/lib/tauri';
import type { UpdateCheckResult } from '@/lib/types';
import { getErrorMessage } from '@/lib/errors';
import { openExternalLink, SUPPORT_URL } from '@/lib/externalLinks';
import { updatePercent } from '@/lib/updateProgress';
import { APP_NAME, APP_LOGO } from '@/lib/constants';
import Button from '@/components/ui/Button';
import Toggle from '@/components/ui/Toggle';
import { Card, SettingItem } from './helpers';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUpdateStore } from '@/stores/updateStore';
import ChatHistoryModal from './ChatHistoryModal';
import { useConnectionStore } from '@/stores/connectionStore';

export default function AboutSection() {
  const [appVersion, setAppVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const update = useSettingsStore((s) => s.update);
  const autoUpdate = useSettingsStore((s) => s.settings?.autoUpdate ?? true);
  // 本机平台能力：决定是否展示「自动下载并安装更新」开关与后台下载入口
  // （macOS/Linux 没有可静默安装的包，展示出来只会让用户点了必然失败）
  const capabilities = useUpdateStore((s) => s.capabilities);
  const downloadInBackground = useUpdateStore((s) => s.download);
  const installNowUpdate = useUpdateStore((s) => s.installNow);
  // 后端实时更新状态：决定「检查更新」结果区该给哪个动作。
  // 下载中/已就绪时不能再给「后台下载」—— 后端对这两种情况是幂等 no-op，
  // 点了会「什么都没发生」；已就绪时用户真正要做的是安装。
  const updateState = useUpdateStore((s) => s.state);
  const [installing, setInstalling] = useState(false);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion('0.1.3'));
    fetchConnections();
  }, [fetchConnections]);

  useEffect(() => {
    import('./ChatHistoryModal');
  }, []);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      const res = await checkUpdate();
      setResult(res);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setChecking(false);
    }
  }, []);

  // 手动触发后台下载（无感更新路径）：成功后标题栏药丸接管进度展示
  const handleSilentDownload = useCallback(async () => {
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
      // 成功即进入安装（退出应用 / 拉起系统安装器），不需要收尾
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setInstalling(false);
    }
  }, [installNowUpdate]);

  const handleResetOnboarding = useCallback(async () => {
    try {
      await update({ hasCompletedOnboarding: false });
      window.location.reload();
    } catch (err) {
      console.error('Failed to reset onboarding:', err);
    }
  }, [update]);

  return (
    <>
      <div className="flex justify-center mb-6">
        <img
          src={APP_LOGO}
          alt={`${APP_NAME} logo`}
          className="w-56 h-56 object-contain select-none"
          draggable="false"
        />
      </div>
      <Card id="settings-about" title="应用信息">
        <SettingItem id="about-name" label="应用名称" sectionId="settings-about">
          <span className="text-sm text-zinc-300">{APP_NAME}</span>
        </SettingItem>
        <SettingItem id="about-version" label="当前版本" sectionId="settings-about">
          <span className="text-sm text-zinc-300">{appVersion}</span>
        </SettingItem>
        <SettingItem
          id="about-update"
          label="检查更新"
          description="查看是否有新版本可用"
          sectionId="settings-about"
          keywords={['update', 'version', '升级']}
        >
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={handleCheck} loading={checking}>
              检查更新
            </Button>
            {result && !result.hasUpdate && (
              <span className="text-sm text-emerald-400">已是最新版本</span>
            )}
            {error && <span className="text-sm text-red-400">{error}</span>}
          </div>
          {result && result.hasUpdate && (
            <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-800/50 p-4 space-y-3">
              <p className="text-sm text-zinc-200">
                新版本 <span className="text-indigo-400 font-medium">{result.latestVersion}</span> 可用！
              </p>
              {updateState.status === 'downloading' ? (
                /* 已在下载：后端对重复触发是幂等 no-op，所以这里不给按钮，
                   改成展示进度（后台继续下载，关掉设置页也不受影响） */
                <p className="text-sm text-indigo-300">
                  正在后台下载 {updateState.version} ·{' '}
                  {updatePercent(updateState.downloaded, updateState.total)}%
                  <span className="block text-xs text-zinc-500">
                    下载在后台继续，关掉设置页也不受影响。
                  </span>
                </p>
              ) : updateState.status === 'ready' ? (
                <>
                  <Button
                    variant="primary"
                    loading={installing}
                    onClick={handleInstallNow}
                  >
                    立即安装
                  </Button>
                  <p className="text-xs text-zinc-500">
                    {capabilities?.installKind === 'apk'
                      ? '安装包已下载完成，点击后在系统安装界面确认即可。'
                      : '安装包已下载完成；不点也会在你退出应用时自动安装。'}
                  </p>
                </>
              ) : capabilities?.silentDownload && result.installerUrl ? (
                <>
                  <Button
                    variant="primary"
                    loading={downloading}
                    onClick={handleSilentDownload}
                  >
                    后台下载
                  </Button>
                  <p className="text-xs text-zinc-500">
                    {capabilities.installKind === 'apk'
                      ? '下载完成后在提示里点「立即安装」即可；也可以在下面打开自动下载。'
                      : '下载完成后可留意标题栏进度；应用退出时会自动安装新版本。'}
                  </p>
                </>
              ) : (
                <Button variant="primary" onClick={() => openExternalLink(result.releaseUrl)}>
                  去下载
                </Button>
              )}
            </div>
          )}
        </SettingItem>
        {capabilities?.silentDownload && (
          <SettingItem
            id="about-auto-update"
            label="自动下载并安装更新"
            description={
              capabilities.installKind === 'apk'
                ? '发现新版本后在非计量网络下自动后台下载，下载完成提示你安装；关闭后仅提示，需手动下载'
                : '发现新版本后自动在后台下载，退出应用时静默安装；关闭后仅提示，需手动前往下载'
            }
            sectionId="settings-about"
            keywords={['auto', 'update', '自动更新', '无感更新', '升级']}
          >
            <Toggle
              checked={autoUpdate}
              onChange={(v) => {
                setError(null);
                update({ autoUpdate: v }).catch((e) => setError(getErrorMessage(e)));
              }}
            />
          </SettingItem>
        )}
        <SettingItem
          id="about-onboarding"
          label="重新引导"
          description="重新运行初次使用引导流程"
          sectionId="settings-about"
          keywords={['onboarding', 'guide', '引导', '新手', '教程']}
        >
          <Button variant="secondary" onClick={handleResetOnboarding}>
            重新运行引导
          </Button>
        </SettingItem>
        <SettingItem
          id="about-chat-history"
          label="聊天历史记录"
          description="查看所有 SSH 连接的历史聊天记录"
          sectionId="settings-about"
          keywords={['chat', 'history', 'conversation', '聊天', '历史', '会话']}
        >
          <Button variant="secondary" onClick={() => setShowHistory(true)}>
            查看聊天历史
          </Button>
        </SettingItem>
      <SettingItem
          id="about-support"
          label="技术支持 / Bug 反馈"
          description="遇到问题或想反馈建议？加入官方交流群"
          sectionId="settings-about"
          keywords={['support', 'feedback', 'bug', 'QQ', '群', '帮助', '技术', '反馈', '问题']}
        >
          <Button variant="secondary" onClick={() => openExternalLink(SUPPORT_URL)}>
            加入交流群
          </Button>
        </SettingItem>
      </Card>
      <ChatHistoryModal open={showHistory} onClose={() => setShowHistory(false)} />
    </>
  );
}
