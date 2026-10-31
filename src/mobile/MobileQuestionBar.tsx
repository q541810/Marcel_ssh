import { HelpCircle } from 'lucide-react';
import type { SubagentQuestionSource } from '@/lib/types';
import { subagentDisplayTitle } from '@/lib/subagentNav';

interface Props {
  conversationTitle?: string;
  sessionName?: string;
  questionCount: number;
  queueLength?: number;
  onOpen: () => void;
  /** 提问来自子 agent：提醒条上多一行来源。 */
  source?: SubagentQuestionSource;
}

/**
 * 智能助手有问题等你回答、而你此刻不在那条对话的聊天页（终端 / 文件 / 设置页，或看着别的
 * 对话）时，浮在底部 Tab 栏上方的提醒条。点一下：切到聊天页、打开那条对话、落到提问前
 * 那段结论的开头 —— 提问本身以内联卡片出现在聊天末尾。
 *
 * 它是常驻提示而不是浮层：没有遮罩，不拦截其它操作，所以**不注册返回键处理**
 * （返回键照旧由页面栈处理）。
 */
export default function MobileQuestionBar({
  conversationTitle, sessionName, questionCount, queueLength = 1, onOpen, source,
}: Props) {
  const where = [sessionName, conversationTitle].filter(Boolean).join(' · ');
  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-40 px-3 pb-2 animate-fadeIn"
      style={{ bottom: 'max(var(--tab-bar-height, 3rem), var(--ime-bottom, 0px))' }}
      data-region="mobile-question-bar"
    >
      <button
        type="button"
        onClick={onOpen}
        className="pointer-events-auto flex w-full items-center gap-3 rounded-2xl border border-indigo-700/40 bg-zinc-900/95 px-3.5 py-2.5 text-left shadow-2xl backdrop-blur-md active:bg-state-soft"
      >
        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-edge bg-zinc-800">
          <HelpCircle className="h-4 w-4 text-indigo-400" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-zinc-100">
            智能助手在等你回答{questionCount > 1 ? `（${questionCount} 项）` : ''}
            {queueLength > 1 ? ` · 1/${queueLength}` : ''}
          </span>
          {source && (
            <span className="block truncate text-[11px] text-sky-400" data-testid="question-source">
              来自子 Agent「{subagentDisplayTitle(source.title)}」的问题
            </span>
          )}
          {where && <span className="block truncate text-[11px] text-zinc-400">{where}</span>}
        </span>
        <span className="flex-shrink-0 rounded-lg border border-indigo-500/40 bg-indigo-600/30 px-2.5 py-1 text-xs font-medium text-indigo-200">
          去回答
        </span>
      </button>
    </div>
  );
}
