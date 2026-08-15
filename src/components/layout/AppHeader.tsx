import { useState } from 'react';
import { APP_NAME } from '@/lib/constants';
import { getCurrentWindow } from '@tauri-apps/api/window';
import WindowControls from '@/components/layout/WindowControls';
import WinIcon from '@/components/ui/WinIcon';
import { SyncStatusIndicator } from '@/components/settings/SyncStatusIndicator';

interface Props {
  onToggleSidebar: () => void;
  onToggleAgentPanel: () => void;
  className?: string;
}

export default function AppHeader({ onToggleSidebar, onToggleAgentPanel, className }: Props) {
  const [menuPressed, setMenuPressed] = useState(false);

  return (
    <header className={`flex items-center justify-between win-acrylic border-b border-zinc-800 select-none h-8 ${className ?? ''}`}>
      <div
        className="flex items-center gap-3 px-2 flex-1"
        data-tauri-drag-region
        onMouseDown={async (e) => {
          if (e.button !== 0) return;
          const target = e.target as HTMLElement;
          if (target.closest('button')) return;
          if (!target.closest('[data-tauri-drag-region]')) return;
          const appWindow = getCurrentWindow();
          if (await appWindow.isMaximized()) {
            await appWindow.unmaximize();
          }
        }}
      >
        <button
          onClick={onToggleSidebar}
          className="win-icon-btn win-icon-btn--sm"
          title="切换侧边栏"
          onPointerDown={() => setMenuPressed(true)}
          onPointerUp={() => setMenuPressed(false)}
          onPointerLeave={() => setMenuPressed(false)}
        >
          <WinIcon
            glyph="hamburger"
            size={16}
            className={`animated-icon-hamburger ${menuPressed ? 'pressing' : 'releasing'}`}
          />
        </button>
        <h1 className="text-xs font-bold tracking-wide text-zinc-200" data-tauri-drag-region>
          {APP_NAME}
        </h1>
        <SyncStatusIndicator compact />
        <div className="flex-1" data-tauri-drag-region />
        <button
          onClick={onToggleAgentPanel}
          className="win-icon-btn win-icon-btn--sm"
          title="切换智能助手面板"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
          </svg>
        </button>
      </div>

      <WindowControls />
    </header>
  );
}
