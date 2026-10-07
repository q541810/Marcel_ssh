import type { WorkspaceLayoutSettings } from '@/lib/types';

/**
 * 面板宽度的两套坐标，改这里之前先分清：
 * - `sidebar.min/max`、`dock.min/max` 是**显示宽度**（屏幕上真实的像素），夹取发生在 resolve 里；
 * - 落盘存的是**基准宽度**（`*BaseWidth`），显示宽度 = 基准 × scale，scale 随窗口宽变化。
 * 两套坐标必须严格互逆（见 baseWidthBounds），否则拖拽松手会跳。
 *
 * 拓扑固定为「左侧栏 + 中间主区域(flex-1) + 右侧固定栏」。右侧那一栏是可拖宽、可收起的
 * **dock 槽位**：默认停 Agent 面板，开启「Agent 占主区域」（`agentPrimary`）后与终端互换——
 * Agent 去主区域，终端停进 dock。所以宽度求解只认槽位，dock 的基准宽度按当前停的面板取。
 */
export const WORKSPACE_LAYOUT_LIMITS = {
  navWidth: 56,
  referenceWidth: 1144,
  /** 缩放系数的夹取边界：基准宽度换算显示宽度时用的就是它。 */
  scale: { min: 0.82, max: 1.35 },
  sidebar: {
    min: 220,
    max: 560,
    defaultBaseWidth: 280,
  },
  /** 右侧固定栏的几何：Agent 面板与终端栏共用同一套可用区间。 */
  dock: {
    min: 300,
    compactMin: 260,
    max: 1100,
    defaultBaseWidth: 460,
    /**
     * 终端停进 dock 时的默认基准宽度。与 Agent 停 dock 时同值：互换换的是谁在中间主区域，
     * 右侧窄栏的默认宽度不变——终端想更宽自己拖（上限与其他一切照旧）。
     */
    terminalDefaultBaseWidth: 460,
  },
  /** 主区域（flex-1）：默认停终端，互换后停 Agent 面板，两套内容共用同一套几何。 */
  main: {
    min: 560,
  },
} as const;

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayoutSettings = {
  sidebarBaseWidth: WORKSPACE_LAYOUT_LIMITS.sidebar.defaultBaseWidth,
  agentBaseWidth: WORKSPACE_LAYOUT_LIMITS.dock.defaultBaseWidth,
  terminalBaseWidth: WORKSPACE_LAYOUT_LIMITS.dock.terminalDefaultBaseWidth,
  sidebarOpen: true,
  agentOpen: true,
  agentPrimary: false,
};

export interface ResolvedWorkspaceLayout {
  sidebarWidth: number;
  mainWidth: number;
  /** 右侧固定栏的宽度：默认是 Agent 面板，开启「Agent 占主区域」后是终端栏。 */
  dockWidth: number;
}

interface ResolveWorkspaceLayoutInput {
  containerWidth: number;
  settings?: Partial<WorkspaceLayoutSettings> | null;
  sidebarOpen?: boolean;
  agentOpen?: boolean;
  isExclusive?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const clampBaseWidth = (value: number | undefined, min: number, max: number, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return clamp(Math.round(value), min, max);
};

const legacyRatioToBaseWidth = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.round(WORKSPACE_LAYOUT_LIMITS.referenceWidth * clamp(value, 0.12, 0.45));
};

/** 右侧固定栏当前承载的面板：默认 Agent 面板，开启「Agent 占主区域」后是终端栏。 */
export function dockPanelOf(
  settings?: Partial<WorkspaceLayoutSettings> | null,
): 'agent' | 'terminal' {
  return settings?.agentPrimary ? 'terminal' : 'agent';
}

/**
 * 右侧固定栏的基准宽度落在哪个设置字段。拖动结束后要按这里写回——互换模式下写的是
 * 终端自己的宽度，两栏各有各的记忆，来回切换不会互相顶掉对方的宽度。
 */
