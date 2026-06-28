import { useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { pluginWebviewSetBounds } from '@/lib/tauri';
import { getElementRect } from './rectSync';
import { acquire, hide, destroy } from './pluginWebviewPool';
import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ViewProvider } from '@/lib/types';

const ANIMATION_SYNC_MS = 250;

type ErrorPhase = 'load' | 'runtime' | null;

interface Props {
  provider: ViewProvider;
}

export default function PluginWebviewSlot({ provider }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const label = `plugin-${provider.pluginId}-${provider.id}`.replace(/[^a-zA-Z0-9\-/:_]/g, '_');
  const [error, setError] = useState<string | null>(null);
  const [errorPhase, setErrorPhase] = useState<ErrorPhase>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let rafId = 0;
    let animRafId = 0;
    let unlistenLoad: UnlistenFn | null = null;
    let unlistenEvent: UnlistenFn | null = null;
    let didFinishLoad = false;

    const measureRect = () => getElementRect(el);

    const applyBounds = (x: number, y: number, w: number, h: number) => {
      pluginWebviewSetBounds(label, x, y, w, h).catch(() => {});
    };

    const syncBounds = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const rect = measureRect();
        if (rect.width <= 0 || rect.height <= 0) {
          applyBounds(0, 0, 0, 0);
          return;
        }
        applyBounds(rect.x, rect.y, rect.width - 5, rect.height);
      });
    };

    const ro = new ResizeObserver(() => syncBounds());
    ro.observe(el);

    const onWinResize = () => syncBounds();
    window.addEventListener('resize', onWinResize);

    // Subscribe to backend webview events for this label.
    void listen<{ pluginId: string; phase: string; url?: string }>(
      `webview://page-load/${label}`,
      (e) => {
        if (e.payload?.phase === 'finished') {
          didFinishLoad = true;
          // A successful load clears any prior transient error.
          setError(null);
          setErrorPhase(null);
        } else if (e.payload?.phase === 'started' && !didFinishLoad) {
          // Don't show error during a new navigation that hasn't finished yet.
        }
      },
    ).then((fn) => {
      unlistenLoad = fn;
    });

    void listen<{ pluginId: string; event: string }>(
      `webview://event/${label}`,
      (e) => {
        const kind = e.payload?.event ?? '';
        // WebviewEvent::Crashed / Failed / unresponsive → runtime error.
        if (
          kind.includes('Crashed') ||
          kind.includes('Failed') ||
          kind.includes('Unresponsive') ||
          kind.includes('PageLoadFailed')
        ) {
          setError(`插件运行时错误: ${kind}`);
          setErrorPhase('runtime');
        }
      },
    ).then((fn) => {
      unlistenEvent = fn;
    });

    const rect = measureRect();
    const entry = provider.webviewEntry ?? 'index.html';
    acquire(label, provider.pluginId, entry, rect.x, rect.y, rect.width - 5, rect.height)
      .then(() => {
        syncBounds();
        const start = performance.now();
        const tick = () => {
          const r = measureRect();
          if (r.width > 0 && r.height > 0) {
            applyBounds(r.x, r.y, r.width - 5, r.height);
          }
          if (performance.now() - start < ANIMATION_SYNC_MS) {
            animRafId = requestAnimationFrame(tick);
          }
        };
        animRafId = requestAnimationFrame(tick);
      })
      .catch((err) => {
        console.error('[plugin-slot] acquire failed:', err);
        setError(String(err));
        setErrorPhase('load');
      });

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (animRafId) cancelAnimationFrame(animRafId);
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      unlistenLoad?.();
      unlistenEvent?.();
      hide(label).catch(() => {});
    };
  }, [label, provider.pluginId, provider.webviewEntry, retryKey]);

  const handleRetry = () => {
    setError(null);
    setErrorPhase(null);
    // Tear down any existing instance and re-acquire.
    destroy(label).catch(() => {});
    setRetryKey((k) => k + 1);
  };

  const handleDisable = () => {
    const current = useSettingsStore.getState().settings.disabledPlugins ?? [];
    if (!current.includes(provider.pluginId)) {
      useSettingsStore.getState().update({
        disabledPlugins: [...current, provider.pluginId],
      });
    }
    // Hide the WebView (pool keeps it but bounds = 0) so the user no longer
    // sees the broken surface; the next time the user navigates away and
    // back, the slot is replaced.
    hide(label).catch(() => {});
    usePluginStore.getState().fetchPlugins().catch(() => {});
  };

  if (error) {
    const isRuntime = errorPhase === 'runtime';
    return (
      <div ref={ref} className="w-full h-full flex items-center justify-center bg-zinc-900">
        <div className="text-center space-y-3 px-4 max-w-md">
          <div className="text-red-400 text-sm font-medium">
            {isRuntime ? '插件运行时错误' : '插件加载失败'}
          </div>
          <div className="text-zinc-500 text-xs break-all">{error}</div>
          {isRuntime ? (
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={handleDisable}
                className="px-3 py-1.5 text-xs bg-zinc-700 text-zinc-200 rounded-lg hover:bg-zinc-600 transition-colors"
              >
                禁用此插件
              </button>
              <span className="text-[11px] text-zinc-600">
                请联系插件作者或检查代码
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleRetry}
              className="mt-2 px-3 py-1.5 text-xs bg-zinc-700 text-zinc-200 rounded-lg hover:bg-zinc-600 transition-colors"
            >
              重试
            </button>
          )}
        </div>
      </div>
    );
  }

  return <div ref={ref} className="w-full h-full" />;
}
