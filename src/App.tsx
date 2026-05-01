import { useEffect, useState } from 'react';
import { APP_NAME } from '@/lib/constants';
import NavRail, { type NavView } from '@/components/nav/NavRail';
import ConnectionList from '@/components/connection/ConnectionList';
import McpList from '@/components/mcp/McpList';
import Settings from '@/components/settings/Settings';
import Terminal from '@/components/terminal/Terminal';
import AgentPanel from '@/components/agent/AgentPanel';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAgentStore } from '@/stores/agentStore';
import type { AgentMode } from '@/lib/types';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);
  // Currently selected nav view. `settings` takes over the whole main area,
  // while `sessions` and `mcp` swap the sidebar contents.
  const [navView, setNavView] = useState<NavView>('sessions');

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

  const isSettingsView = navView === 'settings';

  return (
    <div className="flex flex-col h-screen bg-zinc-900 text-zinc-100 overflow-hidden">
      {/* Top bar */}
      <header
        className="flex items-center justify-between px-3 py-2 bg-zinc-950 border-b border-zinc-800 select-none"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="切换侧边栏"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
          <h1 className="text-sm font-bold tracking-wide text-zinc-200">
            {APP_NAME}
          </h1>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          <button
            onClick={() => setAgentPanelOpen((v) => !v)}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="切换智能助手面板"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
            </svg>
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Far-left navigation rail (always visible) */}
        <NavRail active={navView} onChange={handleNavChange} />

        {isSettingsView ? (
          /* Settings view occupies the entire remaining area */
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-zinc-900">
            <Settings />
          </main>
        ) : (
          <>
            {/* Sidebar — content depends on navView */}
            {sidebarOpen && (
              <aside className="w-64 flex-shrink-0 bg-zinc-900 border-r border-zinc-800 overflow-hidden">
                {navView === 'sessions' && <ConnectionList />}
                {navView === 'mcp' && <McpList />}
              </aside>
            )}

            {/* Center — Terminal area */}
            <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
              <Terminal />
            </main>

            {/* Right panel — Agent */}
            {agentPanelOpen && (
              <aside className="w-80 flex-shrink-0 overflow-hidden">
                <AgentPanel />
              </aside>
            )}
          </>
        )}
      </div>
    </div>
  );
}
