import { useEffect, useRef } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useQuickCommandStore } from '@/stores/quickCommandStore';
import { useSkillStore } from '@/stores/skillStore';
import { useMcpStore } from '@/stores/mcpStore';
import { conversationIsBusy, useConversationStore } from '@/stores/conversationStore';
import { useConversationHistoryStore } from '@/stores/conversationHistoryManager';
import { useMemoryStore } from '@/stores/memoryStore';
import { getErrorMessage } from '@/lib/errors';

/**
 * 跨设备同步：后端把别的设备的改动落到本机某个同步源后会发 `sync-data-applied { source, conversationIds }`，
 * 前端必须把对应的内存 store 重新读一遍——否则界面还在显示旧数据，而下一次用户在界面上
 * 动一下就会把旧数据整份存回去，等于把刚同步来的改动又改回去（还会被当成本机改动同步出去）。
 *
 * 这里是「同步源 → 刷新函数」的唯一一张表。后端新增同步源时：
 * 1. 在 `SYNC_SOURCES` 里加上它的 key（与后端 `DataSourceId::sync_key` / 流驱动发的事件名一致，跨版本稳定）；
 * 2. `Record<SyncSource, …>` 的类型会逼着在 `SYNC_REFRESHERS` 里补一个刷新函数；
 * 3. `syncRefresh.test.ts` 里的后端 source 清单快照也要同步（它钉住「后端每个 source 都有人刷新」）。
 */
export const SYNC_SOURCES = [
  'settings',
  'connections',
  'quickCommands',
  'skills',
  'mcpServers',
  'knownHosts',
  // 二期：对话与记忆（两条流各自发事件）
  'conversations',
  'memory',
  // 三期：密钥链里的机密
  'secrets',
] as const;

export type SyncSource = (typeof SYNC_SOURCES)[number];

/** 落地事件里除 source 之外还带了什么（目前只有对话流带会话 id）。 */
export interface SyncAppliedContext {
  /**
   * 这一批落地改到了哪些会话（其它源为空）。
   * 用来决定「当前打开的那段对话」要不要重读——没被改到的对话不该因为一次同步而闪一下。
   */
  conversationIds: readonly string[];
}

type Refresher = (context: SyncAppliedContext) => Promise<void> | void;

/**
 * 刷新当前连接的对话列表，并在当前打开的那段对话确实被改到、而且没在跑任务时重读消息。
 *
 * 两条边界：
 * - **在跑的对话不动**：后端对运行中的会话本来就会延后落地改写，前端重读只会把流式中的
 *   tool 卡片冲掉（与 `switchConversation` 里「running 不重载」同一个理由）。
 * - **对方删掉的对话不重读**：列表刷新后它已经不在 `conversations` 里，再去读会得到一次
 *   无意义的失败。
 */
async function refreshConversations(conversationIds: readonly string[]): Promise<void> {
  const before = useConversationStore.getState();
  const connectionIds = new Set<string>();
  for (const conversation of Object.values(before.conversations)) {
    connectionIds.add(conversation.connectionId);
  }
  // 逐个连接刷新列表：别的设备新建 / 改名 / 置顶 / 删除的会话都要出现在 Agent 面板里。
  for (const connectionId of connectionIds) {
    await useConversationStore.getState().loadConnectionConversations(connectionId);
  }

  // 历史记录弹层已经加载过这条连接时，把它的索引也一起刷新（没打开就不必付这份查询）。
  const history = useConversationHistoryStore.getState();
  if (before.activeConversationId) {
    const activeConnectionId = before.conversations[before.activeConversationId]?.connectionId;
    if (activeConnectionId && history.conversationsByConn[activeConnectionId]) {
      await history.loadConnectionConversations(activeConnectionId);
    }
  }

  const current = useConversationStore.getState();
  const activeId = current.activeConversationId;
  if (!activeId || !conversationIds.includes(activeId)) return;
  if (conversationIsBusy(activeId)) return;
  if (!current.conversations[activeId]) return;
  await current.loadConversation(activeId);
}

