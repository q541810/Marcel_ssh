import { describe, expect, it } from 'vitest';
import type { ActiveInteractionPayload } from '@/lib/types';
import { shouldShowQuestionInline } from './questionPlacement';

const question = (over: Partial<ActiveInteractionPayload> = {}): ActiveInteractionPayload => ({
  type: 'interactionActive',
  interactionId: 'i',
  kind: 'question',
  taskId: 't',
  sessionId: 's',
  conversationId: 'c1',
  conversationTitle: '',
  queueLength: 1,
  question: { questionId: 'q', questions: [] },
  ...over,
});

describe('shouldShowQuestionInline（内联卡片 vs 全局浮层的唯一判定）', () => {
  it('对话正显示在可见面板里 → 内联', () => {
    expect(shouldShowQuestionInline(question(), new Set(['c1']))).toBe(true);
    expect(shouldShowQuestionInline(question(), ['c1', 'c2'])).toBe(true);
  });

  it('面板显示的是别的对话 / 没有可见面板（终端页、面板收起）→ 全局浮层', () => {
    expect(shouldShowQuestionInline(question(), new Set(['c2']))).toBe(false);
    expect(shouldShowQuestionInline(question(), new Set())).toBe(false);
  });

  it('审批永远不内联', () => {
    expect(
      shouldShowQuestionInline(question({ kind: 'approval', question: undefined }), new Set(['c1'])),
    ).toBe(false);
  });

  it('没有交互 / 缺对话 id → 不内联', () => {
    expect(shouldShowQuestionInline(null, new Set(['c1']))).toBe(false);
    expect(shouldShowQuestionInline(question({ conversationId: '' }), new Set(['']))).toBe(false);
  });
});