export function baseWidthKeyOf(
  side: PanelSide,
  settings?: Partial<WorkspaceLayoutSettings> | null,
): 'sidebarBaseWidth' | 'agentBaseWidth' | 'terminalBaseWidth' {
  if (side === 'sidebar') return 'sidebarBaseWidth';
  return dockPanelOf(settings) === 'terminal' ? 'terminalBaseWidth' : 'agentBaseWidth';
}

/** 右侧固定栏的基准宽度（已归一），求解器与拖拽区间都从这里取。 */
export function dockBaseWidthOf(settings?: Partial<WorkspaceLayoutSettings> | null): number {
  const layout = normalizeWorkspaceLayout(settings);
  return layout.agentPrimary ? layout.terminalBaseWidth : layout.agentBaseWidth;
}

/**
 * 把一次拖动的结果写成设置 patch——落盘字段按「dock 现在停谁」决定，调用方不用自己判断。
 * 与 `baseWidthKeyOf` 同一个判断点（`dockPanelOf`），两者不会漂。
 */
export function baseWidthPatch(
  side: PanelSide,
  settings: Partial<WorkspaceLayoutSettings> | null | undefined,
  base: number,
): Partial<WorkspaceLayoutSettings> {
  if (side === 'sidebar') return { sidebarBaseWidth: base };
  return dockPanelOf(settings) === 'terminal'
    ? { terminalBaseWidth: base }
    : { agentBaseWidth: base };
}

/** 双击把手复位到的基准宽度：按 dock 现在停的面板取各自的默认值。 */
export function defaultBaseWidthOf(
  side: PanelSide,
  settings?: Partial<WorkspaceLayoutSettings> | null,
): number {
  if (side === 'sidebar') return DEFAULT_WORKSPACE_LAYOUT.sidebarBaseWidth;
  return dockPanelOf(settings) === 'terminal'
    ? DEFAULT_WORKSPACE_LAYOUT.terminalBaseWidth
    : DEFAULT_WORKSPACE_LAYOUT.agentBaseWidth;
}

export function resolveWorkspaceScale(containerWidth: number): number {
  const availableWidth = Math.max(1, containerWidth - WORKSPACE_LAYOUT_LIMITS.navWidth);
  return clamp(
    Math.pow(availableWidth / WORKSPACE_LAYOUT_LIMITS.referenceWidth, 0.35),
    WORKSPACE_LAYOUT_LIMITS.scale.min,
    WORKSPACE_LAYOUT_LIMITS.scale.max,
  );
}

/**
 * 基准宽度的合法区间，由显示宽度的区间反推：
 * 显示下限在最大缩放下对应最小基准，显示上限在最小缩放下对应最大基准。
 * 取到这个宽度（而不是直接拿显示区间当基准区间），才能让
 * 「显示值 → 基准值 → 显示值」在任意窗口宽度下都是恒等变换——否则
 * 拖到显示下限松手时，基准值会被自己的下限顶回去，面板当场弹回来。
 */
export function baseWidthBounds(minDisplayed: number, maxDisplayed: number) {
  return {
    min: Math.round(minDisplayed / WORKSPACE_LAYOUT_LIMITS.scale.max),
    max: Math.round(maxDisplayed / WORKSPACE_LAYOUT_LIMITS.scale.min),
  };
}

/** 基准宽度 → 实际显示宽度。面板渲染、落盘后的还原走的都是这一条。 */
export function displayedWidthFromBaseWidth(
  baseWidth: number,
  containerWidth: number,
  min: number,
  max: number,
): number {
  return clamp(Math.round(baseWidth * resolveWorkspaceScale(containerWidth)), min, max);
}

/**
 * 把一次布局改动并进现有设置：缺项补默认、非法值夹取。落盘的每一条路径都必须过这里
 * （拖动落盘、设置页开关各写一份的话，加字段时必然漏一边）。
 */
