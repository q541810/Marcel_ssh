import { useCallback, useState } from 'react';
import { Check } from 'lucide-react';
import type { QuestionItem, QuestionAnswer } from '@/lib/types';

interface MobileQuestionSheetProps {
  questionId: string;
  questions: QuestionItem[];
  onSubmit: (questionId: string, answers: QuestionAnswer[]) => void;
  onCancel: () => void;
}

/**
 * Touch-first inline question panel for the mobile shell. Replaces the chat
 * composer while an agent question is pending (same contract as desktop
 * QuestionPanel: cancel submits empty answers via onCancel).
 */
export default function MobileQuestionSheet({
  questionId,
  questions,
  onSubmit,
  onCancel,
}: MobileQuestionSheetProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() =>
    questions.map(() => ({ selected: [], custom: '' })),
  );

  const total = questions.length;
  const current = questions[currentIndex];
  const currentAnswer = answers[currentIndex];
  const isLast = currentIndex === total - 1;
  const isFirst = currentIndex === 0;

  const handleOptionTap = useCallback(
    (label: string) => {
      setAnswers((prev) => {
        const next = [...prev];
        const cur = { ...next[currentIndex] };
        if (current.multiple) {
          cur.selected = cur.selected.includes(label)
            ? cur.selected.filter((s) => s !== label)
            : [...cur.selected, label];
        } else {
          cur.custom = label;
        }
        next[currentIndex] = cur;
        return next;
      });
    },
    [currentIndex, current.multiple],
  );

  const handleCustomChange = useCallback(
    (value: string) => {
      setAnswers((prev) => {
        const next = [...prev];
        next[currentIndex] = { ...next[currentIndex], custom: value };
        return next;
      });
    },
    [currentIndex],
  );

  const handleNext = useCallback(() => {
    if (isLast) {
      onSubmit(questionId, answers);
    } else {
      setCurrentIndex((i) => Math.min(i + 1, total - 1));
    }
  }, [isLast, questionId, answers, onSubmit, total]);

  return (
    <div
      className="mobile-panel-enter flex-shrink-0 border-t border-green-700/40 bg-zinc-900"
      data-region="mobile-question"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pb-1 pt-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-100">
          {current.header}
        </span>
        {current.multiple && (
          <span className="flex-shrink-0 rounded bg-green-600/20 px-1.5 py-0.5 text-[11px] text-green-300">
            可多选
          </span>
        )}
        {total > 1 && (
          <span className="flex-shrink-0 text-xs text-zinc-500">
            {currentIndex + 1}/{total}
          </span>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="-mr-2 flex-shrink-0 rounded-lg px-2 py-1 text-xs text-zinc-500 active:bg-zinc-800"
        >
          跳过
        </button>
      </div>

      {/* Body */}
      <div className="max-h-[45dvh] space-y-2.5 overflow-y-auto overscroll-contain px-4 py-2">
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
                  onClick={() => handleOptionTap(opt.label)}
                  className={`w-full rounded-xl border px-3 py-3 text-left ${
                    isSelected
                      ? 'border-green-500 bg-green-600/15'
                      : 'border-zinc-700 bg-zinc-800/50 active:bg-zinc-800'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center border ${
                        current.multiple ? 'rounded-md' : 'rounded-full'
                      } ${
                        isSelected
                          ? 'border-green-500 bg-green-600'
                          : 'border-zinc-600'
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
                        isSelected ? 'text-green-200' : 'text-zinc-300'
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
          onChange={(e) => handleCustomChange(e.target.value)}
          placeholder={
            current.options?.length
              ? current.multiple
                ? '补充说明（可选）…'
                : '或输入自定义回答…'
              : '输入你的回答…'
          }
          className="w-full resize-none rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-green-500"
        />
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 px-4 pb-3 pt-1">
        {!isFirst && (
          <button
            type="button"
            onClick={() => setCurrentIndex((i) => Math.max(i - 1, 0))}
            className="rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300 active:bg-zinc-700"
          >
            上一题
          </button>
        )}
        <button
          type="button"
          onClick={handleNext}
          className="flex-1 rounded-xl bg-green-600 px-4 py-3 text-sm font-medium text-white active:bg-green-500"
        >
          {isLast ? '提交答案' : '下一题'}
        </button>
      </div>
    </div>
  );
}
