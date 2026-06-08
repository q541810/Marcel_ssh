import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  displayedWidthToBaseWidth,
  normalizeWorkspaceLayout,
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

  it('converts displayed width back to a persistable base width', () => {
    const baseWidth = displayedWidthToBaseWidth(360, 1200, WORKSPACE_LAYOUT_LIMITS.sidebar.min, WORKSPACE_LAYOUT_LIMITS.sidebar.max);
    const layout = resolveWorkspaceLayout({
      containerWidth: 1200,
      settings: { ...DEFAULT_WORKSPACE_LAYOUT, sidebarBaseWidth: baseWidth, agentOpen: false },
    });

    expect(layout.sidebarWidth).toBe(360);
    expect(displayedWidthToBaseWidth(2000, 1200, WORKSPACE_LAYOUT_LIMITS.agent.min, WORKSPACE_LAYOUT_LIMITS.agent.max)).toBe(WORKSPACE_LAYOUT_LIMITS.agent.max);
  });

  it('normalizes legacy ratio settings into base widths', () => {
    const layout = normalizeWorkspaceLayout({ sidebarRatio: 0.22, agentRatio: 0.3 });

    expect(layout.sidebarBaseWidth).toBe(252);
    expect(layout.agentBaseWidth).toBe(343);
    expect(layout.sidebarOpen).toBe(true);
    expect(layout.agentOpen).toBe(true);
  });
});
