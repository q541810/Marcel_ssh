import { useCallback, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Package, Trash2, X } from 'lucide-react';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';
import Button from '@/components/ui/Button';

/** 覆盖层状态机。 */
export type InstallOverlayStatus =
  /** 安装/卸载进行中（可取消）。 */
  | { kind: 'running' }
  /** 用户已点取消、等待任务中止。 */
  | { kind: 'cancelling' }
  /** 成功完成（提示重启后生效）。 */
  | { kind: 'done' }
  /** 任务已被取消。 */
  | { kind: 'cancelled' }
  /** 失败。 */
  | { kind: 'error'; message: string };

export type InstallOverlayKind = 'install' | 'uninstall';

/** 进行中进度（received/total；total 为 0 时显示不确定进度条）。 */
export interface InstallOverlayProgress {
  received: number;
  total: number;
}

interface Props {
  open: boolean;
  kind: InstallOverlayKind;
  pluginName: string;
  status: InstallOverlayStatus;
  progress: InstallOverlayProgress | null;
  onCancel: () => void;
  onClose: () => void;
}

const TERMINAL = new Set(['done', 'cancelled', 'error']);

/** 运行中的覆盖层不可关闭：不渲染任何关闭入口，Esc 被吞掉。 */
export default function InstallOverlay({
  open,
  kind,
  pluginName,
  status,
  progress,
  onCancel,
  onClose,
}: Props) {
  const presence = useAnimatedPresence(open);

  // 运行中吞掉 Escape：保证用户看不到重启提示前无法关掉覆盖层。
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open && !TERMINAL.has(status.kind)) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    [open, status.kind],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  if (!presence.mounted) return null;
  const exiting = presence.phase === 'exit';

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : null;

  let icon: ReactNode;
  let title: string;
  let body: ReactNode;
  let footer: ReactNode;

  const iconClass = 'w-10 h-10 mx-auto mb-3';

  switch (status.kind) {
    case 'running':
    case 'cancelling':
      title = kind === 'install' ? '正在安装插件' : '正在卸载插件';
      if (status.kind === 'cancelling') {
        icon = (
          <span className={`${iconClass} block text-zinc-400`}>
            <X className="w-10 h-10" />
          </span>
        );
        body = <p className="text-sm text-zinc-400">正在取消，请稍候…</p>;
        footer = null;
      } else {
        icon = (
          <span className={`${iconClass} block text-indigo-400`}>
            <Package className="w-10 h-10" />
          </span>
        );
        body = (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">
              {kind === 'install' ? '下载并解压插件源码' : '正在删除插件目录及其数据'}
              {kind === 'install' && progress && (
                <span className="block text-xs text-zinc-500 mt-1">
                  {progress.total > 0
                    ? `${progress.received} / ${progress.total}`
                    : '连接中…'}
                </span>
              )}
            </p>
            <div className="w-72 h-1.5 rounded-full bg-zinc-700 overflow-hidden">
              {percent !== null ? (
                <div
                  className="h-full bg-indigo-500 transition-all duration-200"
                  style={{ width: `${percent}%` }}
                />
              ) : (
                <div className="h-full w-1/3 bg-indigo-500 rounded-full indeterminate-bar" />
              )}
            </div>
            {percent !== null && (
              <p className="text-xs text-zinc-500 text-right">{percent}%</p>
            )}
          </div>
        );
        footer = (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            取消
          </Button>
        );
      }
      break;
    case 'done':
      icon = <Check className={`${iconClass} text-emerald-400`} />;
      title = kind === 'install' ? '安装完成' : '卸载完成';
      body = (
        <p className="text-sm text-zinc-300 leading-relaxed">
          {kind === 'install'
            ? '插件已安装到本地，重启应用后插件生效。'
            : '插件目录已删除，重启应用后完全移除。'}
        </p>
      );
      footer = (
        <Button variant="primary" size="sm" onClick={onClose}>
          知道了
        </Button>
      );
      break;
    case 'cancelled':
      icon = <X className={`${iconClass} text-zinc-400`} />;
      title = kind === 'install' ? '已取消安装' : '已取消卸载';
      body = <p className="text-sm text-zinc-400">未留下任何残留文件。</p>;
      footer = (
        <Button variant="primary" size="sm" onClick={onClose}>
          关闭
        </Button>
      );
      break;
    case 'error':
      icon = <AlertTriangle className={`${iconClass} text-red-400`} />;
      title = kind === 'install' ? '安装失败' : '卸载失败';
      body = (
        <p className="text-xs text-red-400 leading-relaxed break-all max-h-28 overflow-y-auto">
          {status.message}
        </p>
      );
      footer = (
        <Button variant="primary" size="sm" onClick={onClose}>
          关闭
        </Button>
      );
      break;
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop：运行中点击无任何效果 */}
      <div
        className={`absolute inset-0 bg-black/70 backdrop-blur-sm ${
          exiting ? 'modal-backdrop-exit' : 'modal-backdrop-enter'
        }`}
      />
      <div
        role="dialog"
        aria-modal="true"
        onAnimationEnd={presence.onAnimationEnd}
        className={`relative w-full max-w-md mx-4 rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl px-6 py-8 flex flex-col items-center text-center ${
          exiting ? 'modal-panel-exit' : 'modal-panel-enter'
        }`}
      >
        {icon}
        <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
          {kind === 'install' ? <Package className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
          <span className="truncate">{pluginName}</span>
        </h2>
        <p className="text-xs text-zinc-500 mt-0.5">{title}</p>
        <div className="mt-4">{body}</div>
        {footer && <div className="mt-6">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
