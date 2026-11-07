import { X } from 'lucide-react';
import { AgentContentBand } from './AgentContentBand';

type RollbackNoticeBarProps = {
  notice: string;
  onDismiss: () => void;
  /** `rollback`（默认）：撤回成功；`error`：操作失败（如分叉失败），换成红色警示。 */
  variant?: 'rollback' | 'error';
};

/** 撤回成功 / 输入区操作失败的提示条。 */
export function RollbackNoticeBar({ notice, onDismiss, variant = 'rollback' }: RollbackNoticeBarProps) {
  const isError = variant === 'error';
  return (
    <AgentContentBand className="flex-shrink-0 border-t border-edge-subtle bg-surface/90 backdrop-blur animate-fadeIn">
      <div
        className={`flex items-center justify-between gap-2 py-2 text-meta ${
          isError ? 'text-red-200' : 'text-amber-200'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <svg
            className={`w-3.5 h-3.5 flex-shrink-0 ${isError ? 'text-red-300' : 'text-amber-300'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d={
                isError
                  ? 'M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z'
                  : 'M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6'
              }
            />
          </svg>
          <span className="truncate">{notice}</span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="p-1 rounded text-fg-tertiary hover:text-fg hover:bg-state-soft transition-colors"
          title="关闭"
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.5} />
        </button>
      </div>
    </AgentContentBand>
  );
}
