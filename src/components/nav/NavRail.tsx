import { useState, type ReactNode } from 'react';
import { Terminal, Wand, Plug, HelpCircle, Settings } from 'lucide-react';
import HelpModal from '../HelpModal';

export type NavView = 'sessions' | 'skills' | 'mcp' | 'settings';

interface Props {
  active: NavView;
  onChange: (view: NavView) => void;
}

interface NavItem {
  value: NavView;
  label: string;
  icon: ReactNode;
}

const TOP_ITEMS: NavItem[] = [
  {
    value: 'sessions',
    label: '会话',
    icon: <Terminal className="w-5 h-5" />,
  },
  {
    value: 'skills',
    label: '技能',
    icon: <Wand className="w-5 h-5" />,
  },
  {
    value: 'mcp',
    label: '自定义 MCP',
    icon: <Plug className="w-5 h-5" />,
  },
];

const HELP_ITEM: NavItem = {
  value: 'settings',
  label: '帮助',
  icon: <HelpCircle className="w-5 h-5" />,
};

const BOTTOM_ITEM: NavItem = {
  value: 'settings',
  label: '设置',
  icon: <Settings className="w-5 h-5" />,
};

function NavButton({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={item.label}
      aria-label={item.label}
      className={`
        relative flex items-center justify-center w-12 h-12 rounded-lg transition-colors
        ${
          active
            ? 'bg-zinc-800 text-indigo-400'
            : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60'
        }
      `}
    >
      {/* Active indicator bar on the left edge */}
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r bg-indigo-400" />
      )}
      {item.icon}
    </button>
  );
}

export default function NavRail({ active, onChange }: Props) {
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <nav className="flex flex-col items-center justify-between w-14 flex-shrink-0 bg-zinc-950 border-r border-zinc-800 py-2">
      <div className="flex flex-col gap-1">
        {TOP_ITEMS.map((item) => (
          <NavButton
            key={item.value}
            item={item}
            active={active === item.value}
            onClick={() => onChange(item.value)}
          />
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <NavButton
          item={HELP_ITEM}
          active={false}
          onClick={() => setHelpOpen(true)}
        />
        <NavButton
          item={BOTTOM_ITEM}
          active={active === BOTTOM_ITEM.value}
          onClick={() => onChange(BOTTOM_ITEM.value)}
        />
      </div>
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </nav>
  );
}
