import { useState, useEffect } from 'react';
import { useTaskStore } from '@/stores/taskStore';
import { useConversationStore } from '@/stores/conversationStore';
import type { PlanItem, PlanItemStatus } from '@/lib/types';

// ────────────────────────── SVG Status Icons ──────────────────────────

function PendingIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-zinc-500" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function InProgressIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-amber-400 animate-spin" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="28" strokeDashoffset="8" strokeLinecap="round" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  );
}

function CompletedIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-emerald-400" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" fill="currentColor" fillOpacity="0.15" />
      <path d="M5.5 8l2 2 3-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FailedIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-red-400" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" fill="currentColor" fillOpacity="0.15" />
      <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SkippedIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-zinc-600" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" />
    </svg>
  );
}

const STATUS_ICONS: Record<PlanItemStatus, React.ReactNode> = {
  pending: <PendingIcon />,
  in_progress: <InProgressIcon />,
  completed: <CompletedIcon />,
  failed: <FailedIcon />,
  skipped: <SkippedIcon />,
};

const STATUS_LABEL: Record<PlanItemStatus, { text: string; className: string } | null> = {
  pending: null,
  in_progress: { text: '当前', className: 'text-amber-400' },
  completed: null,
  failed: { text: '失败', className: 'text-red-400' },
  skipped: { text: '跳过', className: 'text-zinc-500' },
};

// ────────────────────────── PlanList Component ──────────────────────────

export default function PlanList() {
  // PlanList 跟随"当前对话"：展示该对话下最近一个有 plan 的 task 的 plan。
  // 这样跨轮次任务（第一轮调研、第二轮执行）能保留 plan 展示，新任务调
  // create_plan 后自然切到新 plan。selector 返回的是 store 里的 plan 对象，
  // 引用稳定，sort 产生的中间数组不影响 memoization。
  //
  // 隐藏条件：task 已完成（终态 status）且 plan 全终态 → 返回 null，UI 消失。
  // 占位 task（sessionId 为空，重启残留）的 status 已是 'completed'，同样走
  // 隐藏检查——重启前已全完成的 plan 重启后不应再显示；只有中断（有非终态
  // item）的 plan 才会因 allTerminal=false 而保留。
  const convId = useConversationStore((s) => s.activeConversationId);
  const plan = useTaskStore((s) => {
    if (!convId) return null;
    const tasksForConv = Object.values(s.tasks)
      .filter((t) => t.conversationId === convId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const t of tasksForConv) {
      const p = s.plans[t.id];
      if (p) {
        const taskDone =
          t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled';
        const allTerminal =
          p.items.length > 0 &&
          p.items.every(
            (item) =>
              item.status === 'completed' ||
              item.status === 'failed' ||
              item.status === 'skipped',
          );
        if (taskDone && allTerminal) {
          return null;
        }
        return p;
      }
    }
    return null;
  });
  const [collapsed, setCollapsed] = useState(false);

  // plan-* 事件总是写入新的 plan 对象，订阅选中 plan 即可；不订阅全局
  // plansDirty，避免后台会话的计划更新唤醒这里。全终态自动折叠后仍可手动展开。
  const allTerminal = plan
    ? plan.items.length > 0 &&
      plan.items.every((item) =>
        ['completed', 'failed', 'skipped'].includes(item.status),
      )
    : false;
  useEffect(() => {
    if (allTerminal) {
      setCollapsed(true);
    }
  }, [allTerminal]);

  if (!plan || plan.items.length === 0) return null;

  const completedCount = plan.items.filter((item) => item.status === 'completed').length;
  const totalCount = plan.items.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div className="min-h-0 flex-shrink overflow-hidden border-t border-zinc-800/60">
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="w-full min-h-6 flex items-center justify-between px-3 py-0.5 hover:bg-zinc-800/30 active:bg-zinc-800/50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 [@media(pointer:coarse)]:min-h-8 motion-reduce:transition-none"
      >
        <div className="flex items-center gap-1.5">
          <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span className="text-xs font-medium text-zinc-400">执行计划</span>
          <span className="text-xs tabular-nums text-zinc-500">
            {completedCount}/{totalCount}
          </span>
        </div>
        <svg
          className={`w-3 h-3 text-zinc-500 transition-transform duration-200 motion-reduce:transition-none ${collapsed ? '' : 'rotate-180'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Progress bar (always visible) */}
      <div className="px-3 pb-1.5">
        <div className="h-0.5 bg-zinc-800/60 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-zinc-500 transition-[width] duration-300 ease-out motion-reduce:transition-none"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Steps list (collapsible) */}
      {!collapsed && (
        <div className="px-2 pb-1 max-h-48 overflow-y-auto overflow-x-hidden">
          {plan.items.map((item) => (
            <StepItem key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────── StepItem Component ──────────────────────────

function StepItem({ item }: { item: PlanItem }) {
  const label = STATUS_LABEL[item.status];
  const icon = STATUS_ICONS[item.status];
  const isCompleted = item.status === 'completed';

  return (
    <div className="group flex items-start gap-1.5 px-1 py-0.5 rounded text-sm">
      {/* Icon */}
      <div className="flex-shrink-0 mt-0.5">
        {icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {/* Index badge — 用 item.id 作为编号，与 LLM 看到的编号一致 */}
          <span className="flex-shrink-0 text-xs tabular-nums text-zinc-500">
            {item.id}
          </span>

          {/* Title */}
          <span
            title={item.title}
            className={`
              min-w-0 flex-1 text-xs leading-5 truncate transition-colors
              ${isCompleted ? 'text-zinc-500 line-through' : 'text-zinc-300'}
            `}
          >
            {item.title}
          </span>

          {/* Status label badge */}
          {label && (
            <span className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${label.className}`}>
              {label.text}
            </span>
          )}
        </div>

        {/* Error message for failed items */}
        {item.status === 'failed' && item.error && (
          <div className="mt-0.5 ml-5 text-[10px] text-red-400/80 break-words [overflow-wrap:anywhere] max-h-[4.5em] overflow-y-auto">
            {item.error}
          </div>
        )}
      </div>
    </div>
  );
}
