import type { WorkspaceLayoutSettings } from '@/lib/types';

/**
 * 面板宽度的两套坐标，改这里之前先分清：
 * - `sidebar.min/max`、`agent.min/max` 是**显示宽度**（屏幕上真实的像素），夹取发生在 resolve 里；
 * - 落盘存的是**基准宽度**（`*BaseWidth`），显示宽度 = 基准 × scale，scale 随窗口宽变化。
 * 两套坐标必须严格互逆（见 baseWidthBounds），否则拖拽松手会跳。
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
  agent: {
    min: 300,
    compactMin: 260,
    max: 1100,
    defaultBaseWidth: 460,
  },
  main: {
    min: 560,
  },
} as const;

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayoutSettings = {
  sidebarBaseWidth: WORKSPACE_LAYOUT_LIMITS.sidebar.defaultBaseWidth,
  agentBaseWidth: WORKSPACE_LAYOUT_LIMITS.agent.defaultBaseWidth,
  sidebarOpen: true,
  agentOpen: true,
};

export interface ResolvedWorkspaceLayout {
  sidebarWidth: number;
  mainWidth: number;
  agentWidth: number;
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
  const agentBounds = baseWidthBounds(
    WORKSPACE_LAYOUT_LIMITS.agent.min,
    WORKSPACE_LAYOUT_LIMITS.agent.max,
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
      agentBounds.min,
      agentBounds.max,
      legacyAgentBaseWidth,
    ),
    sidebarOpen: settings?.sidebarOpen ?? DEFAULT_WORKSPACE_LAYOUT.sidebarOpen,
    agentOpen: settings?.agentOpen ?? DEFAULT_WORKSPACE_LAYOUT.agentOpen,
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
  const effectiveAgentOpen = !isExclusive && (agentOpen ?? layout.agentOpen);

  if (availableWidth <= 0) {
    return { sidebarWidth: 0, mainWidth: 0, agentWidth: 0 };
  }

  if (!effectiveSidebarOpen && !effectiveAgentOpen) {
    return { sidebarWidth: 0, mainWidth: availableWidth, agentWidth: 0 };
  }

  const sidebarDesired = effectiveSidebarOpen
    ? displayedWidthFromBaseWidth(
        layout.sidebarBaseWidth,
        containerWidth,
        WORKSPACE_LAYOUT_LIMITS.sidebar.min,
        WORKSPACE_LAYOUT_LIMITS.sidebar.max,
      )
    : 0;
  const agentDesired = effectiveAgentOpen
    ? displayedWidthFromBaseWidth(
        layout.agentBaseWidth,
        containerWidth,
        WORKSPACE_LAYOUT_LIMITS.agent.min,
        WORKSPACE_LAYOUT_LIMITS.agent.max,
      )
    : 0;

  const sideMin =
    (effectiveSidebarOpen ? WORKSPACE_LAYOUT_LIMITS.sidebar.min : 0) +
    (effectiveAgentOpen ? WORKSPACE_LAYOUT_LIMITS.agent.min : 0);
  const compactSideMin =
    (effectiveSidebarOpen ? WORKSPACE_LAYOUT_LIMITS.sidebar.min : 0) +
    (effectiveAgentOpen ? WORKSPACE_LAYOUT_LIMITS.agent.compactMin : 0);

  if (availableWidth <= WORKSPACE_LAYOUT_LIMITS.main.min + sideMin) {
    const sidebarWidth = effectiveSidebarOpen ? WORKSPACE_LAYOUT_LIMITS.sidebar.min : 0;
    const remainingForAgent = availableWidth - WORKSPACE_LAYOUT_LIMITS.main.min - sidebarWidth;
    const agentWidth = effectiveAgentOpen && availableWidth >= WORKSPACE_LAYOUT_LIMITS.main.min + compactSideMin
      ? Math.max(WORKSPACE_LAYOUT_LIMITS.agent.compactMin, remainingForAgent)
      : 0;
    return {
      sidebarWidth,
      agentWidth,
      mainWidth: Math.max(0, availableWidth - sidebarWidth - agentWidth),
    };
  }

  let sidebarWidth = sidebarDesired;
  let agentWidth = agentDesired;
  let mainWidth = availableWidth - sidebarWidth - agentWidth;

  if (mainWidth < WORKSPACE_LAYOUT_LIMITS.main.min) {
    let deficit = WORKSPACE_LAYOUT_LIMITS.main.min - mainWidth;

    const agentSlack = effectiveAgentOpen ? Math.max(0, agentWidth - WORKSPACE_LAYOUT_LIMITS.agent.min) : 0;
    const sidebarSlack = effectiveSidebarOpen ? Math.max(0, sidebarWidth - WORKSPACE_LAYOUT_LIMITS.sidebar.min) : 0;
    const totalSlack = agentSlack + sidebarSlack;

    if (totalSlack > 0) {
      const agentReduction = Math.min(
        agentSlack,
        Math.round(deficit * (agentSlack / totalSlack)),
      );
      const sidebarReduction = Math.min(sidebarSlack, deficit - agentReduction);
      agentWidth -= agentReduction;
      sidebarWidth -= sidebarReduction;
      deficit -= agentReduction + sidebarReduction;
    }

    if (deficit > 0 && effectiveAgentOpen) {
      const reducible = Math.min(deficit, agentWidth - WORKSPACE_LAYOUT_LIMITS.agent.min);
      agentWidth -= reducible;
      deficit -= reducible;
    }

    if (deficit > 0 && effectiveSidebarOpen) {
      const reducible = Math.min(deficit, sidebarWidth - WORKSPACE_LAYOUT_LIMITS.sidebar.min);
      sidebarWidth -= reducible;
    }
    mainWidth = availableWidth - sidebarWidth - agentWidth;
  }

  return { sidebarWidth, mainWidth, agentWidth };
}

export type PanelSide = 'sidebar' | 'agent';

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
 * 「我拖左边，右边的 Agent 栏跟着变窄」。
 * 代价是每次算一遍线性扫描（最多约 1500 次纯计算），只在窗口尺寸/设置变化时算。
 */