export function mergeWorkspaceLayout(
  current: Partial<WorkspaceLayoutSettings> | null | undefined,
  patch: Partial<WorkspaceLayoutSettings>,
): WorkspaceLayoutSettings {
  return normalizeWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, ...current, ...patch });
}

export function normalizeWorkspaceLayout(
  settings?: Partial<WorkspaceLayoutSettings> | null,
): WorkspaceLayoutSettings {
  const legacySidebarBaseWidth = legacyRatioToBaseWidth(
    settings?.sidebarRatio,
    DEFAULT_WORKSPACE_LAYOUT.sidebarBaseWidth,
  );
  const legacyAgentBaseWidth = legacyRatioToBaseWidth(
    settings?.agentRatio,
    DEFAULT_WORKSPACE_LAYOUT.agentBaseWidth,
  );
  const sidebarBounds = baseWidthBounds(
    WORKSPACE_LAYOUT_LIMITS.sidebar.min,
    WORKSPACE_LAYOUT_LIMITS.sidebar.max,
  );
  const dockBounds = baseWidthBounds(
    WORKSPACE_LAYOUT_LIMITS.dock.min,
    WORKSPACE_LAYOUT_LIMITS.dock.max,
  );

  return {
    sidebarBaseWidth: clampBaseWidth(
      settings?.sidebarBaseWidth,
      sidebarBounds.min,
      sidebarBounds.max,
      legacySidebarBaseWidth,
    ),
    agentBaseWidth: clampBaseWidth(
      settings?.agentBaseWidth,
      dockBounds.min,
      dockBounds.max,
      legacyAgentBaseWidth,
    ),
    terminalBaseWidth: clampBaseWidth(
      settings?.terminalBaseWidth,
      dockBounds.min,
      dockBounds.max,
      DEFAULT_WORKSPACE_LAYOUT.terminalBaseWidth,
    ),
    sidebarOpen: settings?.sidebarOpen ?? DEFAULT_WORKSPACE_LAYOUT.sidebarOpen,
    agentOpen: settings?.agentOpen ?? DEFAULT_WORKSPACE_LAYOUT.agentOpen,
    // 旧配置没有这一项：按默认 false 走，即保持原布局（不因为升级换位置）
    agentPrimary: settings?.agentPrimary ?? DEFAULT_WORKSPACE_LAYOUT.agentPrimary,
  };
}

