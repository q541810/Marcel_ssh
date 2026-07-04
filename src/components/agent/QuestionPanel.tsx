import { useState, useCallback, useEffect, useRef } from 'react';
import type { QuestionItem, QuestionAnswer } from '@/lib/types';

interface Props {
  questionId: string;
  questions: QuestionItem[];
  onSubmit: (questionId: string, answers: QuestionAnswer[]) => void;
  onCancel: () => void;
}

export default function QuestionPanel({ questionId, questions, onSubmit, onCancel }: Props) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() =>
    questions.map(() => ({ selected: [], custom: '' })),
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const total = questions.length;
  const current = questions[currentIndex];
  const currentAnswer = answers[currentIndex];
  const isLast = currentIndex === total - 1;
  const isFirst = currentIndex === 0;

  // Focus input when switching questions
  useEffect(() => {
    inputRef.current?.focus();
  }, [currentIndex]);

  const goTo = useCallback(
    (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= total) return;
      setCurrentIndex(nextIndex);
    },
    [total],
  );

  const handleOptionClick = useCallback(
    (label: string) => {
      setAnswers((prev) => {
        const next = [...prev];
        const cur = { ...next[currentIndex] };
        if (current.multiple) {
          const idx = cur.selected.indexOf(label);
          if (idx >= 0) {
            cur.selected = cur.selected.filter((s) => s !== label);
          } else {
            cur.selected = [...cur.selected, label];
          }
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
        const cur = { ...next[currentIndex] };
        cur.custom = value;
        next[currentIndex] = cur;
        return next;
      });
    },
    [currentIndex],
  );

  const handleNext = useCallback(() => {
    if (isLast) {
      onSubmit(questionId, answers);
    } else {
      goTo(currentIndex + 1);
    }
  }, [isLast, questionId, answers, onSubmit, goTo, currentIndex]);

  const handlePrev = useCallback(() => {
    goTo(currentIndex - 1);
  }, [goTo, currentIndex]);

  const handleCancel = useCallback(() => {
    const emptyAnswers = questions.map(() => ({ selected: [] as string[], custom: '' }));
    onSubmit(questionId, emptyAnswers);
  }, [questionId, questions, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleNext();
      }
    },
    [handleNext],
  );

  return (
    <div className="p-3 border-t border-zinc-800 bg-zinc-900">
      <div className="rounded-xl bg-zinc-800 border border-indigo-700/40 shadow-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <div className="flex items-center gap-2 min-w-0">
            <svg
              className="w-4 h-4 flex-shrink-0 text-indigo-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            <span className="text-sm font-semibold text-zinc-100 truncate">
              {current.header}
            </span>
            {current.multiple && (
              <span className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded bg-indigo-600/20 text-indigo-300">
                可多选
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-zinc-500">
              {currentIndex + 1}/{total}
            </span>
            <button
              onClick={handleCancel}
              className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
              title="取消"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3 max-h-[40vh] overflow-y-auto">
          {/* Question text */}
          <p className="text-sm text-zinc-200 leading-relaxed">{current.question}</p>

          {/* Options */}
          {current.options && current.options.length > 0 && (
            <div className="space-y-1.5">
              {current.options.map((opt) => {
                const isSelected = current.multiple
                  ? currentAnswer.selected.includes(opt.label)
                  : currentAnswer.custom === opt.label;
                return (
                  <button
                    key={opt.label}
                    onClick={() => handleOptionClick(opt.label)}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-all ${
                      isSelected
                        ? 'border-indigo-500 bg-indigo-600/15 text-indigo-200'
                        : 'border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-700/50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {current.multiple ? (
                        <div
                          className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                            isSelected
                              ? 'border-indigo-500 bg-indigo-600'
                              : 'border-zinc-600'
                          }`}
                        >
                          {isSelected && (
                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                      ) : (
                        <div
                          className={`w-4 h-4 rounded-full border flex-shrink-0 flex items-center justify-center transition-colors ${
                            isSelected
                              ? 'border-indigo-500 bg-indigo-600'
                              : 'border-zinc-600'
                          }`}
                        >
                          {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                        </div>
                      )}
                      <span className="text-sm font-medium">{opt.label}</span>
                    </div>
                    {opt.description && (
                      <p className="text-xs text-zinc-500 mt-0.5 ml-6">{opt.description}</p>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Custom text input (always visible) */}
          {(current.multiple || !current.options?.length ? true : false) && (
            <textarea
              ref={inputRef}
              rows={2}
              value={current.multiple ? currentAnswer.custom : currentAnswer.custom}
              onChange={(e) => handleCustomChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                current.multiple
                  ? '补充说明（可选）...'
                  : '输入你的回答...'
              }
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-indigo-500 resize-none leading-relaxed"
            />
          )}

          {/* For single-select with options, also show text input */}
          {!current.multiple && current.options?.length && (
            <textarea
              ref={inputRef}
              rows={2}
              value={currentAnswer.custom}
              onChange={(e) => handleCustomChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="或输入自定义回答..."
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-indigo-500 resize-none leading-relaxed"
            />
          )}
        </div>

        {/* Footer navigation */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-700">
          <div className="text-xs text-zinc-500">
            <kbd className="px-1 py-0.5 rounded bg-zinc-700 text-zinc-300">Enter</kbd>{' '}
            {isLast ? '提交' : '下一题'}
          </div>
          <div className="flex items-center gap-2">
            {!isFirst && (
              <button
                onClick={handlePrev}
                className="px-3 py-1.5 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
              >
                ← 上一题
              </button>
            )}
            <button
              onClick={handleNext}
              className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
            >
              {isLast ? '提交答案' : '下一题 →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
