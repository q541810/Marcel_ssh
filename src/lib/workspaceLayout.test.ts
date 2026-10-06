import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  baseWidthBounds,
  baseWidthKeyOf,
  baseWidthPatch,
  defaultBaseWidthOf,
  mergeWorkspaceLayout,
  normalizeWorkspaceLayout,
  resolvePanelBaseBounds,
  resolveWorkspaceLayout,
  WORKSPACE_LAYOUT_LIMITS,
} from './workspaceLayout';

describe('workspaceLayout', () => {
  it('balances the default window across three columns', () => {
    const layout = resolveWorkspaceLayout({ containerWidth: 1200, settings: DEFAULT_WORKSPACE_LAYOUT });

    expect(layout.sidebarWidth).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_LIMITS.sidebar.min);
    expect(layout.dockWidth).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_LIMITS.dock.min);
    expect(layout.mainWidth).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_LIMITS.main.min);
    expect(layout.sidebarWidth + layout.mainWidth + layout.dockWidth).toBe(1144);
  });

  it('lets side columns grow on wide screens', () => {
    const layout = resolveWorkspaceLayout({ containerWidth: 2560, settings: DEFAULT_WORKSPACE_LAYOUT });

    expect(layout.sidebarWidth).toBeGreaterThan(350);
    expect(layout.dockWidth).toBeGreaterThan(580);
    expect(layout.dockWidth).toBeLessThanOrEqual(WORKSPACE_LAYOUT_LIMITS.dock.max);
  });

  it('protects the main column on narrow screens', () => {
    const layout = resolveWorkspaceLayout({ containerWidth: 900, settings: DEFAULT_WORKSPACE_LAYOUT });

    expect(layout.sidebarWidth).toBe(WORKSPACE_LAYOUT_LIMITS.sidebar.min);
    expect(layout.dockWidth).toBe(0);
    expect(layout.mainWidth).toBe(624);
  });

  it('keeps the agent panel usable until there is no compact room', () => {
    const enoughForCompactAgent = resolveWorkspaceLayout({
      containerWidth:
        WORKSPACE_LAYOUT_LIMITS.navWidth +
        WORKSPACE_LAYOUT_LIMITS.main.min +
        WORKSPACE_LAYOUT_LIMITS.sidebar.min +
        WORKSPACE_LAYOUT_LIMITS.dock.compactMin,
      settings: DEFAULT_WORKSPACE_LAYOUT,
    });
    const notEnoughForCompactAgent = resolveWorkspaceLayout({
      containerWidth:
        WORKSPACE_LAYOUT_LIMITS.navWidth +
        WORKSPACE_LAYOUT_LIMITS.main.min +
        WORKSPACE_LAYOUT_LIMITS.sidebar.min +
        WORKSPACE_LAYOUT_LIMITS.dock.compactMin - 1,
      settings: DEFAULT_WORKSPACE_LAYOUT,
    });

    expect(enoughForCompactAgent.dockWidth).toBe(WORKSPACE_LAYOUT_LIMITS.dock.compactMin);
    expect(notEnoughForCompactAgent.dockWidth).toBe(0);
  });

  it('gives the workspace all room when side panels are closed', () => {
    const layout = resolveWorkspaceLayout({
      containerWidth: 1600,
      settings: DEFAULT_WORKSPACE_LAYOUT,
      sidebarOpen: false,
      agentOpen: false,
    });

    expect(layout).toEqual({ sidebarWidth: 0, mainWidth: 1544, dockWidth: 0 });
  });

  it('hides side panels in exclusive view', () => {
    const layout = resolveWorkspaceLayout({
      containerWidth: 1600,
      settings: DEFAULT_WORKSPACE_LAYOUT,
      isExclusive: true,
    });

    expect(layout).toEqual({ sidebarWidth: 0, mainWidth: 1544, dockWidth: 0 });
  });

  it('clamps extreme saved ratios', () => {
    const layout = resolveWorkspaceLayout({
      containerWidth: 1800,
      settings: { sidebarRatio: 0.9, agentRatio: 0.9, sidebarOpen: true, agentOpen: true },
    });

    expect(layout.sidebarWidth).toBeGreaterThan(500);
    expect(layout.dockWidth).toBeGreaterThan(500);
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

    expect(userLayout.dockWidth).toBeGreaterThan(defaultLayout.dockWidth + 140);
    expect(wideUserLayout.dockWidth).toBeGreaterThan(userLayout.dockWidth);
  });

  it('shares resize pressure between side panels before shrinking the agent to its minimum', () => {
    const layout = resolveWorkspaceLayout({
      containerWidth: 1280,
      settings: { ...DEFAULT_WORKSPACE_LAYOUT, sidebarBaseWidth: 520, agentBaseWidth: 520 },
    });

    expect(layout.mainWidth).toBe(WORKSPACE_LAYOUT_LIMITS.main.min);
    expect(layout.sidebarWidth).toBeGreaterThan(WORKSPACE_LAYOUT_LIMITS.sidebar.min);
    expect(layout.dockWidth).toBeGreaterThan(WORKSPACE_LAYOUT_LIMITS.dock.min);
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
  const sides = ['sidebar', 'dock'] as const;
  const baseKeyOf = (side: (typeof sides)[number]) =>
    baseWidthKeyOf(side, DEFAULT_WORKSPACE_LAYOUT);
  const widthKeyOf = (side: (typeof sides)[number]) =>
    side === 'sidebar' ? ('sidebarWidth' as const) : ('dockWidth' as const);
  const otherKeyOf = (side: (typeof sides)[number]) =>
    side === 'sidebar' ? ('dockWidth' as const) : ('sidebarWidth' as const);

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
      settings: { ...DEFAULT_WORKSPACE_LAYOUT, agentBaseWidth: boundsFor(2560, 'dock').min },
    });

    expect(sidebar.sidebarWidth).toBe(WORKSPACE_LAYOUT_LIMITS.sidebar.min);
    expect(agent.dockWidth).toBe(WORKSPACE_LAYOUT_LIMITS.dock.min);
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

    expect(afterNarrow.dockWidth).toBe(WORKSPACE_LAYOUT_LIMITS.dock.min);
    expect(widened.sidebarWidth).toBeGreaterThan(tight.sidebarWidth);
    expect(widened.dockWidth).toBe(WORKSPACE_LAYOUT_LIMITS.dock.min);
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

    // 侧栏关掉之后 dock 的墙就开了：它不必再让出侧栏占的那一份
    const agentWithSidebarClosed = resolvePanelBaseBounds({
      side: 'dock',
      containerWidth: 1920,
      settings: DEFAULT_WORKSPACE_LAYOUT,
      sidebarOpen: false,
    });
    const agentWithSidebarOpen = resolvePanelBaseBounds({
      side: 'dock',
      containerWidth: 1920,
      settings: DEFAULT_WORKSPACE_LAYOUT,
    });
    expect(agentWithSidebarClosed.maxDisplayed).toBe(WORKSPACE_LAYOUT_LIMITS.dock.max);
    expect(agentWithSidebarOpen.maxDisplayed).toBeLessThan(agentWithSidebarClosed.maxDisplayed);

    const exclusive = resolvePanelBaseBounds({
      side: 'dock',
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
    expect(baseWidthBounds(WORKSPACE_LAYOUT_LIMITS.dock.min, WORKSPACE_LAYOUT_LIMITS.dock.max)).toEqual({
      min: 222,
      max: 1341,
    });
  });
});

