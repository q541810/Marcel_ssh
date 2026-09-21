import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  baseWidthBounds,
  normalizeWorkspaceLayout,
  resolvePanelBaseBounds,
  resolveWorkspaceLayout,
  WORKSPACE_LAYOUT_LIMITS,
} from './workspaceLayout';

describe('workspaceLayout', () => {
  it('balances the default window across three columns', () => {
    const layout = resolveWorkspaceLayout({ containerWidth: 1200, settings: DEFAULT_WORKSPACE_LAYOUT });

    expect(layout.sidebarWidth).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_LIMITS.sidebar.min);
    expect(layout.agentWidth).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_LIMITS.agent.min);
    expect(layout.mainWidth).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_LIMITS.main.min);
    expect(layout.sidebarWidth + layout.mainWidth + layout.agentWidth).toBe(1144);
  });

  it('lets side columns grow on wide screens', () => {
    const layout = resolveWorkspaceLayout({ containerWidth: 2560, settings: DEFAULT_WORKSPACE_LAYOUT });

    expect(layout.sidebarWidth).toBeGreaterThan(350);
    expect(layout.agentWidth).toBeGreaterThan(580);
    expect(layout.agentWidth).toBeLessThanOrEqual(WORKSPACE_LAYOUT_LIMITS.agent.max);
  });

  it('protects the main column on narrow screens', () => {
    const layout = resolveWorkspaceLayout({ containerWidth: 900, settings: DEFAULT_WORKSPACE_LAYOUT });

    expect(layout.sidebarWidth).toBe(WORKSPACE_LAYOUT_LIMITS.sidebar.min);
    expect(layout.agentWidth).toBe(0);
    expect(layout.mainWidth).toBe(624);
  });

  it('keeps the agent panel usable until there is no compact room', () => {
    const enoughForCompactAgent = resolveWorkspaceLayout({
      containerWidth:
        WORKSPACE_LAYOUT_LIMITS.navWidth +
        WORKSPACE_LAYOUT_LIMITS.main.min +
        WORKSPACE_LAYOUT_LIMITS.sidebar.min +
        WORKSPACE_LAYOUT_LIMITS.agent.compactMin,
      settings: DEFAULT_WORKSPACE_LAYOUT,
    });
    const notEnoughForCompactAgent = resolveWorkspaceLayout({
      containerWidth:
        WORKSPACE_LAYOUT_LIMITS.navWidth +
        WORKSPACE_LAYOUT_LIMITS.main.min +
        WORKSPACE_LAYOUT_LIMITS.sidebar.min +
        WORKSPACE_LAYOUT_LIMITS.agent.compactMin - 1,
      settings: DEFAULT_WORKSPACE_LAYOUT,
    });

    expect(enoughForCompactAgent.agentWidth).toBe(WORKSPACE_LAYOUT_LIMITS.agent.compactMin);
    expect(notEnoughForCompactAgent.agentWidth).toBe(0);
  });

  it('gives the workspace all room when side panels are closed', () => {
    const layout = resolveWorkspaceLayout({
      containerWidth: 1600,
      settings: DEFAULT_WORKSPACE_LAYOUT,
      sidebarOpen: false,
      agentOpen: false,
    });

    expect(layout).toEqual({ sidebarWidth: 0, mainWidth: 1544, agentWidth: 0 });
  });

  it('hides side panels in exclusive view', () => {
    const layout = resolveWorkspaceLayout({
      containerWidth: 1600,
      settings: DEFAULT_WORKSPACE_LAYOUT,
      isExclusive: true,
    });

    expect(layout).toEqual({ sidebarWidth: 0, mainWidth: 1544, agentWidth: 0 });
  });

  it('clamps extreme saved ratios', () => {
    const layout = resolveWorkspaceLayout({
      containerWidth: 1800,
      settings: { sidebarRatio: 0.9, agentRatio: 0.9, sidebarOpen: true, agentOpen: true },
    });

    expect(layout.sidebarWidth).toBeGreaterThan(500);
    expect(layout.agentWidth).toBeGreaterThan(500);
    expect(layout.mainWidth).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_LIMITS.main.min);
  });

  it('keeps user-adjusted base widths meaningful across window sizes', () => {
    const defaultLayout = resolveWorkspaceLayout({ containerWidth: 1600, settings: DEFAULT_WORKSPACE_LAYOUT });
    const userLayout = resolveWorkspaceLayout({
      containerWidth: 1600,
      settings: { ...DEFAULT_WORKSPACE_LAYOUT, agentBaseWidth: 700 },
    });
    const wideUserLayout = resolveWorkspaceLayout({
      containerWidth: 2560,
      settings: { ...DEFAULT_WORKSPACE_LAYOUT, agentBaseWidth: 700 },
    });

    expect(userLayout.agentWidth).toBeGreaterThan(defaultLayout.agentWidth + 140);
    expect(wideUserLayout.agentWidth).toBeGreaterThan(userLayout.agentWidth);
  });

  it('shares resize pressure between side panels before shrinking the agent to its minimum', () => {
    const layout = resolveWorkspaceLayout({
      containerWidth: 1280,
      settings: { ...DEFAULT_WORKSPACE_LAYOUT, sidebarBaseWidth: 520, agentBaseWidth: 520 },
    });

    expect(layout.mainWidth).toBe(WORKSPACE_LAYOUT_LIMITS.main.min);
    expect(layout.sidebarWidth).toBeGreaterThan(WORKSPACE_LAYOUT_LIMITS.sidebar.min);
    expect(layout.agentWidth).toBeGreaterThan(WORKSPACE_LAYOUT_LIMITS.agent.min);
  });

  it('normalizes legacy ratio settings into base widths', () => {
    const layout = normalizeWorkspaceLayout({ sidebarRatio: 0.22, agentRatio: 0.3 });

    expect(layout.sidebarBaseWidth).toBe(252);
    expect(layout.agentBaseWidth).toBe(343);
    expect(layout.sidebarOpen).toBe(true);
    expect(layout.agentOpen).toBe(true);
  });
});

