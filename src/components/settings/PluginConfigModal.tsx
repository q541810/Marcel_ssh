import { useEffect, useRef, useState, useCallback } from 'react';
import { pluginWebviewCreate, pluginWebviewSetBounds, pluginWebviewClose } from '@/lib/tauri';
import { getElementRect } from '@/plugins/rectSync';
import { registerConfigSavedCallback, unregisterConfigSavedCallback } from '@/plugins/pluginIpc';
import Modal from '@/components/ui/Modal';

const ANIMATION_SYNC_MS = 250;

interface Props {
  open: boolean;
  onClose: () => void;
  pluginId: string;
  pluginName: string;
  configView: string;
}

export default function PluginConfigModal({ open, onClose, pluginId, pluginName, configView }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const label = `plugin-${pluginId}-config`.replace(/[^a-zA-Z0-9\-/:_]/g, '_');
  const createdRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // Register config.saved callback
  useEffect(() => {
    if (!open) return;
    registerConfigSavedCallback(pluginId, handleClose);
    return () => {
      unregisterConfigSavedCallback(pluginId);
    };
  }, [open, pluginId, handleClose]);

  // WebView lifecycle
  useEffect(() => {
    if (!open) return;

    const el = containerRef.current;
    if (!el) return;

    let rafId = 0;
    let animRafId = 0;

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
        applyBounds(rect.x, rect.y, rect.width, rect.height);
      });
    };

    const ro = new ResizeObserver(() => syncBounds());
    ro.observe(el);

    const onWinResize = () => syncBounds();
    window.addEventListener('resize', onWinResize);

    // Delay creation slightly to ensure Modal animation is done
    const createTimer = setTimeout(() => {
      const rect = measureRect();
      pluginWebviewCreate(label, pluginId, configView, rect.x, rect.y, rect.width, rect.height)
        .then(() => {
          createdRef.current = true;
          syncBounds();
          const start = performance.now();
          const tick = () => {
            const r = measureRect();
            if (r.width > 0 && r.height > 0) {
              applyBounds(r.x, r.y, r.width, r.height);
            }
            if (performance.now() - start < ANIMATION_SYNC_MS) {
              animRafId = requestAnimationFrame(tick);
            }
          };
          animRafId = requestAnimationFrame(tick);
        })
        .catch((err) => {
          console.error('[plugin-config] create failed:', err);
          setError(String(err));
        });
    }, 50);

    return () => {
      clearTimeout(createTimer);
      if (rafId) cancelAnimationFrame(rafId);
      if (animRafId) cancelAnimationFrame(animRafId);
      ro.disconnect();
      window.removeEventListener('resize', onWinResize);
      applyBounds(0, 0, 0, 0);
      if (createdRef.current) {
        pluginWebviewClose(label).catch(console.error);
      }
      createdRef.current = false;
    };
  }, [open, label, pluginId, configView, retryKey]);

  return (
    <Modal open={open} onClose={handleClose} title={`${pluginName} - 配置`} size="xl">
      <div className="w-full h-full relative">
        {error ? (
          <div className="w-full h-full flex items-center justify-center bg-zinc-900">
            <div className="text-center space-y-3 px-4">
              <div className="text-red-400 text-sm font-medium">配置页面加载失败</div>
              <div className="text-zinc-500 text-xs break-all">{error}</div>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  pluginWebviewClose(label).catch(() => {});
                  createdRef.current = false;
                  setRetryKey((k) => k + 1);
                }}
                className="mt-2 px-3 py-1.5 text-xs bg-zinc-700 text-zinc-200 rounded-lg hover:bg-zinc-600 transition-colors"
              >
                重试
              </button>
            </div>
          </div>
        ) : (
          <div ref={containerRef} className="w-full h-full min-h-[60vh]" />
        )}
      </div>
    </Modal>
  );
}
