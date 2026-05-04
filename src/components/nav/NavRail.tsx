import { useState, type ReactNode } from 'react';
import Modal from '../ui/Modal';

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
    icon: (
      // server / connection icon
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M5 12H3l9-9 9 9h-2M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7M9 21V12h6v9" />
      </svg>
    ),
  },
  {
    value: 'skills',
    label: '技能',
    icon: (
      // lightning / bolt icon
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
  },
  {
    value: 'mcp',
    label: '自定义 MCP',
    icon: (
      // puzzle / plugin icon
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M14.121 4.879A3 3 0 0119 7v3h2a2 2 0 110 4h-2v3a2 2 0 01-2 2h-3v2a2 2 0 11-4 0v-2H7a2 2 0 01-2-2v-3a3 3 0 110-6V7a2 2 0 012-2h3V3a2 2 0 114 0v2a3 3 0 01.121-.121z" />
      </svg>
    ),
  },
];

const HELP_ITEM: NavItem = {
  value: 'settings',
  label: '帮助',
  icon: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
};

const BOTTOM_ITEM: NavItem = {
  value: 'settings',
  label: '设置',
  icon: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
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
      <Modal open={helpOpen} onClose={() => setHelpOpen(false)} title="终端使用指南">
        <div className="px-4 py-3 text-sm text-zinc-300 space-y-2">
          <p>
            <span className="text-zinc-100 font-medium">Ctrl+C 正常执行：</span>
            直接按下 Ctrl+C，按照 SSH 逻辑正常执行命令中断操作。
          </p>
          <p>
            <span className="text-zinc-100 font-medium">Ctrl+C 复制：</span>
            先用鼠标框选要复制的文字，然后再按 Ctrl+C，按照 Windows 逻辑执行复制操作。
          </p>
          <p>
            <span className="text-zinc-100 font-medium">右键粘贴：</span>
            在终端区域右键点击，默认执行粘贴操作。
          </p>
        </div>
      </Modal>
    </nav>
  );
}
