import { memo, useEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useTaskStore } from '@/stores/taskStore';
import RollingText from '@/components/ui/RollingText';
import { isTaskBusy } from '@/lib/agentStatus';
import { formatExactTokens, formatLiveOutputTokens } from '@/lib/tokenUsage';

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
 * 任务运行状态条 —— 跟在消息流最末一条之后（随内容滚动），agent loop 运行期间一直在。
 * 左起依次：跳动圆点 + 「任务运行中」 + ↓ + 本次任务到目前为止模型输出的 token 数
 * （↓ 表示这是模型的**输出**）。数字来源见 `taskStore.taskOutputByConversation`。
 */
export default memo(function AgentRunStatus({ conversationId }: { conversationId: string }) {
  const output = useTaskStore((s) => {
    const e = s.taskOutputByConversation[conversationId];
    return e ? Math.round(e.settled + e.live) : 0;
  });
  return <RunStatusLine output={output} />;
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
      className="flex h-7 items-center gap-2 text-meta text-fg-secondary"
    >
      <span className="run-dots flex flex-shrink-0 items-center gap-[3px]" aria-hidden="true">
        <i /><i /><i />
      </span>
      <span>{label}</span>
      {output !== undefined && (
        <span
          className="flex items-center gap-0.5 tabular-nums text-fg-secondary"
          title={`本次任务模型已输出 ${formatExactTokens(output)} tokens`}
        >
          <ArrowDown className="h-3 w-3 text-indigo-400" aria-hidden="true" />
          <RollingText text={formatLiveOutputTokens(shown)} />
        </span>
      )}
    </div>
  );
});
