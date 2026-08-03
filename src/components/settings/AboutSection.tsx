import { useState, useEffect, useCallback } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { checkUpdate } from '@/lib/tauri';
import type { UpdateCheckResult } from '@/lib/types';
import { getErrorMessage } from '@/lib/errors';
import { openExternalLink, SUPPORT_URL } from '@/lib/externalLinks';
import { APP_NAME, APP_LOGO } from '@/lib/constants';
import Button from '@/components/ui/Button';
import { Card, SettingItem } from './helpers';
import { useSettingsStore } from '@/stores/settingsStore';
import ChatHistoryModal from './ChatHistoryModal';
import { useConnectionStore } from '@/stores/connectionStore';

export default function AboutSection() {
  const [appVersion, setAppVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const update = useSettingsStore((s) => s.update);
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
              <Button variant="primary" onClick={() => openExternalLink(result.releaseUrl)}>
                去下载
              </Button>
            </div>
          )}
        </SettingItem>
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
