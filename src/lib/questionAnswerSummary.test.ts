import { describe, expect, it } from 'vitest';
import { summarizeAnswers } from './questionAnswerSummary';

describe('summarizeAnswers', () => {
  it('单题单行回答', () => {
    expect(summarizeAnswers('1. [方案] 走 A', true)).toEqual({ state: 'answered', text: '走 A' });
  });

  it('多题：按题拼接，未答的题跳过', () => {
    const r = summarizeAnswers('1. [一] A\n2. [二] 用户未回答\n3. [三] C', true);
    expect(r).toEqual({ state: 'answered', text: 'A · C' });
  });

  it('多选 + 补充文字', () => {
    const r = summarizeAnswers('1. [选]\n   - X\n   - Y\n   再加一句', true);
    expect(r).toEqual({ state: 'answered', text: 'X、Y、再加一句' });
  });

  it('全部未答 / 失败（取消）→ 已跳过', () => {
    expect(summarizeAnswers('1. [一] 用户未回答', true).state).toBe('skipped');
    expect(summarizeAnswers('', false).state).toBe('skipped');
  });

  it('结构读不懂就压成一行，不丢信息', () => {
    expect(summarizeAnswers('随便一段\n文本', true)).toEqual({ state: 'answered', text: '随便一段 文本' });
  });
});
