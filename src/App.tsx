import { useEffect, useState, useRef, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { APP_NAME } from '@/lib/constants';
import NavRail, { type NavView } from '@/components/nav/NavRail';
import ConnectionList from '@/components/connection/ConnectionList';
import McpList from '@/components/mcp/McpList';
import Settings from '@/components/settings/Settings';
import Terminal from '@/components/terminal/Terminal';
import TabBar from '@/components/terminal/TabBar';
import AgentPanel from '@/components/agent/AgentPanel';
import WindowControls from '@/components/ui/WindowControls';
import CrashDialog from '@/components/crash/CrashDialog';
import { crashCheckPrevious } from '@/lib/tauri';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAgentStore } from '@/stores/agentStore';
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
  // Currently selected nav view. `settings` takes over the whole main area,
  // while `sessions` and `mcp` swap the sidebar contents.
  const [navView, setNavView] = useState<NavView>('sessions');
  
  // Crash detection state
  const [showCrashDialog, setShowCrashDialog] = useState(false);

  // Bootstrap: load persisted settings once, then apply defaults derived from them.
  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const defaultAgentMode = useSettingsStore((s) => s.settings.defaultAgentMode);
  const setAgentMode = useAgentStore((s) => s.setMode);

  useEffect(() => {
    // Load settings asynchronously without blocking render
    loadSettings().catch(err => {
      console.error('Failed to load settings:', err);
    });
  }, [loadSettings]);

  // Check for previous crash on mount
  useEffect(() => {
    const checkCrash = async () => {
      try {
        const crashInfo = await crashCheckPrevious();
        if (crashInfo) {
          setShowCrashDialog(true);
        }
      } catch (err) {
        console.error('Failed to check crash status:', err);
      }
    };
    checkCrash();
  }, []);

  // Apply default agent mode once settings are loaded from disk.
  useEffect(() => {
    if (!settingsLoaded) return;
    const valid: AgentMode[] = ['chat', 'agent', 'auto'];
    if ((valid as string[]).includes(defaultAgentMode)) {
      setAgentMode(defaultAgentMode as AgentMode);
    }
    // Intentionally only runs when settings finish loading; we don't want to
    // override the user's in-session mode changes afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  // When user picks a sidebar-resident view, ensure the sidebar is visible.
  const handleNavChange = (view: NavView) => {
    setNavView(view);
    if (view === 'sessions' || view === 'mcp') {
      setSidebarOpen(true);
    }
  };

  // ── Agent panel resize handlers ──
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
      {/* Crash Dialog - shown when previous crash detected */}
      {showCrashDialog && (
        <CrashDialog onDismiss={() => setShowCrashDialog(false)} />
      )}
      
      {/* Top bar - Custom Title Bar */}
      <header className="flex items-center justify-between bg-zinc-950 border-b border-zinc-800 select-none h-8">
        {/* Draggable area - left side */}
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

        {/* Window controls - NOT in drag region */}
        <WindowControls />
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Far-left navigation rail (always visible) */}
        <NavRail active={navView} onChange={handleNavChange} />

        {/* Sidebar — content depends on navView (hidden on settings) */}
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
            {navView === 'mcp' && <McpList />}
          </div>
        </aside>

        {/* Center — Terminal area (always mounted, hidden behind settings) */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
          {/* Tab bar — only visible when there are sessions */}
          <TabBar />
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ display: isSettingsView ? 'none' : 'flex' }}>
            <Terminal />
          </main>

          {/* Settings view (overlays terminal area) */}
          {isSettingsView && (
            <div className="absolute inset-0 flex flex-col min-w-0 overflow-hidden bg-zinc-900">
              <Settings />
            </div>
          )}
        </div>

        {/* Right panel — Agent (hidden on settings) */}
        <div
          className="flex overflow-hidden flex-shrink-0"
          style={{
            width: agentPanelOpen && !isSettingsView ? `${agentPanelWidth + 4}px` : '0px',
            transition: isResizing ? 'none' : 'width 300ms var(--spring-bounce, cubic-bezier(0.34, 1.56, 0.64, 1))',
          }}
        >
          {/* Resize handle */}
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
    </div>
  );
}
