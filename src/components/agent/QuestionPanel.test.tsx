// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { QuestionItem } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import QuestionPanel from './QuestionPanel';

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

function renderPanel(questionId: string, questions: QuestionItem[]) {
  act(() => {
    root.render(
      <QuestionPanel
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

/** 选项按钮的文本带着 description（`A选项说明`），按标签前缀找。 */
function clickOption(label: string) {
  const el = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim().startsWith(label),
  );
  if (!el) throw new Error(`找不到选项：${label}`);
  act(() => {
    el.click();
  });
}

/**
 * 回归（2026-10-06 线上爆炸）：本组件是有状态的（题号 + 答案）。overlay 正常
 * 路径用 key 重挂载，但未来任何调用方复用本组件而忘了换 key 时，换题当帧
 * questions[currentIndex] 会越界 —— 组件必须自己兜底：渲染期按 questionId
 * 重置，畸形载荷渲染为空而不是抛错。
 */
describe('QuestionPanel 同实例换题（调用方未换 key）时的状态收敛', () => {
  it('答到第 2/2 题后喂进 1 题的新 questionId → 题号归位、显示新题、不越界', () => {
    renderPanel('q-1', TWO_QUESTIONS);
    click('下一题 →');
    expect(container.textContent).toContain('2/2');

    renderPanel('q-2', ONE_QUESTION);

    expect(container.textContent).toContain('方案选择');
    expect(container.textContent).toContain('1/1');
  });

  it('换题后答案清空（上一轮的选择/输入不漏进新交互）', () => {
    renderPanel('q-1', TWO_QUESTIONS);
    clickOption('A');
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('A');

    renderPanel('q-2', ONE_QUESTION);

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('空题目列表（畸形载荷）→ 渲染为空而不抛错', () => {
    renderPanel('q-0', []);
    expect(container.textContent).toBe('');
  });
});
