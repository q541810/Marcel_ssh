import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';

/**
 * Current app version as a string, loaded once via Tauri's getVersion().
 * Empty string until resolved (or if it fails) — callers must guard on
 * `appVersion.length > 0` before making compatibility judgments.
 */
export function useAppVersion(): string {
  const [version, setVersion] = useState('');
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(''));
  }, []);
  return version;
}
