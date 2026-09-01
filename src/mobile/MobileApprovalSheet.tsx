import type { ToolCallInfo } from '@/lib/types';
import { RISK_LEVEL_LABELS } from '@/lib/constants';
import FileChangeView from '@/components/agent/FileChangeView';
import MobileSheet from './ui/MobileSheet';
import { cleanExecuteCommandArgs } from '@/components/agent/argumentFormat';

interface MobileApprovalSheetProps {
  toolCall: ToolCallInfo;
  open: boolean;
  onApprove: () => void;
  onReject: () => void;
  sessionName?: string;
  conversationTitle?: string;
  isCurrentContext?: boolean;
  onNavigateToContext?: (e?: React.MouseEvent) => void;
  queueLength?: number;
  onMinimize?: (e?: React.MouseEvent) => void;
}

const RISK_TONE: Record<string, string> = {
  ReadOnly: 'bg-zinc-700/60 text-zinc-300',
  LowRisk: 'bg-emerald-500/15 text-emerald-300',
  Moderate: 'bg-amber-500/15 text-amber-300',
  HighRisk: 'bg-orange-500/15 text-orange-300',
  Destructive: 'bg-red-500/15 text-red-300',
};

/**
 * Bottom-sheet approval for the mobile shell. Deliberately NOT dismissible by
 * backdrop/swipe: an approval must be an explicit approve or reject decision.
 */
export default function MobileApprovalSheet({
  toolCall,
  open,
  onApprove,
  onReject,
  sessionName,
  conversationTitle,
  isCurrentContext = true,
  onNavigateToContext,
  queueLength = 1,
  onMinimize,
}: MobileApprovalSheetProps) {
  const isEditFile = toolCall.name === 'edit_file';
  const isExecuteCommand = toolCall.name === 'bash' || toolCall.name === 'execute_command';
  const path =
    typeof toolCall.arguments?.path === 'string' ? toolCall.arguments.path : '';
  const cleanedCmd = isExecuteCommand ? cleanExecuteCommandArgs(toolCall.arguments) : null;
  const riskTone = RISK_TONE[toolCall.riskLevel] ?? RISK_TONE.Moderate;

  return (
    <MobileSheet
      open={open}
      onClose={onReject}
      dismissible={false}
      title={
        <div className="flex items-center justify-between w-full pr-6">
          <span className="flex items-center gap-2">
            需要操作批准
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${riskTone}`}
            >
              {RISK_LEVEL_LABELS[toolCall.riskLevel]}
            </span>
          </span>
          <div className="flex items-center gap-2">
            {queueLength > 1 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-900/60 border border-indigo-700/50 text-indigo-300 font-medium">
                1/{queueLength}
              </span>
            )}
            {onMinimize && (
              <button
                type="button"
                onClick={onMinimize}
                className="p-1 rounded-lg text-zinc-400 active:text-zinc-200 active:bg-zinc-800"
                title="收起为浮动条"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      }
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onReject}
            className="flex-1 rounded-xl bg-zinc-800 px-4 py-3 text-sm font-medium text-zinc-200 active:bg-zinc-700"
          >
            拒绝
          </button>
          <button
            type="button"
            onClick={onApprove}
            className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white active:bg-indigo-500"
          >
            批准
          </button>
        </div>
      }
    >
      <div className="space-y-3 px-4 pb-3">
        {/* 上下文提示 (Context Banner) */}
        {(sessionName || conversationTitle) && (
          <div className="p-2.5 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-between gap-2">
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
                className="shrink-0 text-xs px-2.5 py-1 rounded-lg bg-indigo-600/30 active:bg-indigo-600/50 text-indigo-300 border border-indigo-500/40 font-medium"
              >
                跳转
              </button>
            )}
          </div>
        )}

        {toolCall.reasons && toolCall.reasons.length > 0 && (
          <div className="rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2">
            <div className="mb-1 text-xs font-medium text-amber-300">
              模型提示
            </div>
            <ul className="list-inside list-disc space-y-0.5 text-xs text-amber-200/90">
              {toolCall.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center gap-2 text-sm">
          <span className="flex-shrink-0 text-zinc-500">工具</span>
          <span className="truncate font-mono text-zinc-200">
            {toolCall.name}
          </span>
        </div>

        {isEditFile ? (
          <div className="space-y-2">
            {path && (
              <div className="break-all font-mono text-xs text-zinc-300">
                {path}
              </div>
            )}
            <div className="overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950">
              <div className="overflow-x-auto">
                <FileChangeView
                  toolName="edit_file"
                  arguments={toolCall.arguments || {}}
                  metadata={toolCall.metadata}
                />
              </div>
            </div>
          </div>
        ) : isExecuteCommand && cleanedCmd?.main ? (
          <div>
            <div className="mb-1 text-xs text-zinc-500">参数</div>
            <div className="overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950">
              <div className="flex items-start gap-2 px-3 py-2">
                <span className="select-none font-mono text-xs leading-relaxed text-emerald-400">$</span>
                <code className="min-w-0 flex-1 break-words whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-200">
                  {cleanedCmd.main}
                </code>
              </div>
              {Object.keys(cleanedCmd.extras).length > 0 && (
                <pre className="max-h-40 overflow-y-auto border-t border-zinc-700/60 px-3 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-zinc-400">
                  {JSON.stringify(cleanedCmd.extras, null, 2)}
                </pre>
              )}
            </div>
          </div>
        ) : (
          <div>
            <div className="mb-1 text-xs text-zinc-500">参数</div>
            <pre className="max-h-48 overflow-auto rounded-lg bg-zinc-950 p-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-zinc-300">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </MobileSheet>
  );
}
