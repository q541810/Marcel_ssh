import { GitBranch } from 'lucide-react';
import type { SubagentQuestionSource } from '@/lib/types';
import { openSubagentQuestionContext, subagentDisplayTitle } from '@/lib/subagentNav';

/**
 * 「这个问题是子 Agent 想问的」来源行：主 agent 转述子 agent 的 ask_parent 时，提问卡片 /
 * 全局浮层 / 手机卡片 / 已回答记录都在头部下面带一行，让用户知道在回答的是谁的问题，
 * 并能一键看到那个子 agent 问这个问题时的上下文。刻意是一行安静的灰字（不是彩色标签）：
 * 它是背景信息，不是要用户处理的东西。
 *
 * `interactive=false`（手机提醒条）只显示文字：整条提醒条本身就是一个按钮，不嵌套第二个。
 */
export function QuestionSourceLine({
  source,
  mobile = false,
  interactive = true,
  className = '',
}: {
  source: SubagentQuestionSource;
  mobile?: boolean;
  interactive?: boolean;
  className?: string;
}) {
  const title = subagentDisplayTitle(source.title);
  return (
    <div
      data-testid="question-source"
      className={`flex min-w-0 items-center gap-2 text-meta leading-5 text-fg-tertiary ${className}`}
    >
      <GitBranch className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate" title={title}>来自子 Agent「{title}」的问题</span>
      {interactive && (
        <button
          type="button"
          onClick={() => void openSubagentQuestionContext(source)}
          className={`flex-shrink-0 text-fg-secondary transition-colors ${
            mobile ? 'py-1 active:text-fg' : 'hover:text-fg'
          }`}
        >
          查看它的上下文 →
        </button>
      )}
    </div>
  );
}
