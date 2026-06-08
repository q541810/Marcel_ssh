import type { WorkspaceLayoutSettings } from '@/lib/types';

export const WORKSPACE_LAYOUT_LIMITS = {
  navWidth: 56,
  sidebar: {
    min: 220,
    max: 420,
    defaultRatio: 0.22,
  },
  agent: {
    min: 300,
    max: 720,
    defaultRatio: 0.3,
  },
  main: {
    min: 560,
  },
} as const;

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayoutSettings = {
  sidebarRatio: WORKSPACE_LAYOUT_LIMITS.sidebar.defaultRatio,
  agentRatio: WORKSPACE_LAYOUT_LIMITS.agent.defaultRatio,
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

const clampRatio = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return clamp(value, 0.12, 0.45);
};

export function normalizeWorkspaceLayout(
  settings?: Partial<WorkspaceLayoutSettings> | null,
): WorkspaceLayoutSettings {
  return {
    sidebarRatio: clampRatio(settings?.sidebarRatio, DEFAULT_WORKSPACE_LAYOUT.sidebarRatio),
    agentRatio: clampRatio(settings?.agentRatio, DEFAULT_WORKSPACE_LAYOUT.agentRatio),
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
        Math.round(availableWidth * layout.sidebarRatio),
        WORKSPACE_LAYOUT_LIMITS.sidebar.min,
        WORKSPACE_LAYOUT_LIMITS.sidebar.max,
      )
    : 0;
  const agentDesired = effectiveAgentOpen
    ? clamp(
        Math.round(availableWidth * layout.agentRatio),
        WORKSPACE_LAYOUT_LIMITS.agent.min,
        WORKSPACE_LAYOUT_LIMITS.agent.max,
      )
    : 0;

  const sideMin =
    (effectiveSidebarOpen ? WORKSPACE_LAYOUT_LIMITS.sidebar.min : 0) +
    (effectiveAgentOpen ? WORKSPACE_LAYOUT_LIMITS.agent.min : 0);

  if (availableWidth <= WORKSPACE_LAYOUT_LIMITS.main.min + sideMin) {
    const sidebarWidth = effectiveSidebarOpen ? WORKSPACE_LAYOUT_LIMITS.sidebar.min : 0;
    const agentWidth = effectiveAgentOpen
      ? Math.max(0, availableWidth - WORKSPACE_LAYOUT_LIMITS.main.min - sidebarWidth)
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
    if (effectiveAgentOpen) {
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

export function widthToWorkspaceRatio(width: number, containerWidth: number): number {
  const availableWidth = Math.max(1, containerWidth - WORKSPACE_LAYOUT_LIMITS.navWidth);
  return clamp(width / availableWidth, 0.12, 0.45);
}
