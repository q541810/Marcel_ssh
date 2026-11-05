import React from 'react';

export type AgentVisualStatus =
  | 'running'
  | 'waiting_approval'
  /** 子 agent 在向主 agent 提问、等回答（只用于单个任务的卡片，不参与对话 / 会话级聚合）。 */
  | 'asking_parent'
  | 'unread_completed'
  | 'idle';

interface AgentStatusIndicatorProps {
  status: AgentVisualStatus;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
  showTooltip?: boolean;
}

export const AgentStatusIndicator: React.FC<AgentStatusIndicatorProps> = ({
  status,
  size = 'sm',
  className = '',
  showTooltip = false,
}) => {
  if (status === 'idle') return null;

  const sizeClasses = {
    xs: {
      spinner: 'w-3 h-3',
      dot: 'w-1.5 h-1.5',
      ring: 'w-2.5 h-2.5',
    },
    sm: {
      spinner: 'w-3.5 h-3.5',
      dot: 'w-2 h-2',
      ring: 'w-3.5 h-3.5',
    },
    md: {
      spinner: 'w-4 h-4',
      dot: 'w-2.5 h-2.5',
      ring: 'w-4.5 h-4.5',
    },
  }[size];

  const tooltipText = {
    running: 'Agent 运行中',
    waiting_approval: '等待审批',
    asking_parent: '向主 Agent 提问中',
    unread_completed: '任务已完成',
    idle: '',
  }[status];

  return (
    <span
      className={`inline-flex items-center justify-center flex-shrink-0 ${className}`}
      title={showTooltip ? tooltipText : undefined}
      aria-label={tooltipText}
    >
      {status === 'running' && (
        <span className={`relative inline-flex items-center justify-center ${sizeClasses.spinner}`}>
          {/* Subtle glow background */}
          <span className="absolute inset-0 rounded-full bg-indigo-500/20 blur-[2px] motion-reduce:hidden" />
          {/* OpenCode-styled dual-arc gradient spinner */}
          <svg
            className={`${sizeClasses.spinner} animate-spin text-indigo-400`}
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle
              cx="8"
              cy="8"
              r="6"
              stroke="currentColor"
              strokeWidth="2"
              strokeOpacity="0.2"
              strokeLinecap="round"
            />
            <path
              d="M14 8a6 6 0 0 0-6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="text-indigo-400"
            />
            <circle
              cx="14"
              cy="8"
              r="1"
              fill="currentColor"
              className="text-indigo-300"
            />
          </svg>
        </span>
      )}

      {status === 'waiting_approval' && (
        <span className={`relative inline-flex items-center justify-center ${sizeClasses.ring}`}>
          {/* Pulsing outer aura ring */}
          <span className="absolute inset-0 rounded-full bg-amber-500/40 animate-ping opacity-75 motion-reduce:hidden" />
          {/* Soft amber glow */}
          <span className="absolute inset-0 rounded-full bg-amber-500/30 blur-[1.5px]" />
          {/* Core amber dot */}
          <span className={`relative rounded-full bg-amber-400 shadow-sm shadow-amber-500/50 ${sizeClasses.dot}`} />
        </span>
      )}

      {status === 'asking_parent' && (
        // 中性灰点：子 agent 在等主 agent，用户没什么可做的，不配颜色
        <span className={`relative inline-flex items-center justify-center ${sizeClasses.ring}`}>
          <span className={`relative rounded-full bg-zinc-500 ${sizeClasses.dot}`} />
        </span>
      )}

      {status === 'unread_completed' && (
        <span className={`relative inline-flex items-center justify-center ${sizeClasses.ring}`}>
          {/* Soft emerald glow */}
          <span className="absolute inset-0 rounded-full bg-emerald-500/30 blur-[1px]" />
          {/* Core emerald dot */}
          <span className={`relative rounded-full bg-emerald-400 shadow-sm shadow-emerald-500/50 ${sizeClasses.dot}`} />
        </span>
      )}
    </span>
  );
};
