// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bus } from '@/plugins/injection/bus';
import { notifyInputTyping, notifyInputStopped } from './inputActivity';

/**
 * 插件输入活动桥（原 AgentPanel.tsx 内联逻辑，拆出后行为不变）：
 * - 输入 → `ui://input-activity` { typing: true }；
 * - 600ms 无输入 → 自动回落 { typing: false }；
 * - 事件只发「状态变化」，连续输入不重发 true。
 * 模块级状态跨用例共享，所以用例顺序即状态机推进顺序。
 */
describe('inputActivity 插件桥', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    notifyInputStopped();
    vi.useRealTimers();
  });

  function track() {
    const seen: Array<{ typing: boolean }> = [];
    const off = bus.on('ui://input-activity', (payload) =>
      seen.push(payload as { typing: boolean }),
    );
    return { seen, off };
  }

  it('输入发 true，600ms 空闲后自动回落 false', () => {
    const t = track();
    try {
      notifyInputTyping();
      expect(t.seen).toEqual([{ typing: true }]);

      vi.advanceTimersByTime(599);
      // 空闲未满 600ms 不回落
      expect(t.seen).toEqual([{ typing: true }]);

      vi.advanceTimersByTime(1);
      expect(t.seen).toEqual([{ typing: true }, { typing: false }]);
    } finally {
      t.off();
    }
  });

  it('持续输入只发一次 true，且刷新空闲计时', () => {
    const t = track();
    try {
      notifyInputTyping();
      vi.advanceTimersByTime(500);
      notifyInputTyping(); // 状态没变 → 不重发；计时被刷新
      vi.advanceTimersByTime(500);
      // 600ms 内继续输入不该发 false
      expect(t.seen).toEqual([{ typing: true }]);
      vi.advanceTimersByTime(100);
      expect(t.seen).toEqual([{ typing: true }, { typing: false }]);
    } finally {
      t.off();
    }
  });

  it('notifyInputStopped 立即回落并清掉空闲计时器', () => {
    const t = track();
    try {
      notifyInputTyping();
      notifyInputStopped();
      expect(t.seen).toEqual([{ typing: true }, { typing: false }]);
      vi.advanceTimersByTime(1000);
      // 计时器已被清掉，不再发事件
      expect(t.seen).toEqual([{ typing: true }, { typing: false }]);
    } finally {
      t.off();
    }
  });
});
