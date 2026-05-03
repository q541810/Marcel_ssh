import { useEffect, useCallback } from 'react';
import type { ToolCallInfo } from '@/lib/types';
import { RISK_LEVEL_COLORS, RISK_LEVEL_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative w-full max-w-md mx-4 rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl">
        {/* Header */}
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

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Risk level */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-400">风险级别：</span>
            <Badge variant={toolCall.riskLevel} size="md">
              {RISK_LEVEL_LABELS[toolCall.riskLevel]}
            </Badge>
          </div>

          {/* Tool name */}
          <div>
            <span className="text-sm text-zinc-400">工具：</span>
            <span className="ml-2 font-mono text-sm text-zinc-200">
              {toolCall.name}
            </span>
          </div>

          {/* Arguments */}
          <div>
            <span className="text-sm text-zinc-400">参数：</span>
            <pre className="mt-1 p-2 rounded-lg bg-zinc-900 text-xs text-zinc-300 overflow-auto max-h-40">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>

          {/* Keyboard hints */}
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

        {/* Actions */}
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
