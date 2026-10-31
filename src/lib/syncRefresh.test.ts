// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as tauri from '@/lib/tauri';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useQuickCommandStore } from '@/stores/quickCommandStore';
import { useSkillStore } from '@/stores/skillStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useMemoryStore } from '@/stores/memoryStore';
import { useTaskStore } from '@/stores/taskStore';
import {
  SYNC_REFRESHERS,
  SYNC_SOURCES,
  handleSyncDataApplied,
  onSyncDataApplied,
} from './syncRefresh';

vi.mock('@/lib/tauri', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  getConnections: vi.fn(),
  quickCommandList: vi.fn(),
  skillList: vi.fn(),
  mcpListServers: vi.fn(),
  agentListConversationsByConnection: vi.fn(),
  agentLoadActiveMessages: vi.fn(),
  agentLoadPlansByConversation: vi.fn(),
  agentGetConversation: vi.fn(),
}));

vi.mock('@/lib/memoryApi', () => ({
  memoryOverview: vi.fn(),
}));

import * as memoryApi from '@/lib/memoryApi';

/**
 * 后端同步源清单的快照（`DataSourceId::sync_key` + 流驱动发的事件名）。
 * 后端新增同步源时这里必须跟着改，而 `SYNC_REFRESHERS` 的类型会逼着补刷新函数——
 * 漏了的后果是别的设备的改动落到本机后界面还显示旧数据、下一次保存再把它改回去。
 *
 * 二期 / 三期的 `conversations` / `memory` / `secrets` 是流驱动直接发的事件名
 * （不经过 `DataSourceId::sync_key`，见契约第 8 节），已经在后端 `SyncEvents::data_applied`
 * 的调用点上（`streams/config.rs`、`engine.rs` 与各流驱动）。后端 T2/T4/T6 尚未全部落地时，
 * 这里只钉「前端认得的全部源」，等它们落地后再补一条从 Rust 源码抽事件名的护栏。
 */
const BACKEND_SYNC_SOURCES = [
  'settings',
  'connections',
  'quickCommands',
  'skills',
  'mcpServers',
  'knownHosts',
  'conversations',
  'memory',
  'secrets',
];

function conversation(partial: Partial<import('@/lib/types').AgentConversation> = {}) {
  return {
    id: 'conv-1',
    connectionId: 'c1',
    title: '一段对话',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    ...partial,
  };
}

