import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useTaskStore } from '@/stores/taskStore';
import { useConversationStore } from '@/stores/conversationStore';
import RollingText from '@/components/ui/RollingText';
import { isTaskBusy } from '@/lib/agentStatus';
import { formatExactTokens, formatLiveOutputTokens } from '@/lib/tokenUsage';
import {
  RUN_STATUS_ROTATE_MS,
  pickRunStatusPhrase,
  runStatusPeriod,
} from '@/lib/runStatusPhrases';

/** 该会话此刻是否有 agent loop 在跑（与 `conversationHasRunningTask` 同口径，但可订阅）。 */
export function useConversationLoopRunning(conversationId: string | null): boolean {
  return useTaskStore((s) =>
    !!conversationId
    && Object.values(s.tasks).some((t) => t.conversationId === conversationId && !!t.sessionId && isTaskBusy(t.status)),
  );
}

/**
 * 把高频变化的值按最小间隔放行：太快的跳动只会让滚动数字糊成一团。
 * 最后一次变化一定会落地（尾部补发），所以停下来时显示的永远是真值。
 */
function useSettledValue(value: number, minIntervalMs: number): number {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    if (value === shown) return;
    const wait = Math.max(0, last.current + minIntervalMs - Date.now());
    const apply = () => { last.current = Date.now(); setShown(value); };
    if (wait === 0) { apply(); return; }
    const timer = setTimeout(apply, wait);
    return () => clearTimeout(timer);
  }, [value, shown, minIntervalMs]);
  return shown;
}

/**
 * 状态条文案：按当前时段随机抽一句；没有新事件时每 12s 换一次，
 * 工具调用开始 / 思考开始时立刻再换。只换标签，不碰任务状态与 token 读数。
 */
function useRotatingRunLabel(conversationId: string | null): string {
  const [label, setLabel] = useState(() => pickRunStatusPhrase(runStatusPeriod()));
  const current = useRef(label);
  const change = useCallback(() => {
    const next = pickRunStatusPhrase(runStatusPeriod(), current.current);
    current.current = next;
    setLabel(next);
  }, []);

  // 只订阅「消息条数 + 尾巴上的工具调用 id + 是否在思考」：正文每来一个 token 不会触发换词。
  const pulse = useConversationStore((s) => {
    const messages = conversationId ? s.messages[conversationId] : undefined;
    const tail = messages?.[messages.length - 1];
    const toolId =
      tail?.toolCall?.id
      ?? tail?.toolCalls?.[tail.toolCalls.length - 1]?.id
      ?? tail?.toolResult?.toolCallId
      ?? '';
    return `${messages?.length ?? 0}|${toolId}|${tail?.isThinking ? '1' : '0'}`;
  });

  const seenCount = useRef(0);
  const seenTool = useRef('');
  const wasThinking = useRef(false);
  const primed = useRef(false);
  useEffect(() => {
    const [countText, toolId, thinkingFlag] = pulse.split('|');
    const count = Number(countText);
    const thinking = thinkingFlag === '1';
    // 首帧只记基线：挂载时已经在跑的工具/思考不该立刻把首句换掉。
    if (!primed.current) {
      primed.current = true;
      seenCount.current = count;
      seenTool.current = toolId;
      wasThinking.current = thinking;
      return;
    }
    let changed = false;
    if (count > seenCount.current) changed = true;
    seenCount.current = count;
    if (toolId && toolId !== seenTool.current) {
      seenTool.current = toolId;
      changed = true;
    }
    if (thinking && !wasThinking.current) changed = true;
    wasThinking.current = thinking;
    if (changed) change();
  }, [pulse, change]);

  useEffect(() => {
    const timer = window.setInterval(change, RUN_STATUS_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [change]);

  return label;
}

/**
 * 任务运行状态条 —— 跟在消息流最末一条之后（随内容滚动），agent loop 运行期间一直在。
 * 左起依次：跳动圆点 + 随时段/工具调用/思考随机切换的文案 + ↓ + 本次任务到目前为止
 * 模型输出的 token 数（↓ 表示这是模型的**输出**）。数字来源见
 * `taskStore.taskOutputByConversation`。
 */
export default memo(function AgentRunStatus({ conversationId }: { conversationId: string }) {
  const output = useTaskStore((s) => {
    const e = s.taskOutputByConversation[conversationId];
    return e ? Math.round(e.settled + e.live) : 0;
  });
  const label = useRotatingRunLabel(conversationId);
  return <RunStatusLine output={output} label={label} />;
});

/**
 * 状态条本体（只管长相，不认 store）：跳动圆点 + 文案 + 可选的输出 token 数。
 * 记忆整理助手这类没有 agent 任务的运行也用它，和对话里的运行状态长得一样。
 */
export const RunStatusLine = memo(function RunStatusLine({
  output,
  label = '任务运行中',
}: {
  /** 本次已输出的 token 数；不传 = 没有这个数，不显示。 */
  output?: number;
  label?: string;
}) {
  const shown = useSettledValue(output ?? 0, 400);
  return (
    <div
      role="status"
      aria-live="off"
      className="flex h-7 items-center gap-2 text-xs text-zinc-400"
    >
      <span className="run-dots flex flex-shrink-0 items-center gap-[3px]" aria-hidden="true">
        <i /><i /><i />
      </span>
      <span key={label} title={label} className="min-w-0 truncate animate-fadeIn">{label}</span>
      {output !== undefined && (
        <span
          className="flex flex-shrink-0 items-center gap-0.5 tabular-nums text-zinc-300"
          title={`本次任务模型已输出 ${formatExactTokens(output)} tokens`}
        >
          <ArrowDown className="h-3 w-3 text-indigo-400" aria-hidden="true" />
          <RollingText text={formatLiveOutputTokens(shown)} />
        </span>
      )}
    </div>
  );
});
