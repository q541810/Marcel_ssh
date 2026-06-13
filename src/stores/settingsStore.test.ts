import { beforeEach, describe, it, expect, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';

vi.mock('@/lib/tauri', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

describe('settingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: useSettingsStore.getInitialState().settings,
      loaded: false,
      hasApiKey: false,
      preview: null,
    });
  });

  it('has correct default settings', () => {
    const s = useSettingsStore.getState().settings;
    expect(s.fontSize).toBe(14);
    expect(s.defaultAgentMode).toBe('agent');
    expect(s.panelHeight).toBe(256);
    expect(s.fileManagerShowHidden).toBe(false);
    expect(s.fileManagerPath).toBe('/');
    expect(s.fileManagerPaths).toEqual({});
    expect(s.folderUploadCompressionLevel).toBe(6);
    expect(s.hideThinkingDisplay).toBe(false);
    expect(s.whipEnabled).toBe(false);
    expect(s.whipCrackSpeed).toBe(240);
    expect(s.whipAutoInputEnabled).toBe(true);
    expect(s.whipPhrases).toContain('快点干活，别磨蹭。');
    expect(s.workspaceLayout).toEqual({
      sidebarBaseWidth: 280,
      agentBaseWidth: 460,
      sidebarOpen: true,
      agentOpen: true,
    });
  });

  it('default agent mode settings are correct', () => {
    const am = useSettingsStore.getState().settings.agentModeSettings;
    expect(am.listMode).toBe('denylist');
    expect(am.commandList).toContain('rm');
    expect(am.confirmEachCommand).toBe(true);
  });

  it('default experimental settings are correct', () => {
    const es = useSettingsStore.getState().settings.experimentalSettings;
    expect(es).toBeDefined();
    expect(es?.enableWebSearch).toBe(true);
    expect(es?.enableHttpFetch).toBe(true);
    expect(es?.enableCloudPage).toBe(false);
  });

  it('default terminal colors are defined', () => {
    const c = useSettingsStore.getState().settings.terminalColors;
    expect(c.background).toBeTruthy();
    expect(c.foreground).toBeTruthy();
    expect(c.red).toBeTruthy();
  });

  it('setPreview updates preview state', () => {
    useSettingsStore.getState().setPreview({ fontSize: 18 });
    expect(useSettingsStore.getState().preview).toEqual({ fontSize: 18 });
  });

  it('clearPreview clears preview state', () => {
    useSettingsStore.getState().setPreview({ fontSize: 18 });
    useSettingsStore.getState().clearPreview();
    expect(useSettingsStore.getState().preview).toBeNull();
  });

  it('warning starts null and clearWarning is idempotent', () => {
    expect(useSettingsStore.getState().warning).toBeNull();
    useSettingsStore.setState({ warning: 'something went wrong' });
    expect(useSettingsStore.getState().warning).toBe('something went wrong');
    useSettingsStore.getState().clearWarning();
    expect(useSettingsStore.getState().warning).toBeNull();
  });
});
