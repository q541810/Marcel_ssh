import { useRef } from 'react';
import { INNER_FOLLOW_THRESHOLD_PX } from '@/lib/agentScroll';
import { useIsomorphicLayoutEffect, useStickyFollow } from '@/hooks/useStickyFollow';
import LiveToolOutput from './LiveToolOutput';

/**
 * 工具卡里执行中的实时输出：固定高度的内滚盒子，输出逐条追加，用户没上翻就
 * 贴着最新一行（判定见 `useStickyFollow`）。
 *
 * 外层的出入场动画由 `TransientReveal` 负责。命令结束后到收起动画播完之前，这个
 * 组件还会再渲染几十毫秒，此时 `executing` 已为假、`text` 已换成最终结果——盒子
 * 必须定格在最后一帧实时输出，不能中途换成最终文本（长度可能差很多，收起的过程中
 * 内容一跳，比不做动画还难看）。
 */
export default function LiveOutputPanel({
  text,
  executing,
}: {
  text: string;
  executing: boolean;
}) {
  const { ref, onScroll, follow } = useStickyFollow<HTMLPreElement>(INNER_FOLLOW_THRESHOLD_PX);
  // 渲染期写 ref 是幂等的（同一个 text 再渲染一次结果相同），StrictMode 双渲染安全
  const shown = useRef(text);
  if (executing) shown.current = text;

  useIsomorphicLayoutEffect(() => {
    if (executing) follow();
  }, [text, executing, follow]);

  return (
    <div className="min-w-0 ml-3 border-l border-edge/50 pl-3 pr-1.5 py-1.5">
      <pre
        ref={ref}
        onScroll={onScroll}
        className="text-meta text-fg-secondary whitespace-pre max-h-[120px] max-w-full overflow-x-auto overflow-y-auto font-mono leading-relaxed"
      >
        <LiveToolOutput text={shown.current} />
      </pre>
    </div>
  );
}