export function resolveWorkspaceLayout({
  containerWidth,
  settings,
  sidebarOpen,
  agentOpen,
  isExclusive = false,
}: ResolveWorkspaceLayoutInput): ResolvedWorkspaceLayout {
  const layout = normalizeWorkspaceLayout(settings);
  const availableWidth = Math.max(0, containerWidth - WORKSPACE_LAYOUT_LIMITS.navWidth);
  const effectiveSidebarOpen = !isExclusive && (sidebarOpen ?? layout.sidebarOpen);
  const effectiveDockOpen = !isExclusive && (agentOpen ?? layout.agentOpen);
  const dockLimits = WORKSPACE_LAYOUT_LIMITS.dock;
  const dockBaseWidth = layout.agentPrimary ? layout.terminalBaseWidth : layout.agentBaseWidth;

  if (availableWidth <= 0) {
    return { sidebarWidth: 0, mainWidth: 0, dockWidth: 0 };
  }

  if (!effectiveSidebarOpen && !effectiveDockOpen) {
    return { sidebarWidth: 0, mainWidth: availableWidth, dockWidth: 0 };
  }

  const sidebarDesired = effectiveSidebarOpen
    ? displayedWidthFromBaseWidth(
        layout.sidebarBaseWidth,
        containerWidth,
        WORKSPACE_LAYOUT_LIMITS.sidebar.min,
        WORKSPACE_LAYOUT_LIMITS.sidebar.max,
      )
    : 0;
  const dockDesired = effectiveDockOpen
    ? displayedWidthFromBaseWidth(
        dockBaseWidth,
        containerWidth,
        dockLimits.min,
        dockLimits.max,
      )
    : 0;

  const sideMin =
    (effectiveSidebarOpen ? WORKSPACE_LAYOUT_LIMITS.sidebar.min : 0) +
    (effectiveDockOpen ? dockLimits.min : 0);
  const compactSideMin =
    (effectiveSidebarOpen ? WORKSPACE_LAYOUT_LIMITS.sidebar.min : 0) +
    (effectiveDockOpen ? dockLimits.compactMin : 0);

  if (availableWidth <= WORKSPACE_LAYOUT_LIMITS.main.min + sideMin) {
    const sidebarWidth = effectiveSidebarOpen ? WORKSPACE_LAYOUT_LIMITS.sidebar.min : 0;
    const remainingForDock = availableWidth - WORKSPACE_LAYOUT_LIMITS.main.min - sidebarWidth;
    const dockWidth = effectiveDockOpen && availableWidth >= WORKSPACE_LAYOUT_LIMITS.main.min + compactSideMin
      ? Math.max(dockLimits.compactMin, remainingForDock)
      : 0;
    return {
      sidebarWidth,
      dockWidth,
      mainWidth: Math.max(0, availableWidth - sidebarWidth - dockWidth),
    };
  }

  let sidebarWidth = sidebarDesired;
  let dockWidth = dockDesired;
  let mainWidth = availableWidth - sidebarWidth - dockWidth;

  if (mainWidth < WORKSPACE_LAYOUT_LIMITS.main.min) {
    let deficit = WORKSPACE_LAYOUT_LIMITS.main.min - mainWidth;

    const dockSlack = effectiveDockOpen ? Math.max(0, dockWidth - dockLimits.min) : 0;
    const sidebarSlack = effectiveSidebarOpen ? Math.max(0, sidebarWidth - WORKSPACE_LAYOUT_LIMITS.sidebar.min) : 0;
    const totalSlack = dockSlack + sidebarSlack;

    if (totalSlack > 0) {
      const dockReduction = Math.min(
        dockSlack,
        Math.round(deficit * (dockSlack / totalSlack)),
      );
      const sidebarReduction = Math.min(sidebarSlack, deficit - dockReduction);
      dockWidth -= dockReduction;
      sidebarWidth -= sidebarReduction;
      deficit -= dockReduction + sidebarReduction;
    }

    if (deficit > 0 && effectiveDockOpen) {
      const reducible = Math.min(deficit, dockWidth - dockLimits.min);
      dockWidth -= reducible;
      deficit -= reducible;
    }

    if (deficit > 0 && effectiveSidebarOpen) {
      const reducible = Math.min(deficit, sidebarWidth - WORKSPACE_LAYOUT_LIMITS.sidebar.min);
      sidebarWidth -= reducible;
    }
    mainWidth = availableWidth - sidebarWidth - dockWidth;
  }

  return { sidebarWidth, mainWidth, dockWidth };
}

export type PanelSide = 'sidebar' | 'dock';

export interface PanelBaseBounds {
  /** 可拖到的基准宽度区间（含首尾）。 */
  min: number;
  max: number;
  /** 上面这个区间对应的显示宽度（屏幕上能拖到的范围），给 aria 与光标提示用。 */
  minDisplayed: number;
  maxDisplayed: number;
  /** 区间退化（显示宽度再拖也不会变）时为 false：把手不提示可拖。 */
  draggable: boolean;
}

interface PanelBaseBoundsInput {
  side: PanelSide;
  containerWidth: number;
  settings?: Partial<WorkspaceLayoutSettings> | null;
  sidebarOpen?: boolean;
  agentOpen?: boolean;
  isExclusive?: boolean;
}

