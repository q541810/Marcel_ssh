interface BottomTabBarProps {
  activeTab: string | null;
  onTabChange: (tab: string | null) => void;
}

export default function BottomTabBar({ activeTab, onTabChange }: BottomTabBarProps) {
  const tabs = [
    { id: 'quick-command', icon: 'M13 10V3L4 14h7v7l9-11h-7z', label: '快捷指令' },
    { id: 'process', icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z', label: '进程管理' },
    { id: 'file-manager', icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z', label: '文件管理' },
  ];

  return (
    <div className="flex flex-shrink-0 items-center gap-2 border-t border-zinc-800 bg-zinc-900 px-3 py-1.5">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(isActive ? null : tab.id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
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
