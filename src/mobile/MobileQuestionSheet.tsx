import { Check } from 'lucide-react';
import type { QuestionItem, QuestionAnswer, SubagentQuestionSource } from '@/lib/types';
import { useQuestionForm } from '@/components/agent/useQuestionForm';
import { QuestionJumpButton } from '@/components/agent/QuestionJumpButton';
import { QuestionSourceLine } from '@/components/agent/QuestionSourceLine';

interface MobileQuestionSheetProps {
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
 * 手机内联提问卡片：用户正看着该对话时，提问长在聊天流末尾，不再是盖住结论的上拉面板。
 * 它是滚动内容的一部分、不是浮层，所以**不注册返回键处理**（返回键照常退出聊天页）。
 * 首次出现不抢焦点：程序化 focus 会唤起软键盘，键盘只在用户点输入框时弹起。
 * 状态逻辑与桌面共用 `useQuestionForm`，这里只负责触屏外观。
 */
export default function MobileQuestionSheet({
  questionId,
  questions,
  onSubmit,
  queueLength = 1,
  onJump,
  source,
}: MobileQuestionSheetProps) {
  const form = useQuestionForm({ questionId, questions, onSubmit, focusOnQuestionChange: false });
  const { current, currentAnswer, index, total, isFirst, isLast } = form;
  if (!current) return null;

  return (
    <section
      className="my-2 overflow-hidden rounded-2xl border border-indigo-700/40 bg-zinc-900 animate-fadeIn"
      data-region="mobile-question"
      aria-label="智能助手的提问"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pb-1 pt-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
          {current.header}
        </span>
        {current.multiple && (
          <span className="flex-shrink-0 rounded bg-indigo-600/20 px-1.5 py-0.5 text-[11px] text-indigo-300">
            可多选
          </span>
        )}
        {queueLength > 1 && (
          <span className="flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded-full bg-indigo-900/60 border border-indigo-700/50 text-indigo-300 font-medium">
            1/{queueLength}
          </span>
        )}
        {total > 1 && (
          <span className="flex-shrink-0 text-xs text-zinc-500">
            {index + 1}/{total}
          </span>
        )}
        <button
          type="button"
          onClick={form.skip}
          className="-mr-2 flex-shrink-0 rounded-lg px-2 py-1 text-xs text-zinc-500 active:bg-state-soft"
        >
          跳过
        </button>
      </div>
      {source && <QuestionSourceLine mobile source={source} className="px-4 pb-1" />}
      {onJump && (
        <div className="px-4 pb-1">
          <QuestionJumpButton mobile anchor={current.anchor} onJump={() => onJump(current.anchor)} />
        </div>
      )}

      {/* Body */}
      <div className="space-y-2.5 px-4 py-2">
        <p className="text-sm leading-relaxed text-zinc-200">
          {current.question}
        </p>

        {current.options && current.options.length > 0 && (
          <div className="space-y-1.5">
            {current.options.map((opt) => {
              const isSelected = current.multiple
                ? currentAnswer.selected.includes(opt.label)
                : currentAnswer.custom === opt.label;
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => form.toggleOption(opt.label)}
                  className={`w-full rounded-xl border px-3 py-3 text-left ${
                    isSelected
                      ? 'border-indigo-500 bg-indigo-600/15'
                      : 'border-edge bg-zinc-800/50 active:bg-state-soft'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center border ${
                        current.multiple ? 'rounded-md' : 'rounded-full'
                      } ${
                        isSelected
                          ? 'border-indigo-500 bg-indigo-600'
                          : 'border-edge-strong'
                      }`}
                    >
                      {isSelected &&
                        (current.multiple ? (
                          <Check className="h-3.5 w-3.5 text-white" />
                        ) : (
                          <span className="h-2 w-2 rounded-full bg-white" />
                        ))}
                    </span>
                    <span
                      className={`text-sm font-medium ${
                        isSelected ? 'text-indigo-200' : 'text-zinc-300'
                      }`}
                    >
                      {opt.label}
                    </span>
                  </div>
                  {opt.description && (
                    <p className="ml-[1.875rem] mt-0.5 text-xs text-zinc-500">
                      {opt.description}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <textarea
          rows={2}
          value={
            !current.multiple &&
            current.options?.some((o) => o.label === currentAnswer.custom)
              ? ''
              : currentAnswer.custom
          }
          onChange={(e) => form.setCustom(e.target.value)}
          placeholder={
            current.options?.length
              ? current.multiple
                ? '补充说明（可选）…'
                : '或输入自定义回答…'
              : '输入你的回答…'
          }
          className="w-full resize-none rounded-xl border border-edge bg-zinc-950 px-3 py-2.5 text-sm leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-indigo-500"
        />
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-4 pb-3 pt-1">
        {!isFirst && (
          <button
            type="button"
            onClick={form.prev}
            className="rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300 active:bg-state-mid"
          >
            上一题
          </button>
        )}
        <button
          type="button"
          onClick={form.next}
          className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white active:bg-indigo-500"
        >
          {isLast ? '提交答案' : '下一题'}
        </button>
      </div>
    </section>
  );
}
