import { useEffect, useRef } from 'react';

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

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<HostKeyWarningPayload>('hostKeyWarning', (event) => {
        const { host, port, message } = event.payload;
        const key = `${host}:${port}:${message}`;
        if (firedRef.current === key) return;
        firedRef.current = key;

        (async () => {
          try {
            const mod = await import('@tauri-apps/plugin-notification');
            const { sendNotification, isPermissionGranted, requestPermission } =
              mod;
            let granted = await isPermissionGranted();
            if (!granted) {
              const perm = await requestPermission();
              granted = perm === 'granted';
            }
            if (granted) {
              sendNotification({
                title: `Marcel SSH — ${host}:${port} 主机密钥未持久化`,
                body: message,
              });
            }
          } catch (err) {
            console.error('发送主机密钥警告通知失败:', err);
          }
        })();
      }).then((fn) => {
        unlisten = fn;
      });
    });

    return () => {
      unlisten?.();
    };
  }, []);

  return null;
}