describe('同步源 → 刷新函数表', () => {
  beforeEach(() => {
    vi.mocked(tauri.getSettings).mockReset().mockResolvedValue({
      settings: { ...useSettingsStore.getInitialState().settings, fontSize: 31 },
      hasApiKey: false,
    });
    vi.mocked(tauri.getConnections).mockReset().mockResolvedValue([]);
    vi.mocked(tauri.quickCommandList).mockReset().mockResolvedValue([]);
    vi.mocked(tauri.skillList).mockReset().mockResolvedValue([]);
    vi.mocked(tauri.mcpListServers).mockReset().mockResolvedValue({ servers: [], statuses: [] });
    vi.mocked(tauri.agentListConversationsByConnection).mockReset().mockResolvedValue([conversation()]);
    vi.mocked(tauri.agentLoadActiveMessages).mockReset().mockResolvedValue({ messages: [], hasEarlier: false });
    vi.mocked(tauri.agentLoadPlansByConversation).mockReset().mockResolvedValue([]);
    vi.mocked(tauri.agentGetConversation).mockReset().mockResolvedValue(conversation());
    vi.mocked(memoryApi.memoryOverview).mockReset().mockResolvedValue({
      items: [],
      summaries: [],
    });
    useSettingsStore.setState({
      settings: useSettingsStore.getInitialState().settings,
      loaded: true,
      preview: null,
    });
    useConversationStore.setState({
      conversations: { 'conv-1': conversation() },
      // 有一条已加载的消息：`loadConnectionConversations` 只在「当前对话没有消息缓存」时才顺手
      // 读一次，这里先填上，免得它的兜底行为混进「同步落地要不要重读」的断言里。
      messages: { 'conv-1': [{ id: 'm1' } as never] },
      activeConversationId: null,
      activeConversationByConnection: {},
      activeConversationBySession: {},
    });
    useMemoryStore.setState({ overview: null, overviewError: null, revision: 0, notes: {}, batches: {} });
  });

  it('后端的每一个同步源都有刷新函数，且前端没有多余的', () => {
    expect([...SYNC_SOURCES].sort()).toEqual([...BACKEND_SYNC_SOURCES].sort());
    for (const source of BACKEND_SYNC_SOURCES) {
      expect(typeof SYNC_REFRESHERS[source as keyof typeof SYNC_REFRESHERS], `${source} 没有刷新函数`).toBe(
        'function',
      );
    }
  });

  it('settings：从后端重读进 settingsStore', async () => {
    await handleSyncDataApplied('settings');
    expect(tauri.getSettings).toHaveBeenCalled();
    expect(useSettingsStore.getState().settings.fontSize).toBe(31);
  });

  it('connections / quickCommands / skills / mcpServers：各自重读，且是静默刷新（不翻 loading）', async () => {
    const loadingSeen: boolean[] = [];
    const unsubs = [
      useConnectionStore.subscribe((s) => loadingSeen.push(s.loading)),
      useSkillStore.subscribe((s) => loadingSeen.push(s.loading)),
      useQuickCommandStore.subscribe((s) => loadingSeen.push(s.loading)),
      useMcpStore.subscribe((s) => loadingSeen.push(s.loading)),
    ];
    await handleSyncDataApplied('connections');
    await handleSyncDataApplied('quickCommands');
    await handleSyncDataApplied('skills');
    await handleSyncDataApplied('mcpServers');
    unsubs.forEach((u) => u());

    expect(tauri.getConnections).toHaveBeenCalledTimes(1);
    expect(tauri.quickCommandList).toHaveBeenCalledTimes(1);
    expect(tauri.skillList).toHaveBeenCalledTimes(1);
    expect(tauri.mcpListServers).toHaveBeenCalledTimes(1);
    expect(loadingSeen.every((v) => v === false)).toBe(true);
  });

  it('quickCommands 沿用最近一次加载用的 sessionKey', async () => {
    useQuickCommandStore.setState({ lastSessionKey: 'conn-1' });
    await handleSyncDataApplied('quickCommands');
    expect(tauri.quickCommandList).toHaveBeenCalledWith('conn-1');
  });

  it('knownHosts：前端没有缓存，什么都不用读', async () => {
    await handleSyncDataApplied('knownHosts');
    expect(tauri.getSettings).not.toHaveBeenCalled();
    expect(tauri.getConnections).not.toHaveBeenCalled();
  });

  describe('conversations：刷新对话列表，必要时重读当前对话', () => {
    /**
     * `loadConnectionConversations` 自己也会在「当前对话没有消息缓存」时读一次——
     * 那与「同步落地后要不要重读」是两件事。这里直接把 `loadConversation` 换成 spy，
     * 只看刷新逻辑自己的决定。
     */
    function spyLoadConversation() {
      const spy = vi.fn(async () => {});
      useConversationStore.setState({ loadConversation: spy });
      return spy;
    }

    it('刷新对话列表', async () => {
      await handleSyncDataApplied('conversations', ['conv-1']);
      expect(tauri.agentListConversationsByConnection).toHaveBeenCalledWith('c1');
    });

    it('当前对话在 conversationIds 里且不忙：重新加载', async () => {
      const load = spyLoadConversation();
      useConversationStore.setState({ activeConversationId: 'conv-1' });
      await handleSyncDataApplied('conversations', ['conv-1']);
      expect(load).toHaveBeenCalledWith('conv-1');
    });

    it('当前对话不在 conversationIds 里：不重读（别为一次无关的同步闪一下）', async () => {
      const load = spyLoadConversation();
      useConversationStore.setState({ activeConversationId: 'conv-1' });
      await handleSyncDataApplied('conversations', ['conv-other']);
      expect(load).not.toHaveBeenCalled();
    });

    it('当前对话正在跑任务：不重读（会冲掉流式中的卡片）', async () => {
      const load = spyLoadConversation();
      useConversationStore.setState({ activeConversationId: 'conv-1' });
      useTaskStore.setState({
        tasks: {
          t1: {
            id: 't1',
            sessionId: 's1',
            conversationId: 'conv-1',
            prompt: 'hi',
            mode: 'agent',
            status: 'executing',
            createdAt: '2026-10-01T00:00:00Z',
          },
        },
        compacting: {},
      });
      await handleSyncDataApplied('conversations', ['conv-1']);
      expect(load).not.toHaveBeenCalled();
    });

    it('当前对话已被别的设备删掉：不重读，列表里也不再有它', async () => {
      const load = spyLoadConversation();
      useConversationStore.setState({ activeConversationId: 'conv-gone' });
      vi.mocked(tauri.agentListConversationsByConnection).mockResolvedValue([]);
      await handleSyncDataApplied('conversations', ['conv-gone']);
      expect(load).not.toHaveBeenCalled();
      expect(useConversationStore.getState().conversations['conv-1']).toBeUndefined();
    });
  });

  it('memory：刷新记忆 store（作用域概览 + revision 递增）', async () => {
    // 先打开一次记忆管理页，让 store 认为「概览有人看」——同步刷新据此决定要不要重拉。
    await useMemoryStore.getState().loadOverview();
    vi.mocked(memoryApi.memoryOverview).mockClear();
    const before = useMemoryStore.getState().revision;
    await handleSyncDataApplied('memory');
    expect(memoryApi.memoryOverview).toHaveBeenCalled();
    expect(useMemoryStore.getState().revision).toBe(before + 1);
  });

  it('secrets：重读设置里的 hasXxx 标记', async () => {
    await handleSyncDataApplied('secrets');
    expect(tauri.getSettings).toHaveBeenCalled();
  });

  it('刷新失败不抛出（记日志），其它监听者照常通知', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(tauri.skillList).mockRejectedValue(new Error('读取失败'));
    const seen: string[] = [];
    const off = onSyncDataApplied((source) => seen.push(source));
    await expect(handleSyncDataApplied('skills')).resolves.toBeUndefined();
    off();
    expect(seen).toEqual(['skills']);
    errorSpy.mockRestore();
  });

  it('监听者能收到对话的会话 id；只关心 source 的老用法不受影响', async () => {
    const seen: Array<[string, readonly string[]]> = [];
    const off = onSyncDataApplied((source, ids) => seen.push([source, ids]));
    await handleSyncDataApplied('conversations', ['conv-1', 'conv-2']);
    off();
    expect(seen).toEqual([['conversations', ['conv-1', 'conv-2']]]);
  });

  it('未知同步源（后端比前端新）只告警，不当错误', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[] = [];
    const off = onSyncDataApplied((source) => seen.push(source));
    await handleSyncDataApplied('someFutureSource');
    off();
    expect(warnSpy).toHaveBeenCalled();
    expect(seen).toEqual([]);
    warnSpy.mockRestore();
  });

  it('监听者在 store 刷新完成之后才被通知（读到的一定是新数据）', async () => {
    let fontSizeWhenNotified = 0;
    const off = onSyncDataApplied(() => {
      fontSizeWhenNotified = useSettingsStore.getState().settings.fontSize;
    });
    await handleSyncDataApplied('settings');
    off();
    expect(fontSizeWhenNotified).toBe(31);
  });
});

