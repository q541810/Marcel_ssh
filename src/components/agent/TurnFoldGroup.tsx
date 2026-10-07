/**
 * TurnFoldGroup.tsx — 一个「已结束长回合」的过程折叠控制器。
 *
 * 职责极简：渲染「user 已由外层处理？不 —— user/答案/过程全部由外层通过
 * 渲染函数提供」。本组件只持有：
 *  1. 展开状态（turnFoldStore，per conversation × turnKey）；
 *  2. 过程控制行（步骤和消息数，与工具卡片分组摘要独立）；
 *  3. 展开/收起切换 + 搜索命中自动展开。
 *
 * 折叠 = **不调用 renderExpanded()**（真正的懒加载：折叠态下整段过程
 * markdown / tool 卡完全不解析渲染）；展开时才由外层惰性构建。
 * user 与最终答案由外层恒定渲染（答案始终可见，回滚/复制入口不丢）。
 */

import { useEffect, type ReactNode } from "react";
import { useTurnFoldStore } from "@/stores/turnFoldStore";
import { turnFoldLabel, type TurnSegment } from "@/lib/agentTurnFold";
import { ChevronRight } from 'lucide-react';

export function TurnFoldControl({ segment, open, onToggle }: {
  segment: TurnSegment;
  open: boolean;
  onToggle: () => void;
}) {
  return <div className="flex justify-start my-0.5" data-turn-fold-control>
    <button
      type="button"
      onClick={onToggle}
      className="group -mx-1 flex min-h-8 min-w-0 max-w-full items-center gap-1 rounded-md px-1 text-left text-xs text-zinc-400 transition-colors hover:bg-white/[0.03] hover:text-zinc-200 active:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 [@media(pointer:coarse)]:min-h-11"
      aria-expanded={open}
      aria-label={`${open ? "收起过程" : "展开过程"}：${turnFoldLabel(segment)}`}
      title={`${open ? "收起过程" : "展开过程"}：${turnFoldLabel(segment)}`}
    >
      <ChevronRight className={`h-3 w-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} aria-hidden />
      <span className="min-w-0 truncate">{turnFoldLabel(segment)}</span>
    </button>
  </div>;
}

interface Props {
  conversationId: string;
  segment: TurnSegment;
  /** 渲染开头 user 消息（普通路径，含高亮/操作）。 */
  renderUser: () => ReactNode;
  /** 渲染最终答案（含复制/回滚等完整操作）。 */
  renderAnswer: () => ReactNode;
  /** 惰性渲染展开后的过程内容（工具组折叠已在外层完成）。 */
  renderExpanded: () => ReactNode;
  /** 折叠态也恒渲染的交付物（成功的可视化图表等；展开时并入过程区不重复）。 */
  renderDeliverables?: () => ReactNode;
  /** 段内成员命中搜索/高亮 → 强制展开。 */
  forceExpand?: boolean;
}

export function TurnFoldGroup({
  conversationId,
  segment,
  renderUser,
  renderAnswer,
  renderExpanded,
  renderDeliverables,
  forceExpand = false,
}: Props) {
  const turnKey = segment.key;
  const open = useTurnFoldStore(
    (s) => s.expanded[conversationId]?.[turnKey] ?? false,
  );
  const toggleTurn = useTurnFoldStore((s) => s.toggleTurn);
  const expandTurn = useTurnFoldStore((s) => s.expandTurn);

  // 命中搜索/高亮 → 自动展开（保持展开，不自动收起）。
  useEffect(() => {
    if (forceExpand) expandTurn(conversationId, turnKey);
  }, [forceExpand, conversationId, turnKey, expandTurn]);

  return (
    <>
      {renderUser()}
      {/* 过程控制行 */}
      <TurnFoldControl segment={segment} open={open} onToggle={() => toggleTurn(conversationId, turnKey)} />
      {/* 交付物（如成功的可视化图表）不属于「过程」：折叠态也恒渲染；
          展开时它们已在过程区按时间序出现，这里不再重复。 */}
      {!open && renderDeliverables && (
        <div className="flex min-w-0 w-full flex-col space-y-1" data-turn-deliverables>
          {renderDeliverables()}
        </div>
      )}
      {/* 展开时才惰性渲染过程（懒加载：折叠态不解析过程 markdown/tool 卡） */}
      {open && (
        <div className="flex min-w-0 w-full flex-col space-y-1" data-turn-fold-members>
          {renderExpanded()}
        </div>
      )}
      {/* 最终答案：始终渲染（回滚/复制入口在此） */}
      {renderAnswer()}
    </>
  );
}
