import React from 'react';
import type { ActiveInteractionPayload } from '@/lib/types';
import { RISK_LEVEL_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import { ChevronUp, Maximize2, Check, X } from 'lucide-react';

interface InteractionFloatingCapsuleProps {
  interaction: ActiveInteractionPayload;
  onExpand: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  onNavigateToContext?: () => void;
  isCurrentContext?: boolean;
}

export const InteractionFloatingCapsule: React.FC<InteractionFloatingCapsuleProps> = ({
  interaction,
  onExpand,
  onApprove,
  onReject,
  onNavigateToContext,
  isCurrentContext = true,
}) => {
  const isApproval = interaction.kind === 'approval' && interaction.approval;
  const isQuestion = interaction.kind === 'question' && interaction.question;

  const title = isApproval
    ? `需要批准：${interaction.approval?.toolName}`
    : `需要回答问题 (${interaction.question?.questions.length ?? 0} 个)`;

  const riskLevel = interaction.approval?.riskLevel;

  return (
    <div className="fixed bottom-4 right-4 z-50 animate-bounce-subtle pointer-events-auto max-w-[calc(100vw-2rem)]">
      <div className="flex items-center gap-2.5 p-2 pr-3 rounded-2xl bg-zinc-900/95 backdrop-blur-xl border border-zinc-700/80 shadow-2xl shadow-black/60 text-zinc-100">
        {/* Expand / Clickable area */}
        <button
          type="button"
          onClick={onExpand}
          className="flex items-center gap-2 text-left min-w-0 hover:opacity-90 active:scale-[0.98] transition-all"
        >
          {/* Status Indicator pulse */}
          <span className="relative flex h-3 w-3 shrink-0 ml-1">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 motion-reduce:hidden" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold truncate max-w-[180px]">{title}</span>
              {riskLevel && (
                <Badge variant={riskLevel} size="sm">
                  {RISK_LEVEL_LABELS[riskLevel]}
                </Badge>
              )}
              {(interaction.queueLength ?? 1) > 1 && (
                <span className="text-[10px] px-1.5 py-0.2 bg-zinc-800 rounded-full text-zinc-400 border border-zinc-700">
                  1/{interaction.queueLength}
                </span>
              )}
            </div>

            {/* Context label */}
            {(interaction.sessionName || interaction.conversationTitle) && (
              <div className="text-[11px] text-zinc-400 truncate max-w-[200px]">
                {interaction.sessionName || 'SSH'}
                {interaction.conversationTitle ? ` · ${interaction.conversationTitle}` : ''}
              </div>
            )}
          </div>
        </button>

        {/* Quick action buttons */}
        <div className="flex items-center gap-1 shrink-0 border-l border-zinc-700/60 pl-2">
          {!isCurrentContext && onNavigateToContext && (
            <button
              type="button"
              onClick={onNavigateToContext}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-indigo-300 text-xs font-medium transition-colors"
              title="切换到对应对话查看"
            >
              切入
            </button>
          )}

          {isApproval && onReject && (
            <button
              type="button"
              onClick={onReject}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-red-950/60 hover:text-red-300 text-zinc-300 transition-colors"
              title="拒绝"
              aria-label="拒绝"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          {isApproval && onApprove && (
            <button
              type="button"
              onClick={onApprove}
              className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
              title="批准"
              aria-label="批准"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            type="button"
            onClick={onExpand}
            className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors ml-0.5"
            title="展开弹窗"
            aria-label="展开弹窗"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
