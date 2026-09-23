import { describe, it, expect } from 'vitest';
import {
  COMPACT_THRESHOLD_RATIO,
  cacheHitPercent,
  contextMeterView,
  conversationUsageView,
  breakdownTotal,
  formatCompactTokens,
  formatExactTokens,
  formatPercent,
  hasTotals,
  hasUsage,
  uncachedInputTokens,
  usageFromContextEvent,
  usageTotals,
} from './tokenUsage';
import type { ConversationUsage } from './types';

/**
 * 后端源码（vite 的 raw glob 读进来做文本比对，与 `turnState.test.ts` /
 * `disposition.test.ts` 同一手法）：压缩阈值比例必须与前端刻度线同源，
 * 否则占用条上的刻度指的地方和真正会触发压缩的地方不是一处。
 */
const RUST = import.meta.glob(['/src-tauri/src/agent/context/mod.rs'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('压缩阈值刻度与后端同源', () => {
  it('前端常量等于 Rust 的 DEFAULT_THRESHOLD_RATIO', () => {
    const src = RUST['/src-tauri/src/agent/context/mod.rs'] ?? '';
    expect(src.length).toBeGreaterThan(0); // glob 路径写错时防空转
    const m = src.match(/DEFAULT_THRESHOLD_RATIO:\s*f64\s*=\s*([0-9.]+)/);
    expect(m, 'mod.rs 里找不到 DEFAULT_THRESHOLD_RATIO').not.toBeNull();
    expect(COMPACT_THRESHOLD_RATIO).toBe(Number(m![1]));
  });
});

describe('数字格式化', () => {
  it('精确计数带千分位', () => {
    expect(formatExactTokens(84213)).toBe('84,213');
    expect(formatExactTokens(0)).toBe('0');
  });

  it('缩写：千位/百万位，≥100 取整、<100 一位小数', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(999)).toBe('999');
    expect(formatCompactTokens(1240)).toBe('1.2K');
    expect(formatCompactTokens(98_000)).toBe('98K');
    expect(formatCompactTokens(200_000)).toBe('200K');
    expect(formatCompactTokens(1_240_000)).toBe('1.2M');
  });

  it('百分比：整数不带小数、非整数一位', () => {
    expect(formatPercent(42)).toBe('42');
    expect(formatPercent(99.9)).toBe('99.9');
  });
});

describe('缓存命中率', () => {
  it('没有输入时算不出来', () => {
    expect(cacheHitPercent(0, 0)).toBeNull();
  });

  it('全命中 = 100、没命中 = 0', () => {
    expect(cacheHitPercent(500, 500)).toBe(100);
    expect(cacheHitPercent(0, 500)).toBe(0);
  });

  it('部分命中哪怕只差一个 token 也不显示成 100', () => {
    // 199999/200000 = 99.9995%：四舍五入就是 100%，但确实有一个 token
    // 没命中（按全价算）。这里必须显示 99.9。
    expect(cacheHitPercent(199_999, 200_000)).toBe(99.9);
    expect(formatPercent(cacheHitPercent(199_999, 200_000)!)).toBe('99.9');
  });

  it('普通命中率保留一位', () => {
    expect(cacheHitPercent(260, 1240)).toBe(21);
    expect(cacheHitPercent(1, 3)).toBe(33.3);
  });
});

describe('未缓存输入', () => {
  it('渠道没报缓存读取时不给数（而不是给 0）', () => {
    expect(uncachedInputTokens({ promptTokens: 100, completionTokens: 1, totalTokens: 101 })).toBeNull();
  });

  it('输入 − 缓存读取，且不为负', () => {
    expect(
      uncachedInputTokens({
        promptTokens: 1000,
        completionTokens: 1,
        totalTokens: 1001,
        cachedReadTokens: 260,
      }),
    ).toBe(740);
    // 渠道把缓存报得比输入还大（脏数据）→ 夹到 0，不显示负数
    expect(
      uncachedInputTokens({
        promptTokens: 100,
        completionTokens: 1,
        totalTokens: 101,
        cachedReadTokens: 260,
      }),
    ).toBe(0);
  });
});

describe('累计明细', () => {
  const empty: ConversationUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  it('老会话（整块缺失 / 全空）没有可显示的数据', () => {
    expect(hasUsage(undefined)).toBe(false);
    expect(hasUsage(empty)).toBe(false);
    expect(usageTotals(undefined)).toBeNull();
    expect(usageTotals(empty)).toBeNull();
  });

  it('可选字段缺失时那几行是 null（不渲染），不是 0', () => {
    const t = usageTotals({ promptTokens: 100, completionTokens: 10, totalTokens: 110 });
    expect(t).not.toBeNull();
    expect(t!.reasoningTokens).toBeNull();
    expect(t!.cachedReadTokens).toBeNull();
    expect(t!.uncachedInputTokens).toBeNull();
    expect(t!.cacheHitPercent).toBeNull();
  });

  it('有缓存数据时给出未缓存输入与命中率', () => {
    const t = usageTotals({
      promptTokens: 1240,
      completionTokens: 45,
      totalTokens: 1285,
      reasoningTokens: 12,
      cachedReadTokens: 260,
    });
    expect(t!.cachedReadTokens).toBe(260);
    expect(t!.uncachedInputTokens).toBe(980);
    expect(t!.cacheHitPercent).toBe(21);
    expect(t!.reasoningTokens).toBe(12);
  });

  it('只有 lastContext、没有累计（渠道一轮都没报用量）也算有记录，但累计段为空', () => {
    const onlySnapshot: ConversationUsage = {
      ...empty,
      lastContext: {
        usedTokens: 500,
        estimated: true,
        systemTokens: 1,
        toolsTokens: 2,
        messageTokens: 497,
      },
    };
    expect(hasUsage(onlySnapshot)).toBe(true);
    expect(hasTotals(onlySnapshot)).toBe(false);
    // 累计段拿不到明细 → 界面另说一句，**不能显示 0**（那是把「不知道」写成「没花」）
    expect(usageTotals(onlySnapshot)).toBeNull();
  });
});

