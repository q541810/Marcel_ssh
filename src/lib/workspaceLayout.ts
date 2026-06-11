import type { WorkspaceLayoutSettings } from '@/lib/types';

export const WORKSPACE_LAYOUT_LIMITS = {
  navWidth: 56,
  referenceWidth: 1144,
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
  isSettingsView?: boolean;
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
  return clamp(Math.pow(availableWidth / WORKSPACE_LAYOUT_LIMITS.referenceWidth, 0.35), 0.82, 1.35);
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

  return {
    sidebarBaseWidth: clampBaseWidth(
      settings?.sidebarBaseWidth,
      WORKSPACE_LAYOUT_LIMITS.sidebar.min,
      WORKSPACE_LAYOUT_LIMITS.sidebar.max,
      legacySidebarBaseWidth,
    ),
    agentBaseWidth: clampBaseWidth(
      settings?.agentBaseWidth,
      WORKSPACE_LAYOUT_LIMITS.agent.min,
      WORKSPACE_LAYOUT_LIMITS.agent.max,
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
  isSettingsView = false,
}: ResolveWorkspaceLayoutInput): ResolvedWorkspaceLayout {
  const layout = normalizeWorkspaceLayout(settings);
  const availableWidth = Math.max(0, containerWidth - WORKSPACE_LAYOUT_LIMITS.navWidth);
  const scale = resolveWorkspaceScale(containerWidth);
  const effectiveSidebarOpen = !isSettingsView && (sidebarOpen ?? layout.sidebarOpen);
  const effectiveAgentOpen = !isSettingsView && (agentOpen ?? layout.agentOpen);

  if (availableWidth <= 0) {
    return { sidebarWidth: 0, mainWidth: 0, agentWidth: 0 };
  }

  if (!effectiveSidebarOpen && !effectiveAgentOpen) {
    return { sidebarWidth: 0, mainWidth: availableWidth, agentWidth: 0 };
  }

  const sidebarDesired = effectiveSidebarOpen
    ? clamp(
        Math.round(layout.sidebarBaseWidth * scale),
        WORKSPACE_LAYOUT_LIMITS.sidebar.min,
        WORKSPACE_LAYOUT_LIMITS.sidebar.max,
      )
    : 0;
  const agentDesired = effectiveAgentOpen
    ? clamp(
        Math.round(layout.agentBaseWidth * scale),
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

export function displayedWidthToBaseWidth(
  width: number,
  containerWidth: number,
  min: number,
  max: number,
): number {
  return clampBaseWidth(width / resolveWorkspaceScale(containerWidth), min, max, min);
}
