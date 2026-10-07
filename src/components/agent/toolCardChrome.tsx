import type { ReactNode } from 'react';
import { toolIconPaths } from '@/lib/toolCatalog';

/**
 * 工具调用卡的骨架：轻量单行（图标 · 操作摘要 · 小标记 · 箭头）+ 按需展开的正文。
 *
 * 抽出来的理由：会话里的「系统告知」（`JobNoticeCard`）要长得跟工具卡一模一样
 * —— 同一个视觉语言，用户一眼就知道「这是系统/模型做的事，不是我说的话」。
 * 两份各写一套样式必然漂移（改了一边，另一边就成孤儿），所以壳只有这一份。
 *
 * 真正属于工具卡的东西（参数、输出、审批标记、文件 diff）仍留在 `ToolCallCard`
 * 里；这里只有两家共用的那副壳。
 */

/**
 * 工具标题图标。路径表在 `@/lib/toolCatalog`（一个工具一行），这里只负责用
 * 统一的描边 svg 包起来 —— 13 个图标原本各抄一遍 `<svg className="w-3.5 h-3.5"
 * fill="none" stroke="currentColor" viewBox="0 0 24 24">`，改尺寸要改 13 处。
 */
export function ToolIcon({ toolName }: { toolName: string }) {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      {toolIconPaths(toolName).map((d, i) => (
        <path key={i} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
      ))}
    </svg>
  );
}

/** 标题行里小标记的语义配色。 */
export type ToolChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const CHIP_TONE_CLASS: Record<ToolChipTone, string> = {
  neutral: 'text-zinc-400',
  info: 'bg-sky-500/10 text-sky-300',
  success: 'bg-emerald-500/10 text-emerald-300',
  warning: 'bg-amber-500/10 text-amber-300',
  danger: 'bg-red-500/10 text-red-300',
};

/** 标题行里的一个小标记（目标机器、运行模式、降级/拦截、作业状态…）。 */
export function ToolChip({
  tone = 'neutral',
  title,
  className = '',
  children,
  shrinkable = false,
}: {
  tone?: ToolChipTone;
  title?: string;
  className?: string;
  children: ReactNode;
  /** 允许随卡片宽度收缩（内容需自带 truncate；配合 max-w 使用）。
   *  默认不收缩：多数 chip 是短标签，收缩会让它们被压扁——只有 host /
   *  模型这类「内容长度不可控」的 chip 才打开。 */
  shrinkable?: boolean;
}) {
  return (
    <span
      className={`${shrinkable ? 'min-w-0' : 'flex-shrink-0'} text-[11px] leading-4 px-1 py-0 rounded font-medium ${CHIP_TONE_CLASS[tone]} ${className}`}
      title={title}
    >
      {children}
    </span>
  );
}

/** 卡片容器的色调：默认 / 出问题的工具（被阻止、超时）。 */
export type ToolCardTone = 'default' | 'warning' | 'danger';

const CONTAINER_TONE_CLASS: Record<ToolCardTone, string> = {
  default: 'text-zinc-400',
  warning: 'text-amber-400',
  danger: 'text-red-400',
};

export function ToolCardFrame({
  toolName,
  label,
  chips,
  preview,
  trailing,
  tone = 'default',
  busy = false,
  expanded = false,
  onToggle,
  containerRef,
  children,
}: {
  /** 决定图标（走 toolCatalog 的图标表；表里没有的工具落到默认齿轮）。 */
  toolName: string;
  /** 图标右边的名字：工具名，或「后台作业」这类用户语言。 */
  label: string;
  /** 名字胶囊后面的一排小标记。 */
  chips?: ReactNode;
  /** 摘要（等宽、单行截断）：命令、路径、作业 id 这类一眼要看到的东西。 */
  preview?: ReactNode;
  /** 摘要后面的小标记（「已阻止」「超时」这类）。 */
  trailing?: ReactNode;
  tone?: ToolCardTone;
  /** 执行中：右侧转圈，点了不折叠。 */
  busy?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  /** 容器 ref（工具卡要量宽度决定标题行放得下多少字）。 */
  containerRef?: (node: HTMLDivElement | null) => void;
  children?: ReactNode;
}) {
  return (
    <div
      ref={containerRef}
      className={`min-w-0 max-w-full rounded-md ${CONTAINER_TONE_CLASS[tone]}`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={onToggle && !busy ? expanded : undefined}
        aria-disabled={busy || !onToggle || undefined}
        title={typeof preview === 'string' && preview ? `${label} ${preview}` : label}
        className="group block w-full min-w-0 rounded-md text-left transition-colors duration-150 hover:bg-zinc-800/30 active:bg-zinc-800/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 touch-manipulation motion-reduce:transition-none"
      >
        <div className="flex min-h-7 items-center gap-2 px-1 py-1 min-w-0 [@media(pointer:coarse)]:min-h-8">
          <span className="shrink-0" aria-hidden="true">
            <ToolIcon toolName={toolName} />
          </span>
          <div className="flex flex-1 items-center gap-2 min-w-0 overflow-hidden">
            <span className={`min-w-0 truncate text-[13px] leading-5 font-normal ${preview ? 'max-w-[45%] shrink-0' : 'flex-1'}`}>{label}</span>
            {preview && (
              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 font-normal text-zinc-400 font-mono">{preview}</span>
            )}
          </div>
          <div className="flex min-w-0 max-w-[45%] items-center gap-1 overflow-hidden empty:hidden">{chips}</div>
          {trailing}
          <div className="flex items-center gap-1 flex-shrink-0">
            {busy ? (
              <svg
                className="animate-spin h-4 w-4 flex-shrink-0 text-zinc-500"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
            ) : onToggle ? (
              <svg
                className={`w-3 h-3 flex-shrink-0 text-zinc-500 group-hover:text-zinc-300 transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            ) : null}
          </div>
        </div>
      </button>
      {children}
    </div>
  );
}
