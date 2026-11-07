import { ChevronDown } from 'lucide-react';
import { useEffect, useCallback, useRef, useState } from 'react';
import type { ToolCallInfo } from '@/lib/types';
import { DISPOSITION_LABELS } from '@/lib/constants';
import Button from '@/components/ui/Button';
import FileChangeView from './FileChangeView';
import { ApprovalWhy } from './ApprovalWhy';
import { ApprovalTarget } from './ApprovalTarget';
import { ApprovalOrigin } from './ApprovalOrigin';
import { ApprovalRejectButton } from './ApprovalRejectButton';
import { cleanExecuteCommandArgs, omitShownHost } from './argumentFormat';
import {
  asArgString,
  fileChangeToolName,
  isLocalExecutionTool,
  isSubagentTool,
  toolSpec,
} from '@/lib/toolCatalog';

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
  /// 点「调整」：收起弹窗并打开设置里对应的风险规则。不传就不显示调整入口。
  onOpenRiskRule?: (ruleId: string) => void;
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
  onOpenRiskRule,
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

  // 参数正文改成 diff 视图（文件修改族 = `approvalView: 'diff'`，编辑与写入都算）。
  // 交给 `FileChangeView` 的工具名必须**从当前调用解析**（catalog 的
  // `fileChangeToolName`，同时校验该行确实声明了 `payload: 'file-change'`）：
  // 以前这里写死 `toolName="edit_file"`，本机编辑会拿自己的 metadata 渲染成
  // 「edit_file 的改动」；写死的字面量也绕过 `FileChangeView` 的 union 检查。
  // 解析不出来（catalog 声明不完整）时 diffTool 为 null，退回原始 JSON —— 宁可
  // 少一个视图，也不拿别的工具的分支渲染。
  const diffTool =
    toolSpec(toolCall.name)?.approvalView === 'diff' ? fileChangeToolName(toolCall.name) : null;
  const isPromptApproval = toolSpec(toolCall.name)?.approvalView === 'prompt';
  const isExecuteCommand = toolSpec(toolCall.name)?.payload === 'command';
  const path = typeof toolCall.arguments?.path === 'string' ? toolCall.arguments.path : '';
  const cleanedCmd = isExecuteCommand ? cleanExecuteCommandArgs(toolCall.arguments) : null;
  // 多机操控：命令带 host = 跨机执行，审批必须醒目提示目标机器（安全护栏）。
  const targetHost =
    typeof toolCall.arguments?.host === 'string' && toolCall.arguments.host.trim()
      ? toolCall.arguments.host.trim()
      : '';
  // 本机工具（`local_*`）：动的是用户自己这台电脑，审批必须点明。判据是**工具名**
  // （catalog 的 `localExecution` 声明），不是参数 —— 参数由模型生成，可以伪造，
  // 拿参数判断「在哪台机器上执行」等于让执行者自己申报。
  const isLocalTool = isLocalExecutionTool(toolCall.name);
  const isLocalSubagent = isLocalTool && isSubagentTool(toolCall.name);
  // 派发出去的指令正文（`local_subagent` 的 prompt）。取不到就**退回原始 JSON**
  // 分支，绝不渲染一个空块把内容藏起来 —— 审批面板的正文块是用户唯一的检查点。
  const promptText = isPromptApproval ? asArgString(toolCall.arguments?.prompt) : undefined;
  const promptDescription = isPromptApproval
    ? asArgString(toolCall.arguments?.description)
    : undefined;
  // 子 agent 运行模式：读写模式能改本机文件 / 跑命令，与只读调研的风险不同 ——
  // 批准前必须能看见。只在参数显式给了 mode 时显示（缺省由后端定，不替它声明）。
  const promptMode = isPromptApproval ? asArgString(toolCall.arguments?.mode) : undefined;
  const promptModeLabel =
    promptMode === 'agent'
      ? '读写执行（可改本机文件、跑命令）'
      : promptMode === 'plan'
        ? '只读调研'
        : promptMode;

  // 命令类工具靠 `$` 提示符就自明了；其余工具（改文件、派发子 agent、其他）要把工具名
  // 放在正文上方，用户才知道自己批的是什么。
  const shownExtras = omitShownHost(cleanedCmd?.extras ?? {}, targetHost);
  const showToolName = !(isExecuteCommand && cleanedCmd?.main);
  const toolNameLine = (
    <div className="flex min-w-0 items-baseline gap-2 text-meta">
      <span className="shrink-0 font-mono text-fg-secondary">{toolCall.name}</span>
      {diffTool && path && (
        <span className="min-w-0 truncate font-mono text-fg-secondary" title={path}>
          {path}
        </span>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="modal-backdrop-enter absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={dismiss}
      />

      {/* 面板整体限高 + 自己滚，标题栏与底部那条（拒绝理由 + 批准 / 拒绝）用
          sticky 钉在上下两端。

          为什么限高管的是整块面板，而不是只给某一个字段加 max-h：外层是
          `fixed inset-0 flex items-center justify-center`（不可滚），面板一旦高于
          视口，超出部分**没有任何滚动条能到达** —— 批准 / 拒绝按钮被顶到屏幕外，
          而 Enter 恰好 = 批准、Esc 只是收起：按钮点不到的时候，键盘上那个「批准」
          还活着，用户可能在没看清内容的情况下把危险操作批下去。会长的不止一处：
          `description`（模型自述，无上限）、`reasons`（原因列表，条数无上限）、
          参数 JSON 与 extras 都是模型给的，任一超长都撑得破。
          底部那条必须 sticky：它是唯一能给出答案的地方，任何长度的正文都不该把
          它推走（背景色与面板同色，滚动时盖住穿过的正文）。

          信息顺序：先是「谁发起的、在哪台机器上跑」两行小字，再是**命令 / 改动本身**，
          最后才是「为什么要问你」。用户要判断的就是前两样，别让它们沉在一堆标签下面。 */}
      <div
        className={`modal-panel-enter relative w-full mx-4 max-h-[85vh] overflow-y-auto rounded-2xl surface-glass ${
          diffTool || promptText ? 'max-w-3xl' : 'max-w-md'
        }`}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-edge bg-surface-raised rounded-t-2xl">
          <div className="flex items-center gap-2">
            <h3 className="text-title text-fg">需要操作批准</h3>
            {/* 普通「请求审批」是这个弹窗的默认含义，不必再标一遍；只有不寻常的档位
                （强制审批）才值得一句提示。纯文字、不套彩色胶囊 —— 颜色留给真正要紧的信号。 */}
            {toolCall.disposition !== 'Approval' && (
              <span className="text-meta font-medium text-amber-300">
                {DISPOSITION_LABELS[toolCall.disposition]}
              </span>
            )}
            {queueLength > 1 && (
              <span className="text-meta tabular-nums text-fg-tertiary">待处理 1/{queueLength}</span>
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
                className="p-1 rounded-lg text-fg-secondary hover:text-fg hover:bg-state-mid transition-colors"
                title="收起为浮动药丸，稍后再处理（不算回答）· Esc"
                aria-label="收起"
              >
                <ChevronDown className="w-4 h-4" strokeWidth={1.5} />
              </button>
            )}
          </div>
        </div>

        <div className="p-4 space-y-3">
          <ApprovalOrigin
            sessionName={sessionName}
            conversationTitle={conversationTitle}
            isCurrentContext={isCurrentContext}
            onNavigateToContext={onNavigateToContext}
          />

          {/* 执行对象声明（安全不可协商：批准打在别机 / 用户自己电脑上的操作，必须
              能看到目标）。判据是工具名，不是参数 —— 见 `isLocalTool` 的注释。 */}
          <ApprovalTarget
            targetHost={targetHost}
            isLocalTool={isLocalTool}
            isLocalSubagent={isLocalSubagent}
          />

          {diffTool ? (
            <div className="space-y-2">
              {toolNameLine}
              <div className="rounded-lg border border-edge overflow-hidden bg-surface">
                <FileChangeView
                  toolName={diffTool}
                  arguments={toolCall.arguments || {}}
                  metadata={toolCall.metadata}
                />
              </div>
            </div>
          ) : promptText?.trim() ? (
            /* 派发给本机子 agent 的完整指令（`local_subagent` 的 prompt）。
               必须整段、可滚动地渲染：这段 prompt 可能整段来自被污染的远端内容
               （网页 / 文件 / 命令输出 / 被注入的上下文），用户只有能读全文，才有
               机会发现「这条指令其实是在让子 agent 干别的事」。所以不截断、
               不折叠、不塞进 JSON 里。 */
            <div className="space-y-2">
              {toolNameLine}
              {promptDescription && (
                <div>
                  <span className="text-meta text-fg-tertiary">任务描述：</span>
                  <p className="mt-1 text-meta leading-relaxed text-fg whitespace-pre-wrap break-words">
                    {promptDescription}
                  </p>
                </div>
              )}
              {promptModeLabel && (
                <div className="text-meta text-fg-tertiary">
                  子 agent 模式：<span className="text-fg-secondary">{promptModeLabel}</span>
                </div>
              )}
              <span className="text-meta text-fg-tertiary">派发给子 agent 的完整指令：</span>
              <pre className="mt-1 p-3 rounded-lg bg-surface-sunken border border-edge font-mono text-meta leading-relaxed text-fg whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
                {promptText}
              </pre>
            </div>
          ) : isExecuteCommand && cleanedCmd?.main ? (
            <div className="space-y-2">
              <div className="rounded-lg bg-surface-sunken border border-edge overflow-hidden">
                <div className="flex items-start gap-2 px-3 py-2">
                  <span className="text-fg-tertiary font-mono text-meta select-none leading-relaxed">$</span>
                  <code className="flex-1 min-w-0 font-mono text-meta text-fg whitespace-pre-wrap break-words leading-relaxed">
                    {cleanedCmd.main}
                  </code>
                </div>
                {Object.keys(shownExtras).length > 0 && (
                  <pre className="px-3 py-2 border-t border-edge/60 font-mono text-caption text-fg-secondary whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                    {JSON.stringify(shownExtras, null, 2)}
                  </pre>
                )}
              </div>
              {/* agent 对这条命令的说明，放在命令**下面**：先读命令本身，再看它怎么说。
                  标注来源是刻意的：它可能把一条危险命令说成「只读检查」，写清这是
                  agent 自述，用户才不会把它当成系统判定。 */}
              {cleanedCmd.description && (
                <p className="px-0.5 text-meta leading-relaxed text-fg-secondary whitespace-pre-wrap break-words">
                  <span className="text-fg-tertiary">Agent 自述：</span>
                  {cleanedCmd.description}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {showToolName && toolNameLine}
              <pre className="p-2 rounded-lg bg-surface text-meta text-fg-secondary overflow-auto max-h-40 whitespace-pre-wrap break-words">
                {JSON.stringify(toolCall.arguments, null, 2)}
              </pre>
            </div>
          )}

          <ApprovalWhy
            reasons={toolCall.reasons}
            ruleIds={toolCall.ruleIds}
            onOpenRule={onOpenRiskRule}
          />
        </div>

        <div className="sticky bottom-0 z-10 px-4 py-3 border-t border-edge bg-surface-raised rounded-b-2xl">
          {/* 拒绝理由：可选，但填了模型才有依据调整方向（不然它只会换个写法再来）。
              与两个答案同一行，底栏只占一行。 */}
          <div className="flex items-center gap-2">
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
              placeholder="拒绝原因（可选，会告诉 Agent）"
              aria-label="拒绝原因"
              className="min-w-0 flex-1 rounded-lg bg-surface border border-edge px-3 py-1.5 text-read text-fg placeholder:text-fg-tertiary focus-ring focus:border-indigo-500"
            />
            <ApprovalRejectButton
              onReject={() => onReject(reason.trim() || undefined)}
              onRejectAndStop={
                onRejectAndStop ? () => onRejectAndStop(reason.trim() || undefined) : undefined
              }
            />
            {/* 快捷键提示放在按钮里（⏎ 由伪元素画，不进按钮文字）：Enter = 批准。 */}
            <Button
              variant="primary"
              onClick={onApprove}
              aria-keyshortcuts="Enter"
              title="批准（Enter）"
              className="after:content-['⏎'] after:text-caption after:opacity-60"
            >
              批准
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
