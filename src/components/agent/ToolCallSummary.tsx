import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import type { AgentMessage } from '@/lib/types';
import { summarizeToolCalls, toolCallSummaryLabel } from '@/lib/toolCallSummary';
import './toolCallSummary.css';
import { summarizeWebToolGroup } from '@/lib/webToolStatus';

const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Tool-group summary shared by desktop and mobile. */
function ToolCallSummary({ messages }: { messages: readonly AgentMessage[] }) {
  const counts = summarizeToolCalls(messages);
  const label = toolCallSummaryLabel(messages);
  const webSummary = summarizeWebToolGroup(messages.flatMap((message) =>
    message.role === 'tool' && !message.isExecuting && message.toolResult
      ? [{ toolName: message.toolResult.toolName, metadata: message.toolResult.metadata }]
      : [],
  ));
  const root = useRef<HTMLSpanElement>(null);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const signature = JSON.stringify(counts.map(({ toolName }) => toolName));

  useClientLayoutEffect(() => {
    if (!root.current) return;
    const origin = root.current.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number }>();
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    root.current.querySelectorAll<HTMLElement>('[data-tool-summary-name]').forEach((element) => {
      const name = element.dataset.toolSummaryName!;
      const activeAnimations = (element.getAnimations?.() ?? [])
        .filter((animation) => animation.id === 'tool-summary-layout');
      const visualRect = activeAnimations.length ? element.getBoundingClientRect() : null;
      activeAnimations.forEach((animation) => animation.cancel());
      const rect = element.getBoundingClientRect();
      const position = { x: rect.left - origin.left, y: rect.top - origin.top };
      const previous = visualRect
        ? { x: visualRect.left - origin.left, y: visualRect.top - origin.top }
        : positions.current.get(name);
      next.set(name, position);
      if (!reduced && previous && element.animate
        && (previous.x !== position.x || previous.y !== position.y)) {
        const animation = element.animate([
          { transform: `translate(${previous.x - position.x}px, ${previous.y - position.y}px)` },
          { transform: 'translate(0, 0)' },
        ], { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
        animation.id = 'tool-summary-layout';
      }
    });
    positions.current = next;
  }, [signature]);

  if (!counts.length) return <span>已执行工具</span>;
  return (
    <span ref={root} className="tool-call-summary">
      <span className="tool-call-summary-text" title={label} aria-label={label}>
        <span aria-hidden="true">执行</span>
        {counts.map(({ toolName }, index) => (
          <span aria-hidden="true" className="tool-call-summary-item" data-tool-summary-name={toolName} key={toolName}>
            {index > 0 && <span>,</span>}
            <span className="tool-call-summary-name" title={toolName}>{toolName}</span>
          </span>
        ))}
      </span>
      {webSummary.blocked > 0 && (
        <span className="ml-1 shrink-0 whitespace-nowrap rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-300"
          title={`组内有 ${webSummary.blocked} 次联网调用被网站的人机验证拦下，展开可查看详情`}>
          含网站拦截
        </span>
      )}
    </span>
  );
}

export default memo(ToolCallSummary);
