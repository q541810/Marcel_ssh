import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  dismissStarPrompt,
  maybeShowStarPromptOnInstall,
  maybeShowStarPromptOnLaunch,
} from '@/lib/starPrompt';

// Node 测试环境无 localStorage —— 提供内存 stub（与 marketStore.test.ts 同款）。
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
    clear: () => storage.clear(),
  },
  configurable: true,
});

function daysAgo(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

describe('starPrompt', () => {
  beforeEach(() => {
    storage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('首次安装触发返回 true，冷却期内不重复弹', () => {
    expect(maybeShowStarPromptOnInstall()).toBe(true);
    expect(maybeShowStarPromptOnInstall()).toBe(false);
  });

  it('一周冷却期过后可再次弹出', () => {
    expect(maybeShowStarPromptOnInstall()).toBe(true);
    // 把上次弹窗时间改为 8 天前
    storage.set('marcel.starPrompt.lastShown', String(daysAgo(8)));
    expect(maybeShowStarPromptOnInstall()).toBe(true);
  });

  it('忽略后永不弹出（install 与 launch 均不弹）', () => {
    dismissStarPrompt();
    expect(maybeShowStarPromptOnInstall()).toBe(false);
    // launch 计数达标也不弹
    for (let i = 0; i < 8; i++) {
      expect(maybeShowStarPromptOnLaunch()).toBe(false);
    }
  });

  it('启动计数每 7 次触发一次，未达标不弹', () => {
    for (let i = 0; i < 6; i++) {
      expect(maybeShowStarPromptOnLaunch()).toBe(false);
    }
    // 第 7 次：达标且首次弹（无冷却）
    expect(maybeShowStarPromptOnLaunch()).toBe(true);
  });

  it('触发后计数归零：冷却期外再攒 7 次又可弹', () => {
    for (let i = 0; i < 6; i++) {
      expect(maybeShowStarPromptOnLaunch()).toBe(false);
    }
    expect(maybeShowStarPromptOnLaunch()).toBe(true); // 第 7 次弹
    storage.set('marcel.starPrompt.lastShown', String(daysAgo(8)));
    for (let i = 0; i < 6; i++) {
      expect(maybeShowStarPromptOnLaunch()).toBe(false);
    }
    expect(maybeShowStarPromptOnLaunch()).toBe(true);
  });

  it('localStorage 异常时优雅降级（不弹、不抛错）', () => {
    const ls = globalThis.localStorage as unknown as {
      getItem: (k: string) => string | null;
      setItem: (k: string, v: string) => void;
    };
    const origGetItem = ls.getItem;
    const origSetItem = ls.setItem;
    ls.getItem = () => {
      throw new Error('denied');
    };
    ls.setItem = () => {
      throw new Error('denied');
    };
    try {
      expect(maybeShowStarPromptOnInstall()).toBe(false);
      expect(maybeShowStarPromptOnLaunch()).toBe(false);
    } finally {
      ls.getItem = origGetItem;
      ls.setItem = origSetItem;
    }
  });
});