export const SYNC_REFRESHERS: Record<SyncSource, Refresher> = {
  // 设置走自己的串行队列（与保存互斥），见 settingsStore.refreshFromBackend。
  settings: () => useSettingsStore.getState().refreshFromBackend(),
  // 以下都用静默刷新：同步是后台发生的事，列表不该因此闪一下「加载中」。
  connections: () => useConnectionStore.getState().fetchConnections({ silent: true }),
  quickCommands: () => {
    const { lastSessionKey, load } = useQuickCommandStore.getState();
    return load(lastSessionKey, { silent: true });
  },
  skills: () => useSkillStore.getState().fetchSkills({ silent: true }),
  mcpServers: () => useMcpStore.getState().fetchServers({ silent: true }),
  // 已知主机指纹只在后端连接时校验，前端没有缓存，无需刷新。
  knownHosts: () => undefined,
  conversations: ({ conversationIds }) => refreshConversations(conversationIds),
  // 记忆列表 / 作用域概览 + 注入缓存（revision 变了，对话头部的「记忆 N」会重取）。
  memory: () => useMemoryStore.getState().refreshFromBackend(),
  // 密钥链里的 Key / 密码落地后，设置页的 hasXxx 标记要跟着变。
  secrets: () => useSettingsStore.getState().refreshFromBackend(),
};

function isSyncSource(source: string): source is SyncSource {
  return (SYNC_SOURCES as readonly string[]).includes(source);
}

type AppliedListener = (source: SyncSource, conversationIds: readonly string[]) => void;
const appliedListeners = new Set<AppliedListener>();

/**
 * 订阅「某个同步源被别的设备的改动更新了」。给**自己持有本地状态**（没走上面那些 store）的
 * 界面用，例如手机端快捷命令管理页。刷新函数已经跑完（store 里是新数据）之后才通知。
 *
 * 第二个参数是对话流落地时的会话 id（其它源为空数组）；老监听者只写一个参数也照常可用。
 */
export function onSyncDataApplied(listener: AppliedListener): () => void {
  appliedListeners.add(listener);
  return () => {
    appliedListeners.delete(listener);
  };
}

/**
 * React 版：卸载自动退订；回调不必 memo。`sources` 为空 = 任何源都通知。
 *
 * `conversationIds` 是可选第二个参数：只关心「哪个源变了」的调用方不必声明它。
 */
export function useSyncDataApplied(
  sources: readonly SyncSource[],
  callback: (source: SyncSource, conversationIds: readonly string[]) => void,
): void {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  const key = sources.join(',');
  useEffect(() => {
    const wanted = key ? key.split(',') : [];
    return onSyncDataApplied((source, conversationIds) => {
      if (wanted.length === 0 || wanted.includes(source)) cbRef.current(source, conversationIds);
    });
  }, [key]);
}

/**
 * `sync-data-applied` 的处理入口：刷新对应 store，再通知本地状态型界面。
 * 未知 source（后端比前端新）只记一条日志，不当成错误——旧前端不认识的数据源本来就没有界面。
 */
export async function handleSyncDataApplied(
  source: string,
  conversationIds: readonly string[] = [],
): Promise<void> {
  if (!isSyncSource(source)) {
    console.warn(`[sync] 收到未知的同步源 ${source}，前端没有对应的刷新函数`);
    return;
  }
  const context: SyncAppliedContext = { conversationIds };
  try {
    await SYNC_REFRESHERS[source](context);
  } catch (err) {
    console.error(`[sync] 刷新 ${source} 失败:`, getErrorMessage(err));
  }
  for (const listener of [...appliedListeners]) {
    try {
      listener(source, conversationIds);
    } catch (err) {
      console.error('[sync] 同步落地监听器抛错:', getErrorMessage(err));
    }
  }
}