export function resolvePanelBaseBounds({
  side,
  containerWidth,
  settings,
  sidebarOpen,
  agentOpen,
  isExclusive,
}: PanelBaseBoundsInput): PanelBaseBounds {
  const limits = side === 'sidebar' ? WORKSPACE_LAYOUT_LIMITS.sidebar : WORKSPACE_LAYOUT_LIMITS.agent;
  const baseKey = side === 'sidebar' ? 'sidebarBaseWidth' : 'agentBaseWidth';
  const otherKey = side === 'sidebar' ? 'agentWidth' : 'sidebarWidth';
  const mineKey = side === 'sidebar' ? 'sidebarWidth' : 'agentWidth';
  const bounds = baseWidthBounds(limits.min, limits.max);
  const shared = { containerWidth, sidebarOpen, agentOpen, isExclusive };
  const at = (base: number) =>
    resolveWorkspaceLayout({ ...shared, settings: { ...settings, [baseKey]: base } });
  const otherRest = resolveWorkspaceLayout({ ...shared, settings })[otherKey];

  // 显示宽度取的是求解器的输出，不是 base × scale：被 deficit 修过的值才是屏幕上真实的宽度，
  // 用公式算出来的数字会偏大（比如 1280 宽下区间末端公式给 289，实际只会到 261）。
  let max = bounds.min;
  const minDisplayed = at(bounds.min)[mineKey];
  let maxDisplayed = minDisplayed;
  for (let base = bounds.min; base <= bounds.max; base += 1) {
    const layout = at(base);
    if (layout[otherKey] < otherRest) continue;
    max = base;
    if (layout[mineKey] > maxDisplayed) maxDisplayed = layout[mineKey];
  }

  return { min: bounds.min, max, minDisplayed, maxDisplayed, draggable: maxDisplayed > minDisplayed };
}
