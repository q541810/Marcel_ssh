// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ConversationUsage } from '@/lib/types';
import { TokenUsagePanel } from './TokenUsagePanel';
import { ContextMeterRing } from './ContextMeterRing';

// 让 react act() 在 jsdom 下正常工作（消除 "not configured to support act" 警告）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

function render(usage: ConversationUsage | undefined, windowTokens: number) {
  act(() => {
    root.render(<TokenUsagePanel usage={usage} windowTokens={windowTokens} />);
  });
  return container.textContent ?? '';
}

const withData: ConversationUsage = {
  promptTokens: 1_240_000,
  completionTokens: 45_200,
  totalTokens: 1_285_200,
  reasoningTokens: 12_000,
  cachedReadTokens: 260_000,
  lastContext: {
    usedTokens: 84_213,
    estimated: false,
    systemTokens: 3100,
    toolsTokens: 12_400,
    messageTokens: 68_713,
  },
};

describe('TokenUsagePanel 三态', () => {
  it('有数据：放大数占锚点、三段构成、三行明细都在', () => {
    const text = render(withData, 200_000);
    expect(text).toContain('上下文占用');
    expect(text).toContain('42%'); // 主位大数
    expect(text).toContain('84.2K');
    expect(text).toContain('200K');
    expect(text).toContain('系统');
    expect(text).toContain('工具');
    expect(text).toContain('消息');
    expect(text).toContain('本会话累计');
    expect(text).toContain('含子 agent');
    expect(text).toContain('1.2M'); // 输入（k/M 缩写：>=100 取整、<100 一位小数）
    expect(text).toContain('45.2K'); // 输出
    expect(text).toContain('1.3M'); // 合计
    // 缓存与推理是「说明上一行」的小字，不是并列的第四五六行
    expect(text).toContain('缓存 260K');
    expect(text).toContain('未缓存 980K');
    expect(text).toContain('命中 21%');
    expect(text).toContain('推理 12K');
  });

  it('缩写之外保留全精度：悬停能看到精确值', () => {
    render(withData, 200_000);
    const titles = Array.from(container.querySelectorAll('[title]')).map((el) =>
      el.getAttribute('title'),
    );
    expect(titles).toContain('1,240,000'); // 输入
    expect(titles).toContain('1,285,200'); // 合计
    expect(titles).toContain('84,213 / 200,000'); // 占用
  });

  it('一点数据都没有（老会话）：给一句话，不摆空骨架也不显示 0', () => {
    const text = render(undefined, 200_000);
    expect(text).toContain('还没有用量记录');
    // 不做「大号 —」那套骨架：没有可对比的东西时，空骨架比一句话更难读
    expect(text).not.toContain('—');
    expect(text).not.toContain('上下文占用');
    expect(text).not.toContain('合计');
    expect(text).not.toContain('0');
  });

  it('窗口未配置：主位退而显示已用 token 数，说明写在标题右侧', () => {
    const text = render(withData, 0);
    expect(text).toContain('最近一次请求 · 未配置窗口');
    expect(text).toContain('84.2K'); // 主位数字
    expect(text).toContain('tokens');
    expect(text).not.toContain('42%');
    expect(text).toContain('系统'); // 构成仍然给（估算的）
  });

  it('provider 没报用量（本地估算）：数字带 ~', () => {
    const estimated: ConversationUsage = {
      ...withData,
      lastContext: { ...withData.lastContext!, estimated: true },
    };
    const text = render(estimated, 200_000);
    expect(text).toContain('~84.2K');
    expect(container.querySelectorAll('dl').length).toBeGreaterThan(0);
  });

  it('渠道没报缓存：说明行整条不出现（而不是显示 0）', () => {
    const noCache: ConversationUsage = {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      lastContext: {
        usedTokens: 100,
        estimated: false,
        systemTokens: 0,
        toolsTokens: 0,
        messageTokens: 100,
      },
    };
    const text = render(noCache, 1_000);
    expect(text).toContain('输入');
    expect(text).not.toContain('缓存');
    expect(text).not.toContain('未缓存');
    expect(text).not.toContain('命中');
  });

  it('渠道一轮都没报用量：累计段说明情况，绝不显示 0', () => {
    const onlySnapshot: ConversationUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      lastContext: {
        usedTokens: 20_000,
        estimated: true,
        systemTokens: 1_000,
        toolsTokens: 2_000,
        messageTokens: 17_000,
      },
    };
    const text = render(onlySnapshot, 200_000);
    expect(text).toContain('这个渠道没有返回用量');
    expect(text).toContain('~20K'); // 占用仍按估算给出
    // 累计那几行一条都不出现（不是显示成 0）
    expect(text).not.toContain('输入');
    expect(text).not.toContain('输出');
    expect(text).not.toContain('合计');
  });
});

describe('ContextMeterRing', () => {
  it('未配置窗口（percent=null）：只画轨道，不画弧', () => {
    act(() => {
      root.render(<ContextMeterRing percent={null} />);
    });
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(container.querySelectorAll('circle').length).toBe(1);
  });

  it('有占用：轨道 + 弧', () => {
    act(() => {
      root.render(<ContextMeterRing percent={42} />);
    });
    expect(container.querySelectorAll('circle').length).toBe(2);
    expect(container.querySelector('.stroke-indigo-400')).not.toBeNull();
  });

  it('越过压缩阈值：弧变琥珀色（压缩即将发生，该提前预警）', () => {
    act(() => {
      root.render(<ContextMeterRing percent={85} />);
    });
    expect(container.querySelector('.stroke-amber-400')).not.toBeNull();
    expect(container.querySelector('.stroke-indigo-400')).toBeNull();
  });
});

describe('压缩阈值刻度', () => {
  it('配了窗口时，分段条上标出 80% 的位置（越过它下一次请求就可能压缩）', () => {
    render(withData, 200_000);
    const tick = container.querySelector('[data-testid="compact-threshold-tick"]');
    expect(tick).not.toBeNull();
    expect((tick as HTMLElement).style.left).toBe('80%');
  });

  it('未配置窗口：没有百分比就没有刻度（不画假的）', () => {
    render(withData, 0);
    expect(container.querySelector('[data-testid="compact-threshold-tick"]')).toBeNull();
  });
});
