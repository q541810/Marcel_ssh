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
}

export default function ApprovalDialog({
  toolCall,
  onApprove,
  onReject,
  open,
  onClose,
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
          <h3 className="text-lg font-semibold text-zinc-100">
            需要操作批准
          </h3>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200"
          >
            &times;
          </button>
        </div>

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
