import { useRef } from 'react';
import { useTauriEvent } from '@/hooks/useTauriEvent';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { formatAddress } from '@/lib/privacy';

interface HostKeyWarningPayload {
  host: string;
  port: number;
  reason: string;
  message: string;
}

/**
 * Listens for `hostKeyWarning` events from the backend (emitted when TOFU
 * host-key recording fails during connection) and surfaces the warning as
 * a system notification so the user knows TOFU pinning may not persist.
 *
 * Renders nothing itself — the OS notification does the talking.
 */
export default function HostKeyWarningToast() {
  const firedRef = useRef<string | null>(null);
  const privacyMode = usePrivacyMode();

  useTauriEvent<HostKeyWarningPayload>('hostKeyWarning', (payload) => {
    const { host, port, message } = payload;
    // 去重 key 用真实值（隐私模式只是不显示，不改变"这条警告发过没有"）
    const key = `${host}:${port}:${message}`;
    if (firedRef.current === key) return;
    firedRef.current = key;

    (async () => {
      try {
        const mod = await import('@tauri-apps/plugin-notification');
        const { sendNotification, isPermissionGranted, requestPermission } = mod;
        let granted = await isPermissionGranted();
        if (!granted) {
          const perm = await requestPermission();
          granted = perm === 'granted';
        }
        if (granted) {
          sendNotification({
            // 系统通知是最外向的展示面（通知中心会留存、锁屏也能看到），
            // 主机与端口一律走 privacy.ts 的脱敏口径。
            title: `Marcel SSH — ${formatAddress(host, port, privacyMode)} 主机密钥未持久化`,
            body: message,
          });
        }
      } catch (err) {
        console.error('发送主机密钥警告通知失败:', err);
      }
    })();
  });

  return null;
}
