import { useEffect } from 'react';
import { APP_NAME } from '@/lib/constants';
import { getCurrentWindow } from '@tauri-apps/api/window';
import WindowControls from '@/components/layout/WindowControls';
import UpdatePill from '@/components/layout/UpdatePill';
import { useUpdateStore } from '@/stores/updateStore';

interface Props {
  onToggleSidebar: () => void;
  /** 收起/展开右侧固定栏的按钮。栏里停谁由 dockPanel 决定。 */
  onToggleDock: () => void;
  /** 右侧固定栏当前停的面板：决定按钮图标与提示文案（换布局后别指错东西）。 */
  dockPanel: 'agent' | 'terminal';
  className?: string;
}

export default function AppHeader({ onToggleSidebar, onToggleDock, dockPanel, className }: Props) {
  // 无感更新（桌面 Windows）：挂载时订阅 update://state + 拉取当前状态
  useEffect(() => {
    useUpdateStore.getState().init().catch(() => {});
  }, []);

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
        <UpdatePill />
        <div className="flex-1" data-tauri-drag-region />
        <button
          onClick={onToggleDock}
          className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          title={dockPanel === 'terminal' ? '切换终端面板' : '切换智能助手面板'}
        >
          {dockPanel === 'terminal' ? (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
            </svg>
          )}
        </button>
      </div>

      <WindowControls />
    </header>
  );
}
