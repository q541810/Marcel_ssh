import { Bot, Folder, Settings, Terminal } from 'lucide-react';
import { MOBILE_TABS, type MobileTabId } from './tabs';

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
  return (
    <nav
      className="flex flex-shrink-0 border-t border-zinc-800 bg-zinc-950"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
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
            className={`flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[11px] transition-colors ${
              active ? 'text-indigo-400' : 'text-zinc-500 active:text-zinc-300'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
