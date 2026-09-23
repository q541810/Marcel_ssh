import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_AUTO_CONTINUES,
  autoContinuesSpent,
  canAutoContinue,
  resetAutoContinues,
  spendAutoContinue,
  __resetAllAutoContinues,
} from '@/stores/wakeBudget';

/**
 * 自动继续的额度：3 次封顶、只由真正的用户输入回填、按会话各算各的。
 *
 * 这套规矩对齐 DSH 的 `maxConsecutiveWakes`：被叫醒的那一轮可能又派作业、
 * 作业跑完又把它叫醒 —— 没有封顶就是无限自我激励的链。
 */
describe('wakeBudget', () => {
  beforeEach(() => {
    __resetAllAutoContinues();
  });

  it('一开始额度是满的', () => {
    expect(autoContinuesSpent('a')).toBe(0);
    expect(canAutoContinue('a')).toBe(true);
  });

  it('花满就没了（上限是硬顶）', () => {
    for (let i = 0; i < MAX_AUTO_CONTINUES; i += 1) {
      expect(canAutoContinue('a')).toBe(true);
      spendAutoContinue('a');
    }
    expect(canAutoContinue('a')).toBe(false);
    expect(autoContinuesSpent('a')).toBe(MAX_AUTO_CONTINUES);
  });

  it('用户说了一句话 → 回满', () => {
    for (let i = 0; i < MAX_AUTO_CONTINUES; i += 1) spendAutoContinue('a');
    expect(canAutoContinue('a')).toBe(false);
    resetAutoContinues('a');
    expect(canAutoContinue('a')).toBe(true);
    expect(autoContinuesSpent('a')).toBe(0);
  });

  it('按会话各算各的（一条会话花光不影响别的）', () => {
    for (let i = 0; i < MAX_AUTO_CONTINUES; i += 1) spendAutoContinue('a');
    expect(canAutoContinue('a')).toBe(false);
    expect(canAutoContinue('b')).toBe(true);
  });
});
