/**
 * 同步数据应用事件的合并刷新器。
 *
 * 后端一次 pull 会应用几十个 key（批量事件 sync-batch-applied；Fork 等单 key 路径
 * 仍发 sync-data-applied）。逐事件刷新 store 会产生事件风暴（每个会话事件一次全量
 * IPC 列表拉取）。这里统一收集、debounce 后只刷新一轮，语义与逐事件等价：
 * - settings：一次 load(true)
 * - connections / quickCommands / skills / mcpServers：各一次全量 fetch
 * - conversations：active 会话匹配时一次 loadConversation + 一次 loadConnectionConversations
 *   （后者内部有完整 diff 合并，覆盖新增/删除/更新/active 场景）
 * - secrets.webSearchApiKey：取最后到达的 deleted 值
 */

import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useQuickCommandStore } from '@/stores/quickCommandStore';
import { useSkillStore } from '@/stores/skillStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useSessionStore } from '@/stores/sessionStore';

interface PendingRefresh {
  settings: boolean;
  connections: boolean;
  quickCommands: boolean;
  skills: boolean;
  mcpServers: boolean;
  conversations: Set<string>;
  webSearchApiKey: boolean;
  webSearchDeleted: boolean;
}

const DEBOUNCE_MS = 120;

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: PendingRefresh = freshPending();

function freshPending(): PendingRefresh {
  return {
    settings: false,
    connections: false,
    quickCommands: false,
    skills: false,
    mcpServers: false,
    conversations: new Set(),
    webSearchApiKey: false,
    webSearchDeleted: false,
  };
}

/** 收集一个同步应用事件（单 key 事件或批量事件的每一项都走这里）。 */
export function collectSyncApplied(key: string, deleted: boolean): void {
  if (key === 'settings' || key.startsWith('settings.')) {
    pending.settings = true;
  } else if (key.startsWith('connections.')) {
    pending.connections = true;
  } else if (key.startsWith('quickCommands.')) {
    pending.quickCommands = true;
  } else if (key.startsWith('skills.')) {
    pending.skills = true;
  } else if (key.startsWith('mcpServers.')) {
    pending.mcpServers = true;
  } else if (key.startsWith('conversations.')) {
    pending.conversations.add(key.slice('conversations.'.length));
  } else if (key === 'secrets.webSearchApiKey') {
    pending.webSearchApiKey = true;
    pending.webSearchDeleted = deleted;
  }
  // secrets.llmApiKey 不需要前端刷新（keychain 变更不影响 UI）
  scheduleFlush();
}

function scheduleFlush(): void {
  if (timer != null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, DEBOUNCE_MS);
}

/** 立即执行一轮合并刷新（也可被测试直接调用）。 */
export async function flush(): Promise<void> {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  const p = pending;
  pending = freshPending();

  try {
    if (p.settings) {
      await useSettingsStore.getState().load(true);
    }
    if (p.connections) {
      await useConnectionStore.getState().fetchConnections();
    }
    if (p.quickCommands) {
      await useQuickCommandStore.getState().load();
    }
    if (p.skills) {
      await useSkillStore.getState().fetchSkills();
    }
    if (p.mcpServers) {
      await useMcpStore.getState().fetchServers();
    }
    if (p.webSearchApiKey) {
      useSettingsStore.setState({ hasWebSearchApiKey: !p.webSearchDeleted });
    }
    if (p.conversations.size > 0) {
      const activeId = useConversationStore.getState().activeConversationId;
      if (activeId && p.conversations.has(activeId)) {
        await useConversationStore.getState().loadConversation(activeId);
      }
      const sessionStore = useSessionStore.getState();
      const activeSessionId = sessionStore.activeSessionId;
      if (activeSessionId) {
        const session = sessionStore.sessions[activeSessionId];
        if (session?.configId) {
          await useConversationStore
            .getState()
            .loadConnectionConversations(session.configId);
        }
      }
    }
  } catch (e) {
    console.warn('[sync] 刷新 store 失败:', e);
  }
}
