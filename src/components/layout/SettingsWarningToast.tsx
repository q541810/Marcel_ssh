import { useEffect, useRef } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * Surfaces a non-fatal backend warning (typically "settings.json could not be
 * loaded and was backed up to .bak") as a system notification. Renders nothing
 * itself — the OS notification does the talking.
 */
export default function SettingsWarningToast() {
  const warning = useSettingsStore((s) => s.warning);
  const clearWarning = useSettingsStore((s) => s.clearWarning);
  const firedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!warning || firedRef.current === warning) return;
    firedRef.current = warning;

    let cancelled = false;
    (async () => {
      try {
        const mod = await import('@tauri-apps/plugin-notification');
        if (cancelled) return;
        const { sendNotification, isPermissionGranted, requestPermission } = mod;
        let granted = await isPermissionGranted();
        if (!granted) {
          const perm = await requestPermission();
          granted = perm === 'granted';
        }
        if (granted) {
          sendNotification({
            title: 'Marcel SSH — 配置加载异常',
            body: warning,
          });
        }
      } catch (err) {
        console.error('发送配置警告通知失败:', err);
      } finally {
        if (!cancelled) clearWarning();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [warning, clearWarning]);

  return null;
}
