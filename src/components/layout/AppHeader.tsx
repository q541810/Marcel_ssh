import { APP_NAME } from '@/lib/constants';
import { getCurrentWindow } from '@tauri-apps/api/window';
import WindowControls from '@/components/layout/WindowControls';
import { SyncStatusIndicator } from '@/components/settings/SyncStatusIndicator';
import { ArrowLeft, Sparkles } from 'lucide-react';

interface Props {
  onToggleSidebar: () => void;
  onToggleAgentPanel: () => void;
  onEnterSolo: () => void;
  isSolo?: boolean;
  className?: string;
}

export default function AppHeader({
  onToggleSidebar,
  onToggleAgentPanel,
  onEnterSolo,
  isSolo = false,
  className,
}: Props) {
  return (
    <header className={`flex items-center justify-between bg-zinc-950 border-b border-zinc-800 select-none h-8 ${className ?? ''}`}>
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
          className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          title="切换侧边栏"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
        <h1 className="text-xs font-bold tracking-wide text-zinc-200" data-tauri-drag-region>
          {APP_NAME}
        </h1>
        <SyncStatusIndicator compact />
        <div className="flex-1" data-tauri-drag-region />
        <button
          onClick={onEnterSolo}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold tracking-wide transition-colors ${
            isSolo
              ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
              : 'bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25 hover:text-indigo-200'
          }`}
          title={isSolo ? '返回工作台' : '进入 SOLO 模式'}
        >
          {isSolo ? <ArrowLeft className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
          <span>{isSolo ? '返回工作台' : 'SOLO'}</span>
        </button>
        <button
          onClick={onToggleAgentPanel}
          className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
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
