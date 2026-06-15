import { useState } from 'react';
import { useAgentStore } from '@/stores/agentStore';
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

const STATUS_COLORS: Record<PlanItemStatus, string> = {
  pending: 'border-transparent',
  in_progress: 'border-l-amber-400',
  completed: 'border-l-emerald-400',
  failed: 'border-l-red-400',
  skipped: 'border-l-zinc-600',
};

const STATUS_BG: Record<PlanItemStatus, string> = {
  pending: '',
  in_progress: 'bg-amber-500/5',
  completed: 'bg-emerald-500/[0.03]',
  failed: 'bg-red-500/[0.03]',
  skipped: '',
};

const STATUS_LABEL: Record<PlanItemStatus, { text: string; className: string } | null> = {
  pending: null,
  in_progress: { text: '当前', className: 'bg-amber-500/15 text-amber-400' },
  completed: null,
  failed: { text: '失败', className: 'bg-red-500/15 text-red-400' },
  skipped: { text: '跳过', className: 'bg-zinc-500/15 text-zinc-500' },
};

// ────────────────────────── PlanList Component ──────────────────────────

export default function PlanList() {
  // Bug9 fix: subscribe directly to the plan slice instead of calling getActivePlan()
  // which returns a new object reference on every render and bypasses selector memoization.
  const plan = useAgentStore((s) =>
    s.activeTaskId ? (s.plans[s.activeTaskId] ?? null) : null
  );
  // Subscribe to plansDirty to force re-render on plan item updates
  useAgentStore((s) => s.plansDirty);
  const [collapsed, setCollapsed] = useState(false);

  if (!plan || plan.items.length === 0) return null;

  const completedCount = plan.items.filter((item) => item.status === 'completed').length;
  const failedCount = plan.items.filter((item) => item.status === 'failed').length;
  const totalCount = plan.items.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/80 backdrop-blur">
      {/* Header */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-zinc-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span className="text-xs font-medium text-zinc-400">执行计划</span>
          <span className="text-xs text-zinc-600">
            {completedCount}/{totalCount}
          </span>
        </div>
        <svg
          className={`w-3 h-3 text-zinc-500 transition-transform duration-200 ${collapsed ? '' : 'rotate-180'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Progress bar (always visible) */}
      <div className="px-3 pb-1.5">
        <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${progressPercent}%`,
              background: progressPercent > 0
                ? 'linear-gradient(90deg, #6366f1, #8b5cf6, #6366f1)'
                : 'transparent',
              boxShadow: progressPercent > 0 && progressPercent < 100
                ? '0 0 8px rgba(99, 102, 241, 0.4)'
                : 'none',
            }}
          />
        </div>
      </div>

      {/* Steps list (collapsible) */}
      {!collapsed && (
        <div className="px-2 pb-2 space-y-0.5 max-h-48 overflow-y-auto overflow-x-hidden">
          {plan.items.map((item, index) => (
            <StepItem key={item.id} item={item} index={index + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ────────────────────────── StepItem Component ──────────────────────────

function StepItem({ item, index }: { item: PlanItem; index: number }) {
  const label = STATUS_LABEL[item.status];
  const icon = STATUS_ICONS[item.status];
  const colorClass = STATUS_COLORS[item.status];
  const bgClass = STATUS_BG[item.status];
  const isCompleted = item.status === 'completed';

  return (
    <div
      className={`
        group flex items-start gap-2 pl-2 pr-1.5 py-1 rounded text-sm transition-all duration-200
        border-l-2 ${colorClass} ${bgClass}
        hover:bg-zinc-800/40
      `}
    >
      {/* Icon */}
      <div className="flex-shrink-0 mt-0.5 transition-transform duration-200">
        {icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {/* Index badge */}
          <span
            className={`
              flex-shrink-0 w-4 h-4 flex items-center justify-center rounded-full text-[10px] font-medium
              ${isCompleted ? 'bg-zinc-700 text-zinc-500' : 'bg-zinc-800 text-zinc-400'}
            `}
          >
            {index}
          </span>

          {/* Title */}
          <span
            className={`
              flex-1 text-xs leading-5 truncate transition-colors
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
