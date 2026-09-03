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
      hasWebSearchApiKey: false,
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
    expect(s.fileManagerTreeWidth).toBe(200);
    expect(s.fileManagerTreeUserHidden).toBe(false);
    expect(s.folderUploadCompressionLevel).toBe(6);
    expect(s.hideThinkingDisplay).toBe(false);
    expect(s.privacyMode).toBe(false);
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
    expect(am.enableModelCommandApproval).toBe(false);
    expect(am.modelApprovalPrompt).toBe('');
    expect(am.confirmEditFile).toBe(true);
  });

  it('default llm registry is empty (channels/models/slots)', () => {
    const r = useSettingsStore.getState().settings.llmRegistry;
    expect(r).toBeDefined();
    expect(r.channels).toEqual([]);
    expect(r.models).toEqual([]);
    expect(r.slots).toEqual({
      modelApprovalModelId: '',
      summarizerModelId: '',
    });
    expect(r.lastUsedModelId).toBeUndefined();
  });

  it('normalizes a partial llmRegistry (missing fields get defaults)', () => {
    useSettingsStore.getState().hydrateFromBootstrap({
      settings: {
        ...useSettingsStore.getState().settings,
        llmRegistry: {
          channels: [],
          models: [],
          // slots 缺失 → 默认空槽位（兼容旧数据）
        } as never,
      },
      hasApiKey: false,
      hasWebSearchApiKey: false,
    });
    const r = useSettingsStore.getState().settings.llmRegistry;
    expect(r.slots).toEqual({
      modelApprovalModelId: '',
      summarizerModelId: '',
    });
  });

  it('normalizeRegistry dedupes same-id model entries on hydrate (heal old bug)', () => {
    const ch = { id: 'ch-1', name: '默认渠道', baseUrl: 'https://x/v1', enabled: true };
    const m = {
      id: 'm-1',
      channelId: 'ch-1',
      modelName: 'gemini-3.7-flash',
      displayName: '',
      temperature: 0.1,
      vision: false,
      contextWindow: 0,
      extraBody: null,
      reasoningEfforts: [],
    };
    // 历史「保存渠道」合并 bug 的产物：同 id 两条
    useSettingsStore.getState().hydrateFromBootstrap({
      settings: {
        ...useSettingsStore.getState().settings,
        llmRegistry: {
          channels: [ch],
          models: [m, { ...m }],
          slots: { modelApprovalModelId: '', summarizerModelId: '' },
        } as never,
      },
      hasApiKey: false,
      hasWebSearchApiKey: false,
    });
    const models = useSettingsStore.getState().settings.llmRegistry.models;
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('m-1');
  });

  it('hydrate preserves a valid lastUsedModelId (global last-used survives restart)', () => {
    const ch = { id: 'ch-1', name: '默认渠道', baseUrl: 'https://x/v1', enabled: true };
    const m = {
      id: 'm-1',
      channelId: 'ch-1',
      modelName: 'gemini-3.7-flash',
      displayName: '',
      temperature: 0.1,
      vision: false,
      contextWindow: 0,
      extraBody: null,
      reasoningEfforts: [],
    };
    useSettingsStore.getState().hydrateFromBootstrap({
      settings: {
        ...useSettingsStore.getState().settings,
        llmRegistry: {
          channels: [ch],
          models: [m],
          slots: { modelApprovalModelId: '', summarizerModelId: '' },
          lastUsedModelId: 'm-1',
        } as never,
      },
      hasApiKey: false,
      hasWebSearchApiKey: false,
    });
    expect(useSettingsStore.getState().settings.llmRegistry.lastUsedModelId).toBe('m-1');
  });

  it('hydrate drops a dangling lastUsedModelId (points to deleted model)', () => {
    const ch = { id: 'ch-1', name: '默认渠道', baseUrl: 'https://x/v1', enabled: true };
    const m = {
      id: 'm-1',
      channelId: 'ch-1',
      modelName: 'gemini-3.7-flash',
      displayName: '',
      temperature: 0.1,
      vision: false,
      contextWindow: 0,
      extraBody: null,
      reasoningEfforts: [],
    };
    useSettingsStore.getState().hydrateFromBootstrap({
      settings: {
        ...useSettingsStore.getState().settings,
        llmRegistry: {
          channels: [ch],
          models: [m],
          slots: { modelApprovalModelId: '', summarizerModelId: '' },
          lastUsedModelId: 'ghost-deleted-model',
        } as never,
      },
      hasApiKey: false,
      hasWebSearchApiKey: false,
    });
    expect(useSettingsStore.getState().settings.llmRegistry.lastUsedModelId).toBeUndefined();
  });

  it('default experimental settings are correct', () => {
    const es = useSettingsStore.getState().settings.experimentalSettings;
    expect(es).toBeDefined();
    expect(es?.enableWebSearch).toBe(true);
    expect(es?.enableHttpFetch).toBe(true);
    expect(es?.enableCloudPage).toBe(false);
    expect(es?.webSearchMode).toBe('browser');
    expect(es?.webSearchApiProvider).toBe('brave');
    expect(es?.webSearchEndpoint).toBe('cn');
    expect(es?.httpFetchMode).toBe('browser');
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

  it('disabledPlugins defaults to empty array', () => {
    expect(useSettingsStore.getState().settings.disabledPlugins).toEqual([]);
  });

  it('disabledPlugins survives setState round-trip', () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, disabledPlugins: ['a', 'b'] },
    });
    expect(useSettingsStore.getState().settings.disabledPlugins).toEqual(['a', 'b']);
  });

  it('hydrates from bootstrap snapshot correctly', () => {
    useSettingsStore.getState().hydrateFromBootstrap({
      settings: {
        ...useSettingsStore.getState().settings,
        fontSize: 18,
      },
      hasApiKey: true,
      hasWebSearchApiKey: false,
      warning: 'test-warning',
    });

    const state = useSettingsStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.hasApiKey).toBe(true);
    expect(state.settings.fontSize).toBe(18);
    expect(state.warning).toBe('test-warning');
  });
});
