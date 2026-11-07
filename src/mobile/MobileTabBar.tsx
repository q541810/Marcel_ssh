import { Bot, Folder, Settings, Terminal } from 'lucide-react';
import { MOBILE_TABS, type MobileTabId } from './tabs';
import { useTaskStore } from '@/stores/taskStore';
import { useSyncStore } from '@/stores/syncStore';
import { needsAttention } from '@/lib/syncModel';
import { StatusDot } from '@/components/settings/sync/syncUi';
import { getActiveRunningTasks } from '@/stores/agentStatusSelectors';
import { AgentStatusIndicator } from '@/components/agent/AgentStatusIndicator';

const ICONS: Record<MobileTabId, typeof Terminal> = {
  terminal: Terminal,
  agent: Bot,
  files: Folder,
  settings: Settings,
};

interface MobileTabBarProps {
  activeTab: MobileTabId;
  onTabChange: (tab: MobileTabId) => void;
}

export default function MobileTabBar({
  activeTab,
  onTabChange,
}: MobileTabBarProps) {
  const tasks = useTaskStore((s) => s.tasks);
  const unreadCompletedConversations = useTaskStore(
    (s) => s.unreadCompletedConversations,
  );
  // 同步需要处理时，「设置」图标上亮一个点——手机没有顶栏，这是它唯一不打扰又够显眼的位置。
  const syncState = useSyncStore((s) => s.status?.state);
  const runningTasks = getActiveRunningTasks(tasks);
  const hasRunningAgent = runningTasks.length > 0;
  const hasWaitingApproval = runningTasks.some(
    (t) => t.status === 'waiting_approval',
  );
  const hasUnreadCompleted = unreadCompletedConversations.length > 0;

  const agentTabVisualStatus = hasWaitingApproval
    ? 'waiting_approval'
    : hasRunningAgent
      ? 'running'
      : hasUnreadCompleted
        ? 'unread_completed'
        : 'idle';
  return (
    <nav
      className="flex flex-shrink-0 border-t border-edge-subtle bg-surface-sunken"
      style={{
        paddingBottom:
          'max(env(safe-area-inset-bottom, 0px), var(--nav-bar-bottom, 0px))',
      }}
      aria-label="主导航"
    >
      {MOBILE_TABS.map((tab) => {
        const Icon = ICONS[tab.id];
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={`relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-caption transition-colors focus-ring ${
              active ? 'text-indigo-400' : 'text-fg-tertiary active:text-fg-secondary'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            <div className="relative">
              <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} />
              {tab.id === 'settings' && needsAttention(syncState) && (
                <span className="absolute -top-0.5 -right-1.5">
                  <StatusDot tone={syncState === 'error' ? 'error' : 'warn'} />
                  <span className="sr-only">同步需要处理</span>
                </span>
              )}
              {tab.id === 'agent' && (
                <span className="absolute -top-1 -right-2">
                  <AgentStatusIndicator status={agentTabVisualStatus} size="xs" />
                </span>
              )}
            </div>
            <span>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
