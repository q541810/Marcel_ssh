import type { ToolCallInfo } from '@/lib/types';
import { RISK_LEVEL_LABELS } from '@/lib/constants';
import FileChangeView from '@/components/agent/FileChangeView';
import MobileSheet from './ui/MobileSheet';

interface MobileApprovalSheetProps {
  toolCall: ToolCallInfo;
  open: boolean;
  onApprove: () => void;
  onReject: () => void;
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
}: MobileApprovalSheetProps) {
  const isEditFile = toolCall.name === 'edit_file';
  const path =
    typeof toolCall.arguments?.path === 'string' ? toolCall.arguments.path : '';
  const riskTone = RISK_TONE[toolCall.riskLevel] ?? RISK_TONE.Moderate;

  return (
    <MobileSheet
      open={open}
      onClose={onReject}
      dismissible={false}
      title={
        <span className="flex items-center gap-2">
          需要操作批准
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${riskTone}`}
          >
            {RISK_LEVEL_LABELS[toolCall.riskLevel]}
          </span>
        </span>
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
        ) : (
          <div>
            <div className="mb-1 text-xs text-zinc-500">参数</div>
            <pre className="max-h-48 overflow-auto rounded-lg bg-zinc-950 p-2 font-mono text-xs leading-relaxed text-zinc-300">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </MobileSheet>
  );
}
