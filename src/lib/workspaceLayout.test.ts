import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  resolveWorkspaceLayout,
  widthToWorkspaceRatio,
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

    expect(layout.sidebarWidth).toBe(WORKSPACE_LAYOUT_LIMITS.sidebar.max);
    expect(layout.agentWidth).toBeGreaterThan(650);
    expect(layout.agentWidth).toBeLessThanOrEqual(WORKSPACE_LAYOUT_LIMITS.agent.max);
  });

  it('protects the main column on narrow screens', () => {
    const layout = resolveWorkspaceLayout({ containerWidth: 900, settings: DEFAULT_WORKSPACE_LAYOUT });

    expect(layout.sidebarWidth).toBe(WORKSPACE_LAYOUT_LIMITS.sidebar.min);
    expect(layout.mainWidth).toBe(WORKSPACE_LAYOUT_LIMITS.main.min);
    expect(layout.agentWidth).toBe(64);
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

  it('hides side panels in settings view', () => {
    const layout = resolveWorkspaceLayout({
      containerWidth: 1600,
      settings: DEFAULT_WORKSPACE_LAYOUT,
      isSettingsView: true,
    });

    expect(layout).toEqual({ sidebarWidth: 0, mainWidth: 1544, agentWidth: 0 });
  });

  it('clamps extreme saved ratios', () => {
    const layout = resolveWorkspaceLayout({
      containerWidth: 1800,
      settings: { sidebarRatio: 0.9, agentRatio: 0.9, sidebarOpen: true, agentOpen: true },
    });

    expect(layout.sidebarWidth).toBe(WORKSPACE_LAYOUT_LIMITS.sidebar.max);
    expect(layout.agentWidth).toBe(WORKSPACE_LAYOUT_LIMITS.agent.max);
    expect(layout.mainWidth).toBe(604);
  });

  it('converts displayed width back to a persistable ratio', () => {
    expect(widthToWorkspaceRatio(360, 1200)).toBeCloseTo(360 / 1144);
    expect(widthToWorkspaceRatio(2000, 1200)).toBe(0.45);
  });
});