describe('面板拖动的可拖范围', () => {
  const containers = [1136, 1280, 1440, 1920, 2560];
  const sides = ['sidebar', 'agent'] as const;
  const baseKeyOf = (side: (typeof sides)[number]) =>
    side === 'sidebar' ? ('sidebarBaseWidth' as const) : ('agentBaseWidth' as const);
  const widthKeyOf = (side: (typeof sides)[number]) =>
    side === 'sidebar' ? ('sidebarWidth' as const) : ('agentWidth' as const);
  const otherKeyOf = (side: (typeof sides)[number]) =>
    side === 'sidebar' ? ('agentWidth' as const) : ('sidebarWidth' as const);

  const layoutFor = (containerWidth: number, side: (typeof sides)[number], base: number) =>
    resolveWorkspaceLayout({
      containerWidth,
      settings: { ...DEFAULT_WORKSPACE_LAYOUT, [baseKeyOf(side)]: base },
    });

  const boundsFor = (containerWidth: number, side: (typeof sides)[number]) =>
    resolvePanelBaseBounds({ side, containerWidth, settings: DEFAULT_WORKSPACE_LAYOUT });

  it('拖动起点永远落在可拖区间内（按下不会先跳一下）', () => {
    const stored = normalizeWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT);
    for (const containerWidth of containers) {
      for (const side of sides) {
        const bounds = boundsFor(containerWidth, side);
        const base = side === 'sidebar' ? stored.sidebarBaseWidth : stored.agentBaseWidth;
        expect(base).toBeGreaterThanOrEqual(bounds.min);
        expect(base).toBeLessThanOrEqual(bounds.max);
      }
    }
  });

  it('松手落盘再读回来，整个布局逐像素不变（拖动中看到的 = 松手后得到的）', () => {
    for (const containerWidth of containers) {
      for (const side of sides) {
        const bounds = boundsFor(containerWidth, side);
        for (let base = bounds.min; base <= bounds.max; base += 1) {
          const during = layoutFor(containerWidth, side, base);
          // 落盘 → 归一化 → 重新求解：走过去又走回来，结果必须和拖动中一致
          const persisted = normalizeWorkspaceLayout({
            ...DEFAULT_WORKSPACE_LAYOUT,
            [baseKeyOf(side)]: base,
          });
          expect(resolveWorkspaceLayout({ containerWidth, settings: persisted })).toEqual(during);
        }
      }
    }
  });

  it('区间内拖动不会让另一个侧栏变窄', () => {
    for (const containerWidth of containers) {
      const rest = resolveWorkspaceLayout({ containerWidth, settings: DEFAULT_WORKSPACE_LAYOUT });
      for (const side of sides) {
        const bounds = boundsFor(containerWidth, side);
        const otherKey = otherKeyOf(side);
        for (let base = bounds.min; base <= bounds.max; base += 1) {
          expect(layoutFor(containerWidth, side, base)[otherKey]).toBeGreaterThanOrEqual(rest[otherKey]);
        }
      }
    }
  });

  it('显示宽度随基准单调，拖动手感连续', () => {
    for (const containerWidth of containers) {
      for (const side of sides) {
        const bounds = boundsFor(containerWidth, side);
        let previous = -1;
        for (let base = bounds.min; base <= bounds.max; base += 1) {
          const width = layoutFor(containerWidth, side, base)[widthKeyOf(side)];
          expect(width).toBeGreaterThanOrEqual(previous);
          previous = width;
        }
      }
    }
  });

  it('区间最左端就是面板自己的显示下限', () => {
    for (const containerWidth of containers) {
      for (const side of sides) {
        const bounds = boundsFor(containerWidth, side);
        if (!bounds.draggable) continue;
        expect(bounds.minDisplayed).toBe(WORKSPACE_LAYOUT_LIMITS[side].min);
        expect(layoutFor(containerWidth, side, bounds.min)[widthKeyOf(side)]).toBe(
          WORKSPACE_LAYOUT_LIMITS[side].min,
        );
      }
    }
  });

  it('拖到最窄松手不再弹回（旧版在 2560 下侧栏会从 220 弹到 289）', () => {
    const sidebar = resolveWorkspaceLayout({
      containerWidth: 2560,
      settings: { ...DEFAULT_WORKSPACE_LAYOUT, sidebarBaseWidth: boundsFor(2560, 'sidebar').min },
    });
    const agent = resolveWorkspaceLayout({
      containerWidth: 2560,
      settings: { ...DEFAULT_WORKSPACE_LAYOUT, agentBaseWidth: boundsFor(2560, 'agent').min },
    });

    expect(sidebar.sidebarWidth).toBe(WORKSPACE_LAYOUT_LIMITS.sidebar.min);
    expect(agent.agentWidth).toBe(WORKSPACE_LAYOUT_LIMITS.agent.min);
  });

  it('窄窗口里加宽要先收窄另一侧：墙只吃中栏的空间', () => {
    // 1280 下默认布局两侧都贴着墙，拖动只能让面板变窄
    const tight = resolveWorkspaceLayout({ containerWidth: 1280, settings: DEFAULT_WORKSPACE_LAYOUT });
    const tightBounds = boundsFor(1280, 'sidebar');
    expect(tightBounds.maxDisplayed).toBe(tight.sidebarWidth);

    // 把 agent 收到下限之后，侧栏才有加宽的空间（新腾出来的是中栏让出的）
    const narrowedAgent = { ...DEFAULT_WORKSPACE_LAYOUT, agentBaseWidth: 222 };
    const afterNarrow = resolveWorkspaceLayout({ containerWidth: 1280, settings: narrowedAgent });
    const roomyBounds = resolvePanelBaseBounds({
      side: 'sidebar',
      containerWidth: 1280,
      settings: narrowedAgent,
    });
    const widened = resolveWorkspaceLayout({
      containerWidth: 1280,
      settings: { ...narrowedAgent, sidebarBaseWidth: roomyBounds.max },
    });

    expect(afterNarrow.agentWidth).toBe(WORKSPACE_LAYOUT_LIMITS.agent.min);
    expect(widened.sidebarWidth).toBeGreaterThan(tight.sidebarWidth);
    expect(widened.agentWidth).toBe(WORKSPACE_LAYOUT_LIMITS.agent.min);
    expect(widened.mainWidth).toBe(WORKSPACE_LAYOUT_LIMITS.main.min);
  });

  it('面板关掉或处在设置页时没有可拖范围', () => {
    const closed = resolvePanelBaseBounds({
      side: 'sidebar',
      containerWidth: 1920,
      settings: DEFAULT_WORKSPACE_LAYOUT,
      sidebarOpen: false,
    });
    expect(closed.draggable).toBe(false);
    expect(closed.maxDisplayed).toBe(closed.minDisplayed);

    // 侧栏关掉之后 agent 的墙就开了：它不必再让出侧栏占的那一份
    const agentWithSidebarClosed = resolvePanelBaseBounds({
      side: 'agent',
      containerWidth: 1920,
      settings: DEFAULT_WORKSPACE_LAYOUT,
      sidebarOpen: false,
    });
    const agentWithSidebarOpen = resolvePanelBaseBounds({
      side: 'agent',
      containerWidth: 1920,
      settings: DEFAULT_WORKSPACE_LAYOUT,
    });
    expect(agentWithSidebarClosed.maxDisplayed).toBe(WORKSPACE_LAYOUT_LIMITS.agent.max);
    expect(agentWithSidebarOpen.maxDisplayed).toBeLessThan(agentWithSidebarClosed.maxDisplayed);

    const exclusive = resolvePanelBaseBounds({
      side: 'agent',
      containerWidth: 1920,
      settings: DEFAULT_WORKSPACE_LAYOUT,
      isExclusive: true,
    });
    expect(exclusive.draggable).toBe(false);
    expect(exclusive.maxDisplayed).toBe(exclusive.minDisplayed);
  });

  it('基准区间由显示区间反推，保证两套坐标互逆', () => {
    expect(baseWidthBounds(WORKSPACE_LAYOUT_LIMITS.sidebar.min, WORKSPACE_LAYOUT_LIMITS.sidebar.max)).toEqual({
      min: 163,
      max: 683,
    });
    expect(baseWidthBounds(WORKSPACE_LAYOUT_LIMITS.agent.min, WORKSPACE_LAYOUT_LIMITS.agent.max)).toEqual({
      min: 222,
      max: 1341,
    });
  });
});
