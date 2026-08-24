import { useEffect, useCallback } from 'react';
import type { ToolCallInfo } from '@/lib/types';
import { RISK_LEVEL_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import FileChangeView from './FileChangeView';
import { cleanExecuteCommandArgs } from './argumentFormat';

interface Props {
  toolCall: ToolCallInfo;
  onApprove: () => void;
  onReject: () => void;
  open: boolean;
  onClose: () => void;
  sessionName?: string;
  conversationTitle?: string;
  isCurrentContext?: boolean;
  onNavigateToContext?: (e?: React.MouseEvent) => void;
  queueLength?: number;
  onMinimize?: (e?: React.MouseEvent) => void;
}

export default function ApprovalDialog({
  toolCall,
  onApprove,
  onReject,
  open,
  onClose,
  sessionName,
  conversationTitle,
  isCurrentContext = true,
  onNavigateToContext,
  queueLength = 1,
  onMinimize,
}: Props) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        onApprove();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onReject();
      }
    },
    [open, onApprove, onReject],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!open) return null;

  const isEditFile = toolCall.name === 'edit_file';
  const isExecuteCommand = toolCall.name === 'execute_command';
  const path = typeof toolCall.arguments?.path === 'string' ? toolCall.arguments.path : '';
  const cleanedCmd = isExecuteCommand ? cleanExecuteCommandArgs(toolCall.arguments) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="modal-backdrop-enter absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        className={`modal-panel-enter relative w-full mx-4 rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl ${
          isEditFile ? 'max-w-3xl' : 'max-w-md'
        }`}
      >
        <div className="flex items-center justify-between p-4 border-b border-zinc-700">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-zinc-100">
              需要操作批准
            </h3>
            {queueLength > 1 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-900/60 border border-indigo-700/50 text-indigo-300 font-medium">
                待处理 1/{queueLength}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onMinimize && (
              <button
                type="button"
                onClick={onMinimize}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                title="最小化为浮动药丸"
                aria-label="最小化"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-200 text-lg leading-none p-1"
            >
              &times;
            </button>
          </div>
        </div>

        {/* 顶部上下文横条提示 (Context Banner) */}
        {(sessionName || conversationTitle) && (
          <div className="mx-4 mt-3 p-2.5 rounded-xl bg-zinc-900/90 border border-zinc-700/80 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <svg className="w-4 h-4 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="text-xs text-zinc-300 truncate">
                <span className="font-semibold text-zinc-200">{sessionName || 'SSH 会话'}</span>
                {conversationTitle && (
                  <span className="text-zinc-400"> · {conversationTitle}</span>
                )}
              </div>
            </div>
            {onNavigateToContext && (
              <button
                type="button"
                onClick={onNavigateToContext}
                className="shrink-0 text-xs px-2.5 py-1 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 border border-indigo-500/40 transition-colors font-medium flex items-center gap-1 active:scale-95"
              >
                <span>跳转查看</span>
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}
          </div>
        )}

        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-400">风险级别：</span>
            <Badge variant={toolCall.riskLevel} size="md">
              {RISK_LEVEL_LABELS[toolCall.riskLevel]}
            </Badge>
          </div>

          {toolCall.reasons && toolCall.reasons.length > 0 && (
            <div className="rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2">
              <div className="text-xs font-medium text-amber-300 mb-1">模型提示</div>
              <ul className="text-xs text-amber-200/90 space-y-0.5 list-disc list-inside">
                {toolCall.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <span className="text-sm text-zinc-400">工具：</span>
            <span className="ml-2 font-mono text-sm text-zinc-200">
              {toolCall.name}
            </span>
          </div>

          {isEditFile ? (
            <div className="space-y-2">
              {path && (
                <div className="text-xs font-mono text-zinc-300 truncate" title={path}>
                  {path}
                </div>
              )}
              <div className="rounded-lg border border-zinc-700 overflow-hidden bg-zinc-900">
                <FileChangeView
                  toolName="edit_file"
                  arguments={toolCall.arguments || {}}
                  metadata={toolCall.metadata}
                />
              </div>
            </div>
          ) : isExecuteCommand && cleanedCmd?.main ? (
            <div className="space-y-2">
              <span className="text-sm text-zinc-400">参数：</span>
              <div className="mt-1 rounded-lg bg-zinc-950 border border-zinc-700 overflow-hidden">
                <div className="flex items-start gap-2 px-3 py-2">
                  <span className="text-emerald-400 font-mono text-xs select-none leading-relaxed">$</span>
                  <code className="flex-1 min-w-0 font-mono text-xs text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
                    {cleanedCmd.main}
                  </code>
                </div>
                {Object.keys(cleanedCmd.extras).length > 0 && (
                  <pre className="px-3 py-2 border-t border-zinc-700/60 font-mono text-[11px] text-zinc-400 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                    {JSON.stringify(cleanedCmd.extras, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          ) : (
            <div>
              <span className="text-sm text-zinc-400">参数：</span>
              <pre className="mt-1 p-2 rounded-lg bg-zinc-900 text-xs text-zinc-300 overflow-auto max-h-40 whitespace-pre-wrap break-words">
                {JSON.stringify(toolCall.arguments, null, 2)}
              </pre>
            </div>
          )}

          <div className="text-xs text-zinc-500 flex gap-4">
            <span>
              <kbd className="px-1 py-0.5 rounded-lg bg-zinc-700 text-zinc-300">Enter</kbd>{' '}
              批准
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded-lg bg-zinc-700 text-zinc-300">Esc</kbd>{' '}
              拒绝
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-zinc-700">
          <Button variant="secondary" onClick={onReject}>
            拒绝
          </Button>
          <Button variant="primary" onClick={onApprove}>
            批准
          </Button>
        </div>
      </div>
    </div>
  );
}
