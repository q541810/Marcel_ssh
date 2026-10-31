import { HelpCircle } from 'lucide-react';
import type { QuestionAnswer, QuestionItem, SubagentQuestionSource } from '@/lib/types';
import { useQuestionForm } from './useQuestionForm';
import { QuestionFormBody, QuestionFormFooter } from './QuestionFormParts';
import { QuestionJumpButton } from './QuestionJumpButton';
import { QuestionSourceLine } from './QuestionSourceLine';

interface Props {
  questionId: string;
  questions: QuestionItem[];
  onSubmit: (questionId: string, answers: QuestionAnswer[]) => void;
  queueLength?: number;
  /** 有可跳的上文才传：参数是当前这题的 anchor（缺省 = 正文开头）。 */
  onJump?: (anchor?: string) => void;
  /** 主 agent 转述子 agent 的提问时带上来源。 */
  source?: SubagentQuestionSource;
}

/**
 * 桌面内联提问卡片：用户正看着该对话时，提问就长在消息流末尾（内容列里），不再盖住
 * 刚写完的结论。表单逻辑与浮层面板同一套（`useQuestionForm` + 共用正文 / 页脚）。
 * 首次出现不抢焦点——焦点会把视口拽向卡片，而我们要把结论的开头留在视野里。
 */
export default function InlineQuestionCard({
  questionId, questions, onSubmit, queueLength = 1, onJump, source,
}: Props) {
  const form = useQuestionForm({ questionId, questions, onSubmit, focusOnQuestionChange: false });
  const { current, index, total } = form;
  if (!current) return null;
  return (
    <section
      data-region="inline-question"
      aria-label="智能助手的提问"
      className="my-2 overflow-hidden rounded-2xl border border-indigo-500/30 bg-zinc-800 animate-fadeIn"
    >
      <div className="flex items-center justify-between gap-2 border-b border-edge px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <HelpCircle className="h-4 w-4 flex-shrink-0 text-indigo-400" aria-hidden="true" />
          <span className="truncate text-sm font-semibold text-zinc-100">{current.header}</span>
          {current.multiple && (
            <span className="flex-shrink-0 rounded bg-indigo-600/20 px-1.5 py-0.5 text-xs text-indigo-300">可多选</span>
          )}
          {queueLength > 1 && (
            <span className="rounded-full border border-indigo-700/50 bg-indigo-900/60 px-2 py-0.5 text-[11px] font-medium text-indigo-300">
              队列 1/{queueLength}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-shrink-0 items-center gap-2">
          {onJump && <QuestionJumpButton anchor={current.anchor} onJump={() => onJump(current.anchor)} className="max-w-[12rem]" />}
          {total > 1 && <span className="text-xs text-zinc-500">{index + 1}/{total}</span>}
          <button
            type="button"
            onClick={form.skip}
            className="rounded px-1.5 py-0.5 text-xs text-zinc-500 transition-colors hover:bg-state-mid hover:text-zinc-200"
          >
            跳过
          </button>
        </div>
      </div>
      {source && <QuestionSourceLine source={source} className="border-b border-edge-subtle px-4 py-2" />}
      <div className="space-y-3 px-4 py-3">
        <QuestionFormBody form={form} />
      </div>
      <QuestionFormFooter form={form} />
    </section>
  );
}