describe('上下文占用环', () => {
  const usageWith = (used: number, estimated = false): ConversationUsage => ({
    promptTokens: 10,
    completionTokens: 1,
    totalTokens: 11,
    lastContext: {
      usedTokens: used,
      estimated,
      systemTokens: 3100,
      toolsTokens: 12_400,
      messageTokens: Math.max(0, used - 15_500),
    },
  });

  it('有窗口有用量：给百分比', () => {
    const v = contextMeterView(usageWith(80_000), 200_000);
    expect(v.percent).toBe(40);
    expect(v.usedTokens).toBe(80_000);
    expect(v.windowTokens).toBe(200_000);
  });

  it('窗口未配置：不画弧，但已用值照常给出', () => {
    const v = contextMeterView(usageWith(80_000), 0);
    expect(v.percent).toBeNull();
    expect(v.usedTokens).toBe(80_000);
    expect(v.windowTokens).toBe(0);
    expect(contextMeterView(usageWith(80_000), undefined).percent).toBeNull();
  });

  it('还没有过请求：已用值也给不出（显示 —，不是 0）', () => {
    const v = contextMeterView(undefined, 200_000);
    expect(v.usedTokens).toBeNull();
    expect(v.percent).toBeNull();
    expect(v.breakdown).toBeNull();
    const onlyTotals: ConversationUsage = { promptTokens: 5, completionTokens: 1, totalTokens: 6 };
    expect(contextMeterView(onlyTotals, 200_000).usedTokens).toBeNull();
  });

  it('超出窗口时夹到 100（不画出去）', () => {
    expect(contextMeterView(usageWith(300_000), 200_000).percent).toBe(100);
  });

  it('估算标记透传（界面据此加 ~）', () => {
    expect(contextMeterView(usageWith(1000, true), 200_000).estimated).toBe(true);
    expect(contextMeterView(usageWith(1000), 200_000).estimated).toBe(false);
  });

  it('三段构成之和 = 分段条的总量', () => {
    const v = contextMeterView(usageWith(80_000), 200_000);
    expect(breakdownTotal(v.breakdown)).toBe(3100 + 12_400 + (80_000 - 15_500));
    expect(breakdownTotal(null)).toBe(0);
  });
});

describe('实时事件与会话数据合成', () => {
  const live = {
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    windowTokens: 64_000,
  };

  it('有实时事件时事件优先（事件是覆盖语义，永远比落库新）', () => {
    const v = conversationUsageView(live, {
      id: 'c1',
      connectionId: 'conn',
      title: 't',
      createdAt: '',
      updatedAt: '',
      contextWindow: 200_000,
      usage: { promptTokens: 999, completionTokens: 999, totalTokens: 1998 },
    });
    expect(v!.usage.promptTokens).toBe(1);
    expect(v!.windowTokens).toBe(64_000);
  });

  it('没有事件时用会话数据（重启后打开会话走这条路）', () => {
    const v = conversationUsageView(undefined, {
      id: 'c1',
      connectionId: 'conn',
      title: 't',
      createdAt: '',
      updatedAt: '',
      contextWindow: 200_000,
      usage: { promptTokens: 999, completionTokens: 9, totalTokens: 1008 },
    });
    expect(v!.usage.promptTokens).toBe(999);
    expect(v!.windowTokens).toBe(200_000);
  });

  it('会话存在但没有用量：视图在，用量为空（界面显示 —）', () => {
    const v = conversationUsageView(undefined, {
      id: 'c1',
      connectionId: 'conn',
      title: 't',
      createdAt: '',
      updatedAt: '',
    });
    expect(v).not.toBeNull();
    expect(hasUsage(v!.usage)).toBe(false);
    expect(v!.windowTokens).toBe(0);
  });

  it('既没有事件也没有会话 → null', () => {
    expect(conversationUsageView(undefined, undefined)).toBeNull();
  });
});

describe('流事件 → 落库形状', () => {
  it('把平的字段折成累计 + lastContext', () => {
    const usage = usageFromContextEvent({
      promptTokens: 1240,
      completionTokens: 45,
      totalTokens: 1285,
      cachedReadTokens: 260,
      usedTokens: 84_213,
      estimated: true,
      systemTokens: 3100,
      toolsTokens: 12_400,
      messageTokens: 68_713,
    });
    expect(usage.promptTokens).toBe(1240);
    expect(usage.reasoningTokens).toBeUndefined();
    expect(usage.lastContext).toEqual({
      usedTokens: 84_213,
      estimated: true,
      systemTokens: 3100,
      toolsTokens: 12_400,
      messageTokens: 68_713,
    });
  });

  it('折出来的形状能直接喂给占用环与明细', () => {
    const usage = usageFromContextEvent({
      promptTokens: 1240,
      completionTokens: 45,
      totalTokens: 1285,
      usedTokens: 80_000,
      estimated: false,
      systemTokens: 0,
      toolsTokens: 0,
      messageTokens: 80_000,
    });
    expect(contextMeterView(usage, 200_000).percent).toBe(40);
    expect(usageTotals(usage)!.promptTokens).toBe(1240);
  });
});
