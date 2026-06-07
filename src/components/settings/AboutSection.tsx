import { useState, useEffect, useCallback } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { checkUpdate } from '@/lib/tauri';
import type { UpdateCheckResult } from '@/lib/types';
import { getErrorMessage } from '@/lib/errors';
import { openExternalLink } from '@/lib/externalLinks';
import { APP_NAME, APP_LOGO } from '@/lib/constants';
import Button from '@/components/ui/Button';
import { Card, SettingItem } from './helpers';

const APP_NAME_STR = APP_NAME;

export default function AboutSection() {
  const [appVersion, setAppVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion('0.1.3'));
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

  return (
    <>
      <div className="flex justify-center mb-6">
        <img
          src={APP_LOGO}
          alt={`${APP_NAME_STR} logo`}
          className="w-56 h-56 object-contain select-none"
          draggable="false"
        />
      </div>
      <Card id="settings-about" title="应用信息">
        <SettingItem id="about-name" label="应用名称" sectionId="settings-about">
          <span className="text-sm text-zinc-300">{APP_NAME_STR}</span>
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
      </Card>
    </>
  );
}
