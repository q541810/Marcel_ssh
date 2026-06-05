import { useState, useEffect, useCallback } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { checkUpdate } from '@/lib/tauri';
import type { UpdateCheckResult } from '@/lib/types';
import { getErrorMessage } from '@/lib/errors';
import Button from '@/components/ui/Button';
import { Section } from './helpers';

const APP_NAME_STR = 'Marcel SSH';

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
    <Section id="settings-about" title="关于">
      <div className="space-y-4">
        <div className="text-sm text-zinc-400 space-y-1">
          <p>
            <span className="text-zinc-300">应用名称：</span>{APP_NAME_STR}
          </p>
          <p>
            <span className="text-zinc-300">当前版本：</span>{appVersion}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={handleCheck} loading={checking}>
            检查更新
          </Button>

          {result && !result.hasUpdate && (
            <span className="text-sm text-emerald-400">已是最新版本</span>
          )}

          {error && (
            <span className="text-sm text-red-400">{error}</span>
          )}
        </div>

        {result && result.hasUpdate && (
          <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-4 space-y-3">
            <p className="text-sm text-zinc-200">
              新版本 <span className="text-indigo-400 font-medium">{result.latestVersion}</span> 可用！
            </p>
            <a
              href={result.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block"
            >
              <Button variant="primary">去下载</Button>
            </a>
          </div>
        )}
      </div>
    </Section>
  );
}
