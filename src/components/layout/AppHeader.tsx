import { useEffect } from 'react';
import { PanelLeft, SquareTerminal, Sparkles } from 'lucide-react';
import { APP_NAME } from '@/lib/constants';
import { getCurrentWindow } from '@tauri-apps/api/window';
import WindowControls from '@/components/layout/WindowControls';
import UpdatePill from '@/components/layout/UpdatePill';
import SyncStatusButton from '@/components/layout/SyncStatusButton';
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
    <header className={`flex items-center justify-between bg-surface-sunken select-none h-8 ${className ?? ''}`}>
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
          className="pressable focus-ring flex h-6 w-6 items-center justify-center rounded-md text-fg-secondary hover:bg-state-soft hover:text-fg"
          title="切换侧边栏"
        >
          <PanelLeft size={16} strokeWidth={1.5} />
        </button>
        <h1 className="text-meta font-medium text-fg-secondary" data-tauri-drag-region>
          {APP_NAME}
        </h1>
        <UpdatePill />
        <div className="flex-1" data-tauri-drag-region />
        <SyncStatusButton />
        <button
          onClick={onToggleDock}
          className="pressable focus-ring flex h-6 w-6 items-center justify-center rounded-md text-fg-secondary hover:bg-state-soft hover:text-fg"
          title={dockPanel === 'terminal' ? '切换终端面板' : '切换智能助手面板'}
        >
          {dockPanel === 'terminal' ? (
            <SquareTerminal size={16} strokeWidth={1.5} />
          ) : (
            <Sparkles size={16} strokeWidth={1.5} />
          )}
        </button>
      </div>

      <WindowControls />
    </header>
  );
}
