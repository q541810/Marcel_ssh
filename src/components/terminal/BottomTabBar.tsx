import { BOTTOM_TABS, type BottomTab } from '@/lib/constants';

interface BottomTabBarProps {
  activeTab: string | null;
  onTabChange: (tab: string | null) => void;
  tabs?: BottomTab[];
}

export default function BottomTabBar({ activeTab, onTabChange, tabs }: BottomTabBarProps) {
  const resolvedTabs = tabs ?? BOTTOM_TABS;

  return (
    // 终端栏窄的时候（「Agent 占主区域」把终端收进右侧固定栏，最低 300px）药丸放不下：
    // 让这一行横向滚动，而不是被父级 overflow-hidden 裁掉半截
    <div className="flex flex-shrink-0 items-center gap-1 bg-surface-sunken px-2 py-1 overflow-x-auto">
      {resolvedTabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(isActive ? null : tab.id)}
            className={`inline-flex flex-shrink-0 items-center h-7 gap-1.5 whitespace-nowrap rounded-lg px-3 text-body transition-colors pressable focus-ring ${
              isActive
                ? 'bg-surface text-fg'
                : 'text-fg-secondary hover:bg-state-soft hover:text-fg'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={tab.icon} />
            </svg>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
