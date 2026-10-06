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
    <div className="flex flex-shrink-0 items-center gap-2 border-t border-zinc-800 bg-zinc-900 px-3 py-1.5 overflow-x-auto">
      {resolvedTabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(isActive ? null : tab.id)}
            className={`inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              isActive
                ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.icon} />
            </svg>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
