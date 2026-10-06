// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { QuestionItem } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import MobileQuestionSheet from './MobileQuestionSheet';

const TWO_QUESTIONS: QuestionItem[] = [
  { header: '第一题', question: 'Q1 内容', multiple: false, options: [{ label: 'A', description: '选项说明' }, { label: 'B', description: '选项说明' }] },
  { header: '第二题', question: 'Q2 内容', multiple: false, options: [{ label: 'C', description: '选项说明' }, { label: 'D', description: '选项说明' }] },
];
const ONE_QUESTION: QuestionItem[] = [
  { header: '方案选择', question: 'Q-next 内容', multiple: false, options: [{ label: 'E', description: '选项说明' }, { label: 'F', description: '选项说明' }] },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderSheet(questionId: string, questions: QuestionItem[]) {
  act(() => {
    root.render(
      <MobileQuestionSheet
        questionId={questionId}
        questions={questions}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
  });
}

function click(label: string) {
  const el = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`找不到按钮：${label}`);
  act(() => {
    el.click();
  });
}

/**
 * 回归（2026-10-06 线上爆炸）：与桌面 QuestionPanel 同构的有状态面板，交互
 * 切换若不重挂载，上一条交互的题号与答案漏进下一条（2 题切 1 题还会越界）。
 * 组件自己兜底：渲染期按 questionId 重置，畸形载荷渲染为空。
 */
describe('MobileQuestionSheet 同实例换题（调用方未换 key）时的状态收敛', () => {
  it('答到第 2/2 题后喂进 1 题的新 questionId → 显示新题、不越界', () => {
    renderSheet('q-1', TWO_QUESTIONS);
    click('下一题');
    expect(container.textContent).toContain('2/2');

    renderSheet('q-2', ONE_QUESTION);

    expect(container.textContent).toContain('方案选择');
  });

  it('换题后答案清空（上一轮的输入不漏进新交互）', () => {
    renderSheet('q-1', TWO_QUESTIONS);
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    act(() => {
      setter.call(ta, '我自己的回答');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(ta.value).toBe('我自己的回答');

    renderSheet('q-2', ONE_QUESTION);

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('空题目列表（畸形载荷）→ 渲染为空而不抛错', () => {
    renderSheet('q-0', []);
    expect(container.textContent).toBe('');
  });
});
