import React, { useEffect, useRef } from 'react';
import type { ActiveInteractionPayload } from '@/lib/types';
import { RISK_LEVEL_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import { Maximize2, Check, X, ShieldAlert, HelpCircle } from 'lucide-react';
import { registerCapsuleTarget } from '@/stores/capsuleFlyAnimation';

interface InteractionFloatingCapsuleProps {
  interaction: ActiveInteractionPayload;
  onExpand: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  onNavigateToContext?: (e?: React.MouseEvent) => void;
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
  const capsuleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerCapsuleTarget(capsuleRef.current);
    return () => registerCapsuleTarget(null);
  }, []);

  const isApproval = interaction.kind === 'approval' && interaction.approval;
  const isQuestion = interaction.kind === 'question' && interaction.question;

  const toolName = interaction.approval?.toolName;
  const riskLevel = interaction.approval?.riskLevel;
  const questionCount = interaction.question?.questions.length ?? 0;

  return (
    <div
      ref={capsuleRef}
      className="fixed bottom-5 right-5 z-50 pointer-events-auto max-w-[calc(100vw-2.5rem)] animate-fadeIn"
    >
      <div
        onClick={onExpand}
        className="group relative flex items-center gap-3 p-3 pl-3.5 pr-3 rounded-2xl bg-zinc-900/95 backdrop-blur-xl border border-zinc-700/80 hover:border-zinc-600 text-zinc-100 shadow-2xl transition-all duration-200 hover:scale-[1.01] active:scale-[0.99] cursor-pointer select-none"
      >
        {/* Subtle status icon container without aggressive glow */}
        <div className="relative flex items-center justify-center h-8 w-8 rounded-xl bg-zinc-800 border border-zinc-700 shrink-0">
          {isApproval ? (
            <ShieldAlert className="w-4 h-4 text-amber-400" />
          ) : (
            <HelpCircle className="w-4 h-4 text-indigo-400" />
          )}
        </div>

        {/* Main Content Area */}
        <div className="min-w-0 flex-1 pr-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-xs font-semibold text-zinc-100 truncate max-w-[200px]">
              {isApproval ? `需要批准：${toolName}` : `回答提问 (${questionCount} 项)`}
            </span>
            {riskLevel && (
              <Badge variant={riskLevel} size="sm">
                {RISK_LEVEL_LABELS[riskLevel]}
              </Badge>
            )}
            {(interaction.queueLength ?? 1) > 1 && (
              <span className="text-[10px] px-1.5 py-0.5 bg-zinc-800 rounded-full text-zinc-400 border border-zinc-700 font-medium shrink-0">
                1/{interaction.queueLength}
              </span>
            )}
          </div>

          {/* Context Info (Session name & conversation title) */}
          <div className="flex items-center gap-1 text-[11px] text-zinc-400 truncate max-w-[240px]">
            <span className="text-zinc-300 truncate">
              {interaction.sessionName || 'SSH 会话'}
            </span>
            {interaction.conversationTitle && (
              <>
                <span className="text-zinc-600">·</span>
                <span className="truncate text-zinc-400">{interaction.conversationTitle}</span>
              </>
            )}
          </div>
        </div>

        {/* Quick Action Button Group */}
        <div
          className="flex items-center gap-1.5 shrink-0 border-l border-zinc-800 pl-2.5"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 当审批不在当前会话时，提供直接切过去的跳转按钮 */}
          {!isCurrentContext && onNavigateToContext && (
            <button
              type="button"
              onClick={(e) => onNavigateToContext(e)}
              className="px-2 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:scale-95 text-indigo-300 text-xs font-medium border border-zinc-700 transition-all flex items-center gap-1"
              title="切换到该任务所在的会话"
            >
              <span>跳转</span>
            </button>
          )}

          {isApproval && onReject && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReject();
              }}
              className="p-2 rounded-xl bg-zinc-800 hover:bg-red-950/80 hover:text-red-200 hover:border-red-500/40 text-zinc-300 border border-zinc-700 active:scale-95 transition-all"
              title="拒绝"
              aria-label="拒绝"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          {isApproval && onApprove && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onApprove();
              }}
              className="p-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm active:scale-95 transition-all"
              title="批准"
              aria-label="批准"
            >
              <Check className="w-4 h-4" strokeWidth={2.5} />
            </button>
          )}

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExpand();
            }}
            className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700 active:scale-95 transition-all"
            title="展开弹窗"
            aria-label="展开"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
