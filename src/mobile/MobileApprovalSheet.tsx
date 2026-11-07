import { useEffect, useState } from 'react';
import type { ToolCallInfo } from '@/lib/types';
import { DISPOSITION_LABELS } from '@/lib/constants';
import FileChangeView from '@/components/agent/FileChangeView';
import { ApprovalWhy } from '@/components/agent/ApprovalWhy';
import { ApprovalTarget } from '@/components/agent/ApprovalTarget';
import { ApprovalOrigin } from '@/components/agent/ApprovalOrigin';
import { ApprovalRejectButton } from '@/components/agent/ApprovalRejectButton';
import MobileSheet from './ui/MobileSheet';
import { cleanExecuteCommandArgs, omitShownHost } from '@/components/agent/argumentFormat';
import {
  asArgString,
  fileChangeToolName,
  isLocalExecutionTool,
  isSubagentTool,
  toolSpec,
} from '@/lib/toolCatalog';

interface MobileApprovalSheetProps {
  toolCall: ToolCallInfo;
  open: boolean;
  onApprove: () => void;
  /// 拒绝。`reason` 是用户填写的理由（可空），会原样转达给模型 —— 不说理由时
  /// 模型只知道"被拒了"，于是换个写法再试，用户被迫反复拒绝。
  onReject: (reason?: string) => void;
  /// 拒绝并把整个任务停掉（用户压根不想让它继续试）。
  onRejectAndStop?: (reason?: string) => void;
  sessionName?: string;
  conversationTitle?: string;
  isCurrentContext?: boolean;
  onNavigateToContext?: (e?: React.MouseEvent) => void;
  queueLength?: number;
  onMinimize?: (e?: React.MouseEvent) => void;
  /// 点「调整」：收起面板并打开设置里对应的风险规则。不传就不显示调整入口。
  onOpenRiskRule?: (ruleId: string) => void;
}

/**
 * Bottom-sheet approval for the mobile shell. Deliberately NOT dismissible by
 * backdrop/swipe: an approval must be an explicit approve or reject decision.
 */
