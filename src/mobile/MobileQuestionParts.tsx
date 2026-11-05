import { Check } from 'lucide-react';
import type { QuestionForm } from '@/components/agent/useQuestionForm';

/**
 * 手机提问的题干 + 选项 + 输入框（底部面板 `MobileQuestionPanel` 用）。`compact`：选项与输入框更矮、题干更醒目。
 */
export function MobileQuestionBody({ form, compact = false }: { form: QuestionForm; compact?: boolean }) {
  const { current, currentAnswer } = form;
  if (!current) return null;
  return (
    <>
      <p className={`text-sm leading-relaxed ${compact ? 'text-zinc-100' : 'text-zinc-200'}`}>{current.question}</p>

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
                className={`w-full rounded-xl border px-3 text-left ${compact ? 'py-2.5' : 'py-3'} ${
                  isSelected
                    ? 'border-indigo-500 bg-indigo-600/15'
                    : 'border-edge bg-zinc-800/50 active:bg-state-soft'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className={`flex h-5 w-5 flex-shrink-0 items-center justify-center border ${
                      current.multiple ? 'rounded-md' : 'rounded-full'
                    } ${isSelected ? 'border-indigo-500 bg-indigo-600' : 'border-edge-strong'}`}
                  >
                    {isSelected &&
                      (current.multiple ? (
                        <Check className="h-3.5 w-3.5 text-white" />
                      ) : (
                        <span className="h-2 w-2 rounded-full bg-white" />
                      ))}
                  </span>
                  <span className={`text-sm font-medium ${isSelected ? 'text-indigo-200' : 'text-zinc-300'}`}>
                    {opt.label}
                  </span>
                </div>
                {opt.description && (
                  <p className="ml-[1.875rem] mt-0.5 text-xs text-zinc-500">{opt.description}</p>
                )}
              </button>
            );
          })}
        </div>
      )}

      <textarea
        rows={compact ? 1 : 2}
        value={
          !current.multiple && current.options?.some((o) => o.label === currentAnswer.custom)
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
    </>
  );
}

/** 上一题 / 下一题（提交）按钮行。 */
export function MobileQuestionFooter({ form, className = '' }: { form: QuestionForm; className?: string }) {
  const { isFirst, isLast } = form;
  return (
    <div className={`flex items-center gap-2 ${className}`}>
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
  );
}
