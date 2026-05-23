import { useEffect, useState, useRef, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { APP_NAME } from '@/lib/constants';
import NavRail, { type NavView } from '@/components/nav/NavRail';
import ConnectionList from '@/components/connection/ConnectionList';
import McpList from '@/components/mcp/McpList';
import SkillList from '@/components/skill/SkillList';
import Settings from '@/components/settings/Settings';
import Terminal from '@/components/terminal/Terminal';
import TabBar from '@/components/terminal/TabBar';
import AgentPanel from '@/components/agent/AgentPanel';
import WindowControls from '@/components/ui/WindowControls';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAgentStore } from '@/stores/agentStore';
import { useSkillStore } from '@/stores/skillStore';
import { checkUpdate } from '@/lib/tauri';
import type { AgentMode } from '@/lib/types';

const AGENT_PANEL_MIN_WIDTH = 260;
const AGENT_PANEL_MAX_WIDTH = 800;
const AGENT_PANEL_DEFAULT_WIDTH = 320;

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);
  const [agentPanelWidth, setAgentPanelWidth] = useState(AGENT_PANEL_DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const [navView, setNavView] = useState<NavView>('sessions');
  const [updateToast, setUpdateToast] = useState<{ version: string; url: string } | null>(null);

  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const defaultAgentMode = useSettingsStore((s) => s.settings.defaultAgentMode);
  const setAgentMode = useAgentStore((s) => s.setMode);
  const fetchSkills = useSkillStore((s) => s.fetchSkills);

  useEffect(() => {
    loadSettings().catch(err => {
      console.error('Failed to load settings:', err);
    });
    fetchSkills().catch(err => {
      console.error('Failed to load skills:', err);
    });
    checkUpdate().then(res => {
      if (res.hasUpdate) setUpdateToast({ version: res.latestVersion, url: res.releaseUrl });
    }).catch(() => {});
  }, [loadSettings, fetchSkills]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const valid: AgentMode[] = ['chat', 'agent', 'auto'];
    if ((valid as string[]).includes(defaultAgentMode)) {
      setAgentMode(defaultAgentMode as AgentMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  const handleNavChange = (view: NavView) => {
    setNavView(view);
    if (view === 'sessions' || view === 'skills' || view === 'mcp') {
      setSidebarOpen(true);
    }
  };

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeStartRef.current = { x: e.clientX, width: agentPanelWidth };
    setIsResizing(true);
  }, [agentPanelWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeStartRef.current) return;
      const delta = resizeStartRef.current.x - e.clientX;
      const newWidth = resizeStartRef.current.width + delta;
      setAgentPanelWidth(Math.min(AGENT_PANEL_MAX_WIDTH, Math.max(AGENT_PANEL_MIN_WIDTH, newWidth)));
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      resizeStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  const isSettingsView = navView === 'settings';

  return (
    <div className="flex flex-col h-screen bg-zinc-900 text-zinc-100 overflow-hidden">
      <header className="flex items-center justify-between bg-zinc-950 border-b border-zinc-800 select-none h-8">
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
            onClick={() => setSidebarOpen((v) => !v)}
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
          <div className="flex-1" data-tauri-drag-region />
          <button
            onClick={() => setAgentPanelOpen((v) => !v)}
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

      <div className="flex flex-1 overflow-hidden">
          <NavRail active={navView} onChange={handleNavChange} />

        <aside
          className="flex-shrink-0 bg-zinc-900 border-r border-zinc-800 overflow-hidden"
          style={{
            width: sidebarOpen && !isSettingsView ? '16rem' : '0rem',
            borderRightWidth: sidebarOpen && !isSettingsView ? '1px' : '0px',
            transition: 'width 200ms cubic-bezier(0.16, 1, 0.3, 1), border-right-width 200ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div style={{ width: '16rem', height: '100%' }}>
            {navView === 'sessions' && <ConnectionList />}
            {navView === 'skills' && <SkillList />}
            {navView === 'mcp' && <McpList />}
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
          <TabBar />
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ display: isSettingsView ? 'none' : 'flex' }}>
            <Terminal />
          </main>

          {isSettingsView && (
            <div className="absolute inset-0 flex flex-col min-w-0 overflow-hidden bg-zinc-900">
              <Settings />
            </div>
          )}
        </div>

        <div
          className="flex overflow-hidden flex-shrink-0"
          style={{
            width: agentPanelOpen && !isSettingsView ? `${agentPanelWidth + 4}px` : '0px',
            transition: isResizing ? 'none' : 'width 300ms var(--spring-bounce, cubic-bezier(0.34, 1.56, 0.64, 1))',
          }}
        >
          <div
            className="w-1 cursor-col-resize hover:bg-indigo-500/50 transition-colors z-10 flex-shrink-0"
            onMouseDown={handleResizeMouseDown}
            style={{ touchAction: 'none' }}
          />
          <aside
            className="overflow-hidden border-l border-zinc-800 flex-shrink-0"
            style={{
              width: `${agentPanelWidth}px`,
            }}
          >
            <AgentPanel />
          </aside>
        </div>
      </div>

      {/* Update toast */}
      {updateToast && (
        <div className="fixed bottom-4 right-4 z-50 animate-slide-up">
          <div className="bg-black text-white rounded-xl shadow-2xl border border-zinc-700 px-4 py-3">
            <div className="flex items-start gap-3">
              <a
                href={updateToast.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 flex-1 min-w-0 hover:opacity-80 transition-opacity"
              >
                <svg className="w-5 h-5 flex-shrink-0 text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-white">新版本 {updateToast.version} 可用</p>
                  <p className="text-xs text-zinc-400 mt-0.5">点击前往 GitHub 下载</p>
                </div>
              </a>
              <button
                onClick={() => setUpdateToast(null)}
                className="flex-shrink-0 p-0.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                aria-label="关闭"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
