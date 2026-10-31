import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuestionAnswer, QuestionItem } from '@/lib/types';

const blank = (questions: QuestionItem[]): QuestionAnswer[] =>
  questions.map(() => ({ selected: [], custom: '' }));

/**
 * 提问表单的状态与动作（题号、答案、选项点选、上一题 / 下一题 / 提交）。
 *
 * 桌面浮层面板（QuestionPanel）、桌面内联卡片（InlineQuestionCard）、手机内联卡片
 * （MobileQuestionSheet）三处共用：外观各有各的，答案怎么攒、什么时候算提交只此一份。
 */
export function useQuestionForm({
  questionId,
  questions,
  onSubmit,
  focusOnQuestionChange = true,
}: {
  questionId: string;
  questions: QuestionItem[];
  onSubmit: (questionId: string, answers: QuestionAnswer[]) => void;
  /** 换题时把焦点给输入框。内联卡片首次出现不能抢焦点（会把视口拽向卡片、手机还会弹键盘），
   *  所以只在用户自己点「下一题 / 上一题」之后才聚焦。 */
  focusOnQuestionChange?: boolean;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() => blank(questions));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const navigated = useRef(false);

  // 交互切换（questionId 变化）时整份重置题号与答案。必须在渲染期重置而不是
  // useEffect：effect 晚一帧，挡不住切换当帧的越界读取（2 题答到第 2 题 →
  // 队列切到 1 题，questions[1] 已是 undefined）。正常路径靠调用方传 key 重挂载，
  // 这里是给复用却忘了换 key 的调用方兜底（2026-10-06 线上爆炸）。
  const [prevQuestionId, setPrevQuestionId] = useState(questionId);
  if (prevQuestionId !== questionId) {
    setPrevQuestionId(questionId);
    setCurrentIndex(0);
    setAnswers(blank(questions));
  }

  const total = questions.length;
  // 下标钳制：题目数在帧内变少的极端情况下也不越界（渲染为空好过崩掉整棵树）
  const index = Math.min(currentIndex, Math.max(total - 1, 0));
  const current: QuestionItem | undefined = questions[index];
  const multiple = current?.multiple === true;
  const isLast = total > 0 && index === total - 1;
  const isFirst = index === 0;
  const currentAnswer = answers[index] ?? { selected: [], custom: '' };

  useEffect(() => {
    if (!focusOnQuestionChange && !navigated.current) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [index, focusOnQuestionChange]);

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= total) return;
      navigated.current = true;
      setCurrentIndex(next);
    },
    [total],
  );

  const toggleOption = useCallback(
    (label: string) => {
      setAnswers((prev) => {
        const next = [...prev];
        const cur = { ...next[index] };
        if (multiple) {
          cur.selected = cur.selected.includes(label)
            ? cur.selected.filter((s) => s !== label)
            : [...cur.selected, label];
        } else {
          cur.custom = label;
        }
        next[index] = cur;
        return next;
      });
    },
    [index, multiple],
  );

  const setCustom = useCallback(
    (value: string) => {
      setAnswers((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], custom: value };
        return next;
      });
    },
    [index],
  );

  const next = useCallback(() => {
    if (isLast) onSubmit(questionId, answers);
    else goTo(index + 1);
  }, [isLast, questionId, answers, onSubmit, goTo, index]);

  const prev = useCallback(() => goTo(index - 1), [goTo, index]);

  const skip = useCallback(() => {
    onSubmit(questionId, blank(questions));
  }, [questionId, questions, onSubmit]);

  return {
    index, total, current, multiple, isLast, isFirst, currentAnswer, inputRef,
    toggleOption, setCustom, next, prev, skip,
  };
}

export type QuestionForm = ReturnType<typeof useQuestionForm>;