/**
 * 一次拖动的可调范围（基准宽度），拿 resolveWorkspaceLayout 自己当预言机：
 * 从最小基准往上扫，凡是「会让另一个侧栏变窄」的基准值都不收。
 *
 * 墙必须由求解器算出来，不能另写一套几何：正中那栏的下限（main.min）在拖动期间
 * 必须当场生效，否则松手后求解器会按 slack 比例把两侧一起砍——表现就是
 * 「我拖左边，右边那一栏跟着变窄」。
 * 代价是每次算一遍线性扫描（最多约 1500 次纯计算），只在窗口尺寸/设置变化时算。
 *
 * 扫描结果还要**收紧到显示宽度真的会响应的范围**：显示宽撞到墙之后会贴死
 * （主区域下限、面板自身显示上下限、侧栏贴底时主区域下限的墙全吃在 dock 上），
 * 墙那侧的基准再增大显示也不动——若把这段基准也放进可拖区间，拖动松手落盘的
 * 就是永远撞墙的值，下一次拖拽得先把这段虚高消费完面板才肯动（指针拖出去
 * 几百像素没有任何响应）。所以下限取「仍贴着显示下限」的最后一个基准，
 * 上限取「刚达到显示上限」的第一个基准。
 *
 * 区间是**当前停在 dock 上的那个面板**的基准宽度区间；调用方写回设置时按
 * `baseWidthKeyOf(side, settings)` 取字段，别自己猜。
 */
export function resolvePanelBaseBounds({
  side,
  containerWidth,
  settings,
  sidebarOpen,
  agentOpen,
  isExclusive,
}: PanelBaseBoundsInput): PanelBaseBounds {
  const limits = side === 'sidebar' ? WORKSPACE_LAYOUT_LIMITS.sidebar : WORKSPACE_LAYOUT_LIMITS.dock;
  const baseKey = baseWidthKeyOf(side, settings);
  const otherKey = side === 'sidebar' ? 'dockWidth' : 'sidebarWidth';
  const mineKey = side === 'sidebar' ? 'sidebarWidth' : 'dockWidth';
  const bounds = baseWidthBounds(limits.min, limits.max);
  const shared = { containerWidth, sidebarOpen, agentOpen, isExclusive };
  const at = (base: number) =>
    resolveWorkspaceLayout({ ...shared, settings: { ...settings, [baseKey]: base } });
  const otherRest = resolveWorkspaceLayout({ ...shared, settings })[otherKey];

  // 显示宽度取的是求解器的输出，不是 base × scale：被 deficit 修过的值才是屏幕上真实的宽度，
  // 用公式算出来的数字会偏大（比如 1280 宽下区间末端公式给 289，实际只会到 261）。
  const minDisplayed = at(bounds.min)[mineKey];
  let maxDisplayed = minDisplayed;
  const reachable: Array<[number, number]> = [];
  for (let base = bounds.min; base <= bounds.max; base += 1) {
    const layout = at(base);
    if (layout[otherKey] < otherRest) continue;
    reachable.push([base, layout[mineKey]]);
    if (layout[mineKey] > maxDisplayed) maxDisplayed = layout[mineKey];
  }

  // 退化：窗口太窄把显示压死时（draggable=false），整个可达集显示都一样，
  // 保持旧的宽松区间即可（把手不会提示可拖，区间只被复位路径读到）。
  if (maxDisplayed <= minDisplayed) {
    const last = reachable.length > 0 ? reachable[reachable.length - 1][0] : bounds.min;
    return { min: bounds.min, max: last, minDisplayed, maxDisplayed, draggable: false };
  }

  let min = bounds.min;
  let max = bounds.min;
  for (const [base, display] of reachable) {
    if (display <= minDisplayed) min = base;
  }
  for (const [base, display] of reachable) {
    if (display >= maxDisplayed) {
      max = base;
      break;
    }
  }

  return { min, max, minDisplayed, maxDisplayed, draggable: maxDisplayed > minDisplayed };
}
