import { describe, it, expect } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';

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
    expect(s.hideThinkingDisplay).toBe(false);
  });

  it('default agent mode settings are correct', () => {
    const am = useSettingsStore.getState().settings.agentModeSettings;
    expect(am.listMode).toBe('denylist');
    expect(am.commandList).toContain('rm');
    expect(am.confirmEachCommand).toBe(true);
  });

  it('default experimental settings are correct', () => {
    const es = useSettingsStore.getState().settings.experimentalSettings;
    expect(es.enableWebSearch).toBe(true);
    expect(es.enableHttpFetch).toBe(true);
    expect(es.enableCloudPage).toBe(false);
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
});