/**
 * 「Agent 占主区域」（agentPrimary）：Agent 与终端互换——Agent 去中间主区域，
 * 终端停进右侧固定栏。求解器只认 dock 槽位，宽度按当前停谁取，两栏各记各的。
 */
describe('终端与 Agent 互换位置', () => {
  const swapped = { ...DEFAULT_WORKSPACE_LAYOUT, agentPrimary: true };

  it('旧配置缺字段时保持原布局：不换位置，终端宽度取默认', () => {
    const layout = normalizeWorkspaceLayout({ sidebarBaseWidth: 300 });

    expect(layout.agentPrimary).toBe(false);
    expect(layout.terminalBaseWidth).toBe(DEFAULT_WORKSPACE_LAYOUT.terminalBaseWidth);
    expect(normalizeWorkspaceLayout({ agentPrimary: undefined }).agentPrimary).toBe(false);
  });

  it('dock 的宽度取「当前停在里面的那个面板」自己的基准宽度', () => {
    // 不能拿公式反推期望值：主区域下限会把 dock 压小（求解器的输出才是屏幕上的宽度）。
    // 所以改成互相印证——动谁不影响谁。
    const settings = { ...DEFAULT_WORKSPACE_LAYOUT, agentBaseWidth: 700, terminalBaseWidth: 380 };
    const normal = resolveWorkspaceLayout({ containerWidth: 1600, settings });
    const swap = resolveWorkspaceLayout({ containerWidth: 1600, settings: { ...settings, agentPrimary: true } });

    // 普通模式：dock 听 agentBaseWidth，终端自己的宽度完全不参与
    expect(resolveWorkspaceLayout({ containerWidth: 1600, settings: { ...settings, terminalBaseWidth: 900 } }).dockWidth).toBe(
      normal.dockWidth,
    );
    // 互换模式：dock 听 terminalBaseWidth，Agent 自己的宽度完全不参与
    expect(resolveWorkspaceLayout({ containerWidth: 1600, settings: { ...settings, agentBaseWidth: 900, agentPrimary: true } }).dockWidth).toBe(
      swap.dockWidth,
    );
    // 同一组设置下互换后变窄：dock 从 700 换成了 380
    expect(swap.dockWidth).toBeLessThan(normal.dockWidth);
    expect(swap.mainWidth).toBeGreaterThan(normal.mainWidth);
  });

  it('默认的右侧窄栏宽度与 Agent 停右侧时一致：互换先把空间给主区域', () => {
    const normal = resolveWorkspaceLayout({ containerWidth: 1920, settings: DEFAULT_WORKSPACE_LAYOUT });
    const swap = resolveWorkspaceLayout({ containerWidth: 1920, settings: swapped });

    expect(swap.dockWidth).toBe(normal.dockWidth);
    expect(swap.mainWidth).toBeGreaterThan(swap.dockWidth);
  });

  it('落盘字段按 dock 当前停谁选，两栏的宽度互不覆盖', () => {
    expect(baseWidthKeyOf('sidebar', swapped)).toBe('sidebarBaseWidth');
    expect(baseWidthKeyOf('dock', DEFAULT_WORKSPACE_LAYOUT)).toBe('agentBaseWidth');
    expect(baseWidthKeyOf('dock', swapped)).toBe('terminalBaseWidth');

    expect(baseWidthPatch('sidebar', swapped, 300)).toEqual({ sidebarBaseWidth: 300 });
    expect(baseWidthPatch('dock', DEFAULT_WORKSPACE_LAYOUT, 640)).toEqual({ agentBaseWidth: 640 });
    expect(baseWidthPatch('dock', swapped, 640)).toEqual({ terminalBaseWidth: 640 });
  });

  it('双击复位到当前停在 dock 上的面板自己的默认宽度', () => {
    expect(defaultBaseWidthOf('dock', DEFAULT_WORKSPACE_LAYOUT)).toBe(
      DEFAULT_WORKSPACE_LAYOUT.agentBaseWidth,
    );
    expect(defaultBaseWidthOf('dock', swapped)).toBe(DEFAULT_WORKSPACE_LAYOUT.terminalBaseWidth);
    expect(defaultBaseWidthOf('sidebar', swapped)).toBe(DEFAULT_WORKSPACE_LAYOUT.sidebarBaseWidth);
  });

  it('互换后拖动同样自洽：拖动中 = 落盘读回来，且不挤主区域', () => {
    for (const containerWidth of [1136, 1280, 1440, 1920, 2560]) {
      const bounds = resolvePanelBaseBounds({
        side: 'dock',
        containerWidth,
        settings: swapped,
      });
      const stored = normalizeWorkspaceLayout(swapped);
      expect(stored.terminalBaseWidth).toBeGreaterThanOrEqual(bounds.min);
      expect(stored.terminalBaseWidth).toBeLessThanOrEqual(bounds.max);

      for (let base = bounds.min; base <= bounds.max; base += 1) {
        const during = resolveWorkspaceLayout({
          containerWidth,
          settings: { ...swapped, terminalBaseWidth: base },
        });
        const persisted = normalizeWorkspaceLayout({ ...swapped, terminalBaseWidth: base });
        expect(resolveWorkspaceLayout({ containerWidth, settings: persisted })).toEqual(during);
        expect(during.mainWidth).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_LIMITS.main.min);
      }
    }
  });

  it('切换开关只动 agentPrimary，宽度类字段原样保留（两栏各有各的记忆）', () => {
    const merged = mergeWorkspaceLayout(
      { ...DEFAULT_WORKSPACE_LAYOUT, sidebarBaseWidth: 400, agentBaseWidth: 700, terminalBaseWidth: 640 },
      { agentPrimary: true },
    );

    expect(merged).toEqual({
      sidebarBaseWidth: 400,
      agentBaseWidth: 700,
      terminalBaseWidth: 640,
      sidebarOpen: true,
      agentOpen: true,
      agentPrimary: true,
    });
  });

  it('互换后三栏都还在自己的区间里，主区域下限照旧生效', () => {
    for (const containerWidth of [1280, 1920]) {
      const swap = resolveWorkspaceLayout({ containerWidth, settings: swapped });

      expect(swap.sidebarWidth).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_LIMITS.sidebar.min);
      expect(swap.sidebarWidth).toBeLessThanOrEqual(WORKSPACE_LAYOUT_LIMITS.sidebar.max);
      expect(swap.dockWidth).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_LIMITS.dock.min);
      expect(swap.mainWidth).toBeGreaterThanOrEqual(WORKSPACE_LAYOUT_LIMITS.main.min);
      expect(swap.sidebarWidth + swap.mainWidth + swap.dockWidth).toBe(containerWidth - WORKSPACE_LAYOUT_LIMITS.navWidth);
    }
  });
});