export default function MobileApprovalSheet({
  toolCall,
  open,
  onApprove,
  onReject,
  onRejectAndStop,
  sessionName,
  conversationTitle,
  isCurrentContext = true,
  onNavigateToContext,
  queueLength = 1,
  onMinimize,
  onOpenRiskRule,
}: MobileApprovalSheetProps) {
  const [reason, setReason] = useState('');
  // 队首换成下一条时理由必须清空 —— 理由是给「那条命令」的，留在框里就会原样
  // 发给下一条（队列前进时是同一个组件实例，状态不会被重置）。
  useEffect(() => {
    setReason('');
  }, [toolCall.id]);
  // 参数正文改成 diff 视图（文件修改族 = `approvalView: 'diff'`，编辑与写入都算）。
  // 交给 `FileChangeView` 的工具名必须**从当前调用解析**（catalog 的
  // `fileChangeToolName`，同时校验该行确实声明了 `payload: 'file-change'`）：以前
  // 这里写死 `toolName="edit_file"`，本机编辑会拿自己的 metadata 渲染成
  // 「edit_file 的改动」；写死的字面量也绕过 `FileChangeView` 的 union 检查。
  // 解析不出来（catalog 声明不完整）时 diffTool 为 null，退回原始 JSON —— 宁可
  // 少一个视图，也不拿别的工具的分支渲染。桌面端 `ApprovalDialog` 同一条口径。
  const diffTool =
    toolSpec(toolCall.name)?.approvalView === 'diff' ? fileChangeToolName(toolCall.name) : null;
  const isPromptApproval = toolSpec(toolCall.name)?.approvalView === 'prompt';
  const isExecuteCommand = toolSpec(toolCall.name)?.payload === 'command';
  const path =
    typeof toolCall.arguments?.path === 'string' ? toolCall.arguments.path : '';
  const cleanedCmd = isExecuteCommand ? cleanExecuteCommandArgs(toolCall.arguments) : null;
  // 多机操控：命令带 host = 跨机执行，审批必须醒目提示目标机器（安全护栏）。
  const targetHost =
    typeof toolCall.arguments?.host === 'string' && toolCall.arguments.host.trim()
      ? toolCall.arguments.host.trim()
      : '';
  // 本机工具（`local_*`）：动的是用户自己这台电脑（桌面侧能力；手机端目前没有
  // 本机文件/命令工具，这一段是为两端呈现契约一致 + 将来接上时不漏安全带）。
  // 判据是**工具名**（catalog 的 `localExecution` 声明），不是参数：参数由模型
  // 生成，可以伪造。
  const isLocalTool = isLocalExecutionTool(toolCall.name);
  const isLocalSubagent = isLocalTool && isSubagentTool(toolCall.name);
  // 派发出去的指令正文（`local_subagent` 的 prompt）。取不到就**退回原始 JSON**
  // 分支，绝不渲染空块把内容藏起来 —— 审批面板的正文块是用户唯一的检查点。
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
  const toolNameLine = (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-meta">
      <span className="shrink-0 font-mono text-fg-secondary">{toolCall.name}</span>
      {diffTool && path && <span className="break-all font-mono text-fg-secondary">{path}</span>}
    </div>
  );

  return (
    <MobileSheet
      open={open}
      onClose={onReject}
      dismissible={false}
      title={
        <div className="flex items-center justify-between w-full pr-6">
          <span className="flex items-center gap-2">
            需要操作批准
            {/* 普通「请求审批」是这个面板的默认含义，不必再标一遍；只有不寻常的档位
                （强制审批）才值得一枚标签。 */}
            {toolCall.disposition !== 'Approval' && (
              <span className="text-meta font-medium text-amber-300">
                {DISPOSITION_LABELS[toolCall.disposition]}
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            {queueLength > 1 && (
              <span className="text-meta tabular-nums text-fg-tertiary">1/{queueLength}</span>
            )}
            {onMinimize && (
              <button
                type="button"
                onClick={onMinimize}
                className="p-1 rounded-lg text-fg-secondary active:text-fg active:bg-state-soft"
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
        <div className="space-y-2">
          {/* 拒绝理由：可选，但填了模型才有依据调整方向 */}
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="拒绝原因（可选，会告诉 Agent）"
            aria-label="拒绝原因"
            className="w-full rounded-xl bg-surface border border-edge px-3 py-2.5 text-body text-fg placeholder:text-fg-tertiary focus:outline-none focus:border-edge-strong"
          />
          <div className="flex gap-2">
            <ApprovalRejectButton
              touch
              className="flex-1"
              onReject={() => onReject(reason.trim() || undefined)}
              onRejectAndStop={
                onRejectAndStop ? () => onRejectAndStop(reason.trim() || undefined) : undefined
              }
            />
            <button
              type="button"
              onClick={onApprove}
              className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-body font-medium text-white active:bg-indigo-500"
            >
              批准
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3 px-4 pb-3">
        <ApprovalOrigin
          sessionName={sessionName}
          conversationTitle={conversationTitle}
          isCurrentContext={isCurrentContext}
          onNavigateToContext={onNavigateToContext}
          compact
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
            <div className="overflow-hidden rounded-lg border border-edge bg-surface-sunken">
              <div className="overflow-x-auto">
                <FileChangeView
                  toolName={diffTool}
                  arguments={toolCall.arguments || {}}
                  metadata={toolCall.metadata}
                />
              </div>
            </div>
          </div>
        ) : promptText?.trim() ? (
          /* 派发给本机子 agent 的完整指令（`local_subagent` 的 prompt）。必须整段、
             可滚动地渲染：这段 prompt 可能整段来自被污染的远端内容（网页 / 文件 /
             命令输出 / 被注入的上下文），用户只有能读全文，才有机会发现「这条指令
             其实是在让子 agent 干别的事」。所以不截断、不折叠、不塞进 JSON 里。 */
          <div className="space-y-2">
            {toolNameLine}
            {promptDescription && (
              <div>
                <div className="mb-1 text-meta text-fg-tertiary">任务描述</div>
                <p className="text-meta leading-relaxed break-words whitespace-pre-wrap text-fg">
                  {promptDescription}
                </p>
              </div>
            )}
            {promptModeLabel && (
              <div className="text-meta text-fg-tertiary">
                子 agent 模式：<span className="text-fg-secondary">{promptModeLabel}</span>
              </div>
            )}
            <div className="mb-1 text-meta text-fg-tertiary">派发给子 agent 的完整指令</div>
            <pre className="max-h-80 overflow-y-auto rounded-lg border border-edge bg-surface-sunken p-3 font-mono text-meta leading-relaxed break-words whitespace-pre-wrap text-fg">
              {promptText}
            </pre>
          </div>
        ) : isExecuteCommand && cleanedCmd?.main ? (
          <div className="space-y-2">
            <div className="overflow-hidden rounded-lg border border-edge bg-surface-sunken">
              <div className="flex items-start gap-2 px-3 py-2">
                <span className="select-none font-mono text-meta leading-relaxed text-fg-tertiary">$</span>
                <code className="min-w-0 flex-1 break-words whitespace-pre-wrap font-mono text-meta leading-relaxed text-fg">
                  {cleanedCmd.main}
                </code>
              </div>
              {Object.keys(shownExtras).length > 0 && (
                <pre className="max-h-40 overflow-y-auto border-t border-edge/60 px-3 py-2 font-mono text-caption leading-relaxed break-words whitespace-pre-wrap text-fg-secondary">
                  {JSON.stringify(shownExtras, null, 2)}
                </pre>
              )}
            </div>
            {/* agent 对这条命令的说明，放在命令**下面**：先读命令本身，再看它怎么说。
                标注来源是刻意的：它可能把一条危险命令说成「只读检查」，写清这是
                agent 自述，用户才不会把它当成系统判定。 */}
            {cleanedCmd.description && (
              <p className="px-0.5 text-meta leading-relaxed break-words whitespace-pre-wrap text-fg-secondary">
                <span className="text-fg-tertiary">Agent 自述：</span>
                {cleanedCmd.description}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {toolNameLine}
            <pre className="max-h-48 overflow-auto rounded-lg bg-surface-sunken p-2 font-mono text-meta leading-relaxed break-words whitespace-pre-wrap text-fg-secondary">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>
        )}

        <ApprovalWhy
          reasons={toolCall.reasons}
          ruleIds={toolCall.ruleIds}
          onOpenRule={onOpenRiskRule}
          compact
        />
      </div>
    </MobileSheet>
  );
}
