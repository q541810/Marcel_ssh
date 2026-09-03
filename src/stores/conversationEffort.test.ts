import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';

const { agentSetSessionEffort, agentGetSessionEffort, agentSetSessionModel } = vi.hoisted(() => ({
  agentSetSessionEffort: vi.fn(),
  agentGetSessionEffort: vi.fn(),
  agentSetSessionModel: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  agentSetSessionEffort,
  agentGetSessionEffort,
  agentSetSessionModel,
}));

// setConversationEffort 只依赖 tauri.agentSetSessionEffort 与本地 store 同步，
// 不触碰其它 tauri 函数，因此这里 mock 最小集即可。
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

/** 构造含一个模型的 llmRegistry 并 hydrate（供 effectiveModelId 解析）。 */
function setupRegistryWithModel() {
  const model = {
    id: 'model-1',
    channelId: 'ch-1',
    modelName: 'deepseek-reasoner',
    displayName: 'Reasoner',
    temperature: 0.1,
    vision: false,
    contextWindow: 0,
    extraBody: null,
    reasoningEfforts: ['low', 'high', 'max'],
  };
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getInitialState().settings,
      llmRegistry: {
        channels: [
          { id: 'ch-1', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', enabled: true },
        ],
        models: [model],
        slots: { modelApprovalModelId: '', summarizerModelId: '' },
        lastUsedModelId: 'model-1',
        netPolicy: useSettingsStore.getInitialState().settings.llmRegistry.netPolicy,
      },
    },
    loaded: true,
  });
  return model;
}

describe('conversationStore.setConversationEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentSetSessionEffort.mockResolvedValue(undefined);
    agentGetSessionEffort.mockResolvedValue(null);
    setupRegistryWithModel();
    useConversationStore.setState({
      conversations: {
        'conv-1': {
          id: 'conv-1',
          connectionId: 'conn-1',
          title: 't',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          reasoningEffort: null,
        },
      },
      activeConversationId: 'conv-1',
    });
  });

  it('persists effort keyed by the effective model id and syncs local conversation', async () => {
    // 会话未手动切模型 → 生效模型 = 全局最近使用 model-1
    await useConversationStore.getState().setConversationEffort('conv-1', 'high');
    expect(agentSetSessionEffort).toHaveBeenCalledWith('conv-1', 'model-1', 'high');
    expect(
      useConversationStore.getState().conversations['conv-1'].reasoningEffort,
    ).toBe('high');
  });

  it('clears effort on null (follow model default)', async () => {
    await useConversationStore.getState().setConversationEffort('conv-1', null);
    expect(agentSetSessionEffort).toHaveBeenCalledWith('conv-1', 'model-1', null);
    expect(
      useConversationStore.getState().conversations['conv-1'].reasoningEffort,
    ).toBeNull();
  });
});
