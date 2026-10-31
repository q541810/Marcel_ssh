import { memo } from 'react';
import { CircleHelp, Eye, Reply } from 'lucide-react';
import type { AgentMessage } from '@/lib/types';
import { isAskParentTool, toolDisplayName } from '@/lib/toolCatalog';
import { threadStateLabel, type SubagentThread, type ThreadItem } from '@/lib/subagentThread';
import { openSubConversation } from '@/lib/subagentNav';
import { useConversationStore } from '@/stores/conversationStore';
import { ToolCardFrame, ToolChip, type ToolChipTone } from './toolCardChrome';
import { useMessageViewState } from './messageViewState';

const STATE_TONE: Record<SubagentThread['state'], ToolChipTone> = {
  running: 'info',
  waiting: 'info',
  unanswered: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'warning',
};

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

type DotTone = 'muted' | 'sky' | 'amber' | 'emerald' | 'red';

/** 时间线上一行的左侧小圆点。 */
function Dot({ tone }: { tone: DotTone }) {
  const cls = {
    muted: 'bg-zinc-500',
    sky: 'bg-sky-400',
    amber: 'bg-amber-400',
    emerald: 'bg-emerald-400',
    red: 'bg-red-400',
  }[tone];
  return <span className={`mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full ${cls}`} aria-hidden="true" />;
}

function PlainRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2 text-[13px] leading-5">
      <Dot tone="muted" />
      <div className="min-w-0 flex-1">
        <span className="mr-1.5 text-zinc-500">{label}</span>
        <span className="break-words text-zinc-300 [overflow-wrap:anywhere]">{text}</span>
      </div>
    </div>
  );
}

/** 提问气泡（子 agent 说的话）：和步骤行区分开——有底、有边、带问号。 */
function AskBubble({ item }: { item: Extract<ThreadItem, { kind: 'ask' }> }) {
  return (
    <div className="flex min-w-0 items-start gap-2" data-testid="thread-ask">
      <Dot tone={item.state === 'unanswered' ? 'amber' : 'sky'} />
      <div className="min-w-0 max-w-[92%] rounded-xl rounded-tl-sm border border-sky-500/25 bg-sky-500/10 px-3 py-2">
        <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-sky-300">
          <CircleHelp className="h-3 w-3" aria-hidden="true" />
          提问
          {item.state === 'waiting' && <span className="font-normal text-sky-300/80">· 等待主 Agent 回答</span>}
          {item.state === 'unanswered' && <span className="font-normal text-amber-300">· 未回答</span>}
        </div>
        <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-zinc-200 [overflow-wrap:anywhere]">{item.question}</p>
        {item.context && (
          <details className="mt-1 text-[12px] text-zinc-400">
            <summary className="cursor-pointer select-none py-0.5 hover:text-zinc-300 [@media(pointer:coarse)]:py-1.5">背景信息</summary>
            <p className="whitespace-pre-wrap break-words pb-0.5 [overflow-wrap:anywhere]">{item.context}</p>
          </details>
        )}
      </div>
    </div>
  );
}

/** 回答气泡（主 agent 说的话）：靠右缩进、靛色，和提问气泡成一问一答。 */
function AnswerBubble({ text }: { text: string }) {
  return (
    <div className="flex min-w-0 justify-end pl-6" data-testid="thread-answer">
      <div className="min-w-0 max-w-[92%] rounded-xl rounded-tr-sm border border-indigo-500/25 bg-indigo-500/10 px-3 py-2">
        <div className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-indigo-300">
          <Reply className="h-3 w-3" aria-hidden="true" />
          主 Agent 回答
        </div>
        <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-zinc-200 [overflow-wrap:anywhere]">{text}</p>
      </div>
    </div>
  );
}

function OutcomeRow({ item, steps }: { item: Extract<ThreadItem, { kind: 'outcome' }>; steps: number }) {
  const label =
    item.state === 'running' ? '继续中…'
      : item.state === 'completed' ? '已完成'
        : item.state === 'failed' ? '失败'
          : '已取消';
  const tone: DotTone = item.state === 'running' ? 'sky' : item.state === 'completed' ? 'emerald' : item.state === 'failed' ? 'red' : 'amber';
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-start gap-2 text-[13px] leading-5">
        <Dot tone={tone} />
        <div className="min-w-0 flex-1 text-zinc-300">
          {label}
          {steps > 0 && <span className="ml-1.5 text-zinc-500">已执行 {steps} 步</span>}
        </div>
      </div>
      {item.state !== 'running' && item.result.trim() !== '' && (
        <details className="ml-3.5 text-[12px] text-zinc-400">
          <summary className="cursor-pointer select-none py-0.5 hover:text-zinc-300 [@media(pointer:coarse)]:py-1.5">查看结果</summary>
          <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words font-mono leading-relaxed [overflow-wrap:anywhere]">{item.result}</pre>
        </details>
      )}
    </div>
  );
}

interface Props {
  message: AgentMessage;
  thread: SubagentThread;
  grouped?: boolean;
}

/**
 * 子 agent 时间线卡：同一个子对话的「派活 → 提问 → 回答 → 继续 → 完成」并成一张卡。
 *
 * 外壳与工具卡同一副（`ToolCardFrame`），时间线默认展开——提问与回答是用户要看的内容，
 * 不是要点开才有的细节；不在运行时可以点标题收起。分组逻辑在 `lib/subagentThread`，
 * 这里只负责画。桌面手机共用同一个组件（窄屏下气泡自然折行）。
 */
function SubagentThreadCard({ message, thread, grouped }: Props) {
  const [expanded, setExpanded] = useMessageViewState('thread-expanded', true);
  const steps = useSubStepCount(thread.subConversationId);
  const toolName = message.toolResult?.toolName ?? 'subagent';
  const { display } = toolDisplayName(toolName);
  const running = thread.state === 'running';
  // 步骤数只挂在最后一个收尾行上（它描述的是子 agent 当前走到哪了）
  const lastOutcome = [...thread.items].reverse().find((i) => i.kind === 'outcome');

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
          trailing={
            <ToolChip tone={STATE_TONE[thread.state]} className="whitespace-nowrap">
              {threadStateLabel(thread.state)}
            </ToolChip>
          }
        >
          {expanded && (
            <div className="ml-3 min-w-0 space-y-1.5 border-l border-edge/50 py-1.5 pl-3 pr-1.5">
              {thread.items.map((item, i) => {
                switch (item.kind) {
                  case 'dispatch': return <PlainRow key={i} label="派活" text={item.text} />;
                  case 'followUp': return <PlainRow key={i} label="追问" text={item.text} />;
                  case 'ask': return <AskBubble key={i} item={item} />;
                  case 'answer': return <AnswerBubble key={i} text={item.text} />;
                  case 'outcome': return <OutcomeRow key={i} item={item} steps={item === lastOutcome ? steps : 0} />;
                }
              })}
              <button
                type="button"
                onClick={() => void openSubConversation(thread.subConversationId)}
                className="flex items-center gap-1.5 pt-0.5 text-xs font-medium text-sky-400 transition-colors hover:text-sky-300 [@media(pointer:coarse)]:min-h-8"
              >
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                {running ? '查看实时调研过程 →' : '查看完整调研过程 →'}
              </button>
            </div>
          )}
        </ToolCardFrame>
      </div>
    </div>
  );
}

export default memo(SubagentThreadCard);
