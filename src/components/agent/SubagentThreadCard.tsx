import { memo } from 'react';
import { Eye } from 'lucide-react';
import type { AgentMessage } from '@/lib/types';
import { isAskParentTool, toolDisplayName } from '@/lib/toolCatalog';
import type { SubagentThread, ThreadItem } from '@/lib/subagentThread';
import { openSubConversation } from '@/lib/subagentNav';
import { useConversationStore } from '@/stores/conversationStore';
import { ToolCardFrame, ToolChip } from './toolCardChrome';
import { useMessageViewState } from './messageViewState';

/** 子对话里已经执行的步骤数（工具调用条数，不含 ask_parent）。对话没加载时是 0。 */
function useSubStepCount(subConversationId: string): number {
  return useConversationStore((s) => {
    const msgs = s.messages[subConversationId];
    if (!msgs) return 0;
    let n = 0;
    for (const m of msgs) {
      if (m.role === 'tool' && m.toolResult && !isAskParentTool(m.toolResult.toolName)) n += 1;
    }
    return n;
  });
}

/** 时间线上的一行文字：灰色标签 + 正文，和工具卡展开后的文字同一档（无气泡、无色块）。 */
function Row({ label, text, testId }: { label: string; text: string; testId?: string }) {
  return (
    <div className="min-w-0 text-[13px] leading-5" data-testid={testId}>
      <span className="text-zinc-500">{label}：</span>
      <span className="whitespace-pre-wrap break-words text-zinc-300 [overflow-wrap:anywhere]">{text}</span>
    </div>
  );
}

function AskRow({ item }: { item: Extract<ThreadItem, { kind: 'ask' }> }) {
  return (
    <div className="min-w-0" data-testid="thread-ask">
      <Row label="问" text={item.question} />
      {item.context && (
        <details className="text-[12px] text-zinc-500">
          <summary className="cursor-pointer select-none py-0.5 hover:text-zinc-300 [@media(pointer:coarse)]:py-1.5">背景信息</summary>
          <p className="whitespace-pre-wrap break-words pb-0.5 text-zinc-400 [overflow-wrap:anywhere]">{item.context}</p>
        </details>
      )}
      {item.state === 'waiting' && <div className="text-[12px] leading-5 text-zinc-500">等待回答</div>}
      {item.state === 'unanswered' && <div className="text-[12px] leading-5 text-zinc-500">未回答</div>}
    </div>
  );
}

function OutcomeRow({ item, steps }: { item: Extract<ThreadItem, { kind: 'outcome' }>; steps: number }) {
  const label =
    item.state === 'running' ? '继续中…'
      : item.state === 'completed' ? '已完成'
        : item.state === 'failed' ? '失败'
          : '已取消';
  return (
    <div className="min-w-0">
      <div className="text-[13px] leading-5 text-zinc-300">
        {label}
        {steps > 0 && <span className="ml-1.5 text-zinc-500">已执行 {steps} 步</span>}
      </div>
      {item.state !== 'running' && item.result.trim() !== '' && (
        <details className="text-[12px] text-zinc-500">
          <summary className="cursor-pointer select-none py-0.5 hover:text-zinc-300 [@media(pointer:coarse)]:py-1.5">查看结果</summary>
          <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono leading-relaxed text-zinc-400 [overflow-wrap:anywhere]">{item.result}</pre>
        </details>
      )}
    </div>
  );
}

/** 折叠行末尾的状态：和普通工具行一个口径——正常不说话，只有要交代的才用一小段字。 */
function trailingStatus(state: SubagentThread['state']) {
  switch (state) {
    case 'waiting':
      return <span className="flex-shrink-0 whitespace-nowrap text-xs text-zinc-500">等待回答</span>;
    case 'unanswered':
      return <span className="flex-shrink-0 whitespace-nowrap text-xs text-zinc-500">未回答</span>;
    case 'failed':
      return <span className="flex-shrink-0 whitespace-nowrap text-xs font-medium text-red-400">失败</span>;
    case 'cancelled':
      return <span className="flex-shrink-0 whitespace-nowrap text-xs font-medium text-amber-400">已中断</span>;
    default:
      return undefined; // running 由转圈表示，completed 什么都不说
  }
}

