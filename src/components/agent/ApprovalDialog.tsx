import { useEffect, useCallback, useRef, useState } from 'react';
import type { ToolCallInfo } from '@/lib/types';
import { DISPOSITION_LABELS } from '@/lib/constants';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import FileChangeView from './FileChangeView';
import { cleanExecuteCommandArgs } from './argumentFormat';
import { toolSpec } from '@/lib/toolCatalog';

interface Props {
  toolCall: ToolCallInfo;
  onApprove: () => void;
  /// 拒绝。`reason` 是用户填写的理由（可空），会原样转达给模型 —— 不说理由时
  /// 模型只知道"被拒了"，于是换个写法再试，用户被迫反复拒绝。
  onReject: (reason?: string) => void;
  /// 拒绝并把整个任务停掉（用户压根不想让它继续试）。
  onRejectAndStop?: (reason?: string) => void;
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
  onRejectAndStop,
  open,
  onClose,
  sessionName,
  conversationTitle,
  isCurrentContext = true,
  onNavigateToContext,
  queueLength = 1,
  onMinimize,
}: Props) {
  // 队首切换按键冷却（300ms）：防止连击 Enter 误批下一条刚切换的高危操作
  const [reason, setReason] = useState('');
  const mountedAtRef = useRef<number>(Date.now());
  const reasonInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    mountedAtRef.current = Date.now();
    // 队首换成下一条时理由必须清空 —— 理由是给「那条命令」的，留在框里就会
    // 原样发给下一条（它是同一个组件实例，只有 mountedAtRef 在重置）。
    setReason('');
  }, [toolCall.id]);

  // 收起伏笔（点背景 / Esc）—— **只把弹窗收起来，不回答**。
  //
  // 这两条以前都接到 `onClose`，而调用方（`GlobalInteractionOverlay`）把 `onClose`
  // 映射成了 `reject`：一次误触就替用户判了「拒绝」，而且**不可逆** —— 模型收到
  // 「用户拒绝」就换方案走了，用户甚至没意识到自己做了一个决定。
  // 审批是安全决定，答案只能由显式按钮给出；其余一切告别方式都该是可撤销的
  // 「先放一边」（收成右下角浮动药丸，随时点得回来）。
  const dismiss = useCallback(() => {
    if (onMinimize) {
      onMinimize();
    } else {
      onClose();
    }
  }, [onMinimize, onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!open) return;
      // 只有焦点在**这个弹窗自己的**理由输入框里时，键盘才交给它
      // （Enter = 拒绝并提交理由、Esc = 收起）。不能放宽到「任何 input」：
      // 这个监听器挂在 document 上，一旦放宽，用户刚在别处输入框打完字时
      // 弹窗一到，Enter 和 Esc 就都失效，而弹窗还在提示那两个键能用。
      const target = e.target as HTMLElement | null;
      if (reasonInputRef.current && target && reasonInputRef.current.contains(target)) {
        return;
      }
      if (e.key === 'Enter') {
        if (Date.now() - mountedAtRef.current < 300) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        onApprove();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      }
    },
    [open, onApprove, dismiss],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!open) return null;

  const isEditFile = toolSpec(toolCall.name)?.approvalView === 'diff';
  const isExecuteCommand = toolSpec(toolCall.name)?.payload === 'command';
  const path = typeof toolCall.arguments?.path === 'string' ? toolCall.arguments.path : '';
  const cleanedCmd = isExecuteCommand ? cleanExecuteCommandArgs(toolCall.arguments) : null;
  // 多机操控：命令带 host = 跨机执行，审批必须醒目提示目标机器（安全护栏）。
  const targetHost =
    typeof toolCall.arguments?.host === 'string' && toolCall.arguments.host.trim()
      ? toolCall.arguments.host.trim()
      : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="modal-backdrop-enter absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={dismiss}
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
            {/* 这里曾经还有一个 ✕ 关闭按钮，接到 onClose → 被调用方映射成「拒绝」。
                在一个只有两个答案的对话框上，「关闭」到底算哪个答案本来就说不清，
                它是第三个含义不明的出口。现在只剩：标题栏这个明确的「收起」，
                以及底部两个明确的答案。 */}
            {onMinimize && (
              <button
                type="button"
                onClick={onMinimize}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                title="收起为浮动药丸，稍后再处理（不算回答）"
                aria-label="收起"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
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

        {/* 多机操控：跨机执行的目标机器警示（安全不可协商：批准打在别机的
            命令必须能看到目标） */}
        {targetHost && (
          <div className="mx-4 mt-3 rounded-xl border border-amber-600/70 bg-amber-950/50 px-3 py-2.5 flex items-center gap-2.5">
            <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9m0 0h2.5M12 9h-2.5" />
            </svg>
            <div className="text-xs text-amber-200 min-w-0">
              <span className="font-semibold text-amber-300">目标机器：{targetHost}</span>
              <span className="text-amber-200/80"> · 此操作将在该机器上执行（非当前会话）</span>
            </div>
          </div>
        )}

        <div className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-zinc-400">处置：</span>
            <Badge variant={toolCall.disposition} size="md">
              {DISPOSITION_LABELS[toolCall.disposition]}
            </Badge>
            {toolCall.disposition === 'ForceApproval' && (
              <span className="text-xs text-orange-300/90">
                Auto 模式下也会询问
              </span>
            )}
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
              {/* agent 对这条命令的说明。标注来源是刻意的：它可能把一条危险命令
                  说成「只读检查」，写清这是 agent 自述，用户才不会把它当成系统判定。 */}
              {cleanedCmd.description && (
                <div>
                  <span className="text-sm text-zinc-400">Agent 说明：</span>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-200 whitespace-pre-wrap break-words">
                    {cleanedCmd.description}
                  </p>
                </div>
              )}
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
              收起
            </span>
          </div>
        </div>

        <div className="p-4 border-t border-zinc-700 space-y-3">
          {/* 拒绝理由：可选，但填了模型才有依据调整方向（不然它只会换个写法再来） */}
          <input
            ref={reasonInputRef}
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                // 与「批准」同款的队首冷却：刚切到下一条时，这次 Enter 很可能
                // 是想批上一条时连击出来的，别顺手再拒绝一条。
                if (Date.now() - mountedAtRef.current < 300) return;
                onReject(reason.trim() || undefined);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                dismiss();
              }
            }}
            placeholder="可选：说明拒绝原因，会转达给 Agent"
            aria-label="拒绝原因"
            className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500"
          />
          <div className="flex items-center justify-between gap-2">
            {onRejectAndStop ? (
              <button
                type="button"
                onClick={() => onRejectAndStop(reason.trim() || undefined)}
                className="text-xs text-zinc-500 hover:text-red-400 transition-colors"
                title="拒绝这次调用，并停止整个任务（Agent 不会再继续尝试）"
              >
                拒绝并停止任务
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => onReject(reason.trim() || undefined)}>
                拒绝
              </Button>
              <Button variant="primary" onClick={onApprove}>
                批准
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