interface Props {
  message: AgentMessage;
  thread: SubagentThread;
  grouped?: boolean;
}

/**
 * 子 agent 时间线卡：同一个子对话的「派活 → 提问 → 回答 → 继续 → 完成」并成一张卡。
 *
 * **默认折叠成一行，长得和普通子 agent 工具行一模一样**（同一副 `ToolCardFrame`、同样的
 * 「子 Agent · 任务名」），只多一个灰色小标记「问过 N 次」——过程是细节，要看才点开；
 * 状态也用普通工具行的口径：运行中转圈、等回答时行尾一小段灰字「等待回答」、失败 / 中断
 * 才有红 / 黄字。展开后是缩进的纯文字时间线（问：… 答：…），没有气泡、没有色块。
 * 分组逻辑在 `lib/subagentThread`，这里只负责画。桌面手机共用同一个组件。
 */
function SubagentThreadCard({ message, thread, grouped }: Props) {
  const [expanded, setExpanded] = useMessageViewState('thread-expanded', false);
  const steps = useSubStepCount(thread.subConversationId);
  const toolName = message.toolResult?.toolName ?? 'subagent';
  const { display } = toolDisplayName(toolName);
  const running = thread.state === 'running';
  // 步骤数只挂在最后一个收尾行上（它描述的是子 agent 当前走到哪了）
  const lastOutcome = [...thread.items].reverse().find((i) => i.kind === 'outcome');
  const watchLabel = running ? '查看实时调研过程 →' : '查看完整调研过程 →';
  const watchButton = (
    <button
      type="button"
      onClick={() => void openSubConversation(thread.subConversationId)}
      className="flex items-center gap-1.5 pt-0.5 text-xs font-medium text-sky-400 transition-colors hover:text-sky-300 [@media(pointer:coarse)]:min-h-8"
    >
      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
      {watchLabel}
    </button>
  );

  return (
    <div className={`flex min-w-0 justify-start ${grouped ? 'pl-3' : ''}`}>
      <div className="min-w-0 w-full max-w-[92%]" data-testid="subagent-thread">
        <ToolCardFrame
          toolName={toolName}
          label={display}
          preview={thread.title}
          busy={running}
          expanded={expanded}
          onToggle={() => !running && setExpanded((v) => !v)}
          chips={
            thread.askCount > 0
              ? <ToolChip title={`子 Agent 问过 ${thread.askCount} 次`}>问过 {thread.askCount} 次</ToolChip>
              : undefined
          }
          trailing={trailingStatus(thread.state)}
        >
          {/* 运行中：和普通子 agent 行一样，实时过程的入口不用展开就在 */}
          {running && !expanded && (
            <div className="ml-3 min-w-0 border-l border-edge/50 py-1 pl-3 pr-1.5">{watchButton}</div>
          )}
          {expanded && (
            <div className="ml-3 min-w-0 space-y-1 border-l border-edge/50 py-1.5 pl-3 pr-1.5">
              {thread.items.map((item, i) => {
                switch (item.kind) {
                  case 'dispatch': return <Row key={i} label="派活" text={item.text} />;
                  case 'followUp': return <Row key={i} label="追问" text={item.text} />;
                  case 'ask': return <AskRow key={i} item={item} />;
                  case 'answer': return <Row key={i} label="答" text={item.text} testId="thread-answer" />;
                  case 'outcome': return <OutcomeRow key={i} item={item} steps={item === lastOutcome ? steps : 0} />;
                }
              })}
              {watchButton}
            </div>
          )}
        </ToolCardFrame>
      </div>
    </div>
  );
}

export default memo(SubagentThreadCard);
