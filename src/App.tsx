import { useEffect, useState, lazy, Suspense } from 'react';
import NavRail, { type NavView } from '@/components/nav/NavRail';
import ConnectionList from '@/components/connection/ConnectionList';
import Terminal from '@/components/terminal/Terminal';
import TabBar from '@/components/terminal/TabBar';
import AgentPanel from '@/components/agent/AgentPanel';
import AppHeader from '@/components/layout/AppHeader';
import UpdateToast from '@/components/UpdateToast';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAgentStore } from '@/stores/agentStore';
import { useSkillStore } from '@/stores/skillStore';
import { appReady, checkUpdate } from '@/lib/tauri';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import type { AgentMode } from '@/lib/types';

const SkillList = lazy(() => import('@/components/skill/SkillList'));
const McpList = lazy(() => import('@/components/mcp/McpList'));
const Settings = lazy(() => import('@/components/settings/Settings'));

const AGENT_PANEL_MIN_WIDTH = 260;
const AGENT_PANEL_MAX_WIDTH = 800;
const AGENT_PANEL_DEFAULT_WIDTH = 320;

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);
  const [navView, setNavView] = useState<NavView>('sessions');
  const [updateToast, setUpdateToast] = useState<{ version: string; url: string } | null>(null);

  const { width: agentPanelWidth, isResizing, startResize: handleResizeMouseDown } =
    useResizablePanel(AGENT_PANEL_MIN_WIDTH, AGENT_PANEL_MAX_WIDTH, AGENT_PANEL_DEFAULT_WIDTH);

  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const defaultAgentMode = useSettingsStore((s) => s.settings.defaultAgentMode);
  const setAgentMode = useAgentStore((s) => s.setMode);
  const fetchSkills = useSkillStore((s) => s.fetchSkills);

  useEffect(() => {
    appReady().catch(console.error);
  }, []);

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

  const isSettingsView = navView === 'settings';

  return (
    <div className="flex flex-col h-screen bg-zinc-900 text-zinc-100 overflow-hidden">
      <AppHeader
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onToggleAgentPanel={() => setAgentPanelOpen((v) => !v)}
      />

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
            {navView === 'skills' && <Suspense fallback={null}><SkillList /></Suspense>}
            {navView === 'mcp' && <Suspense fallback={null}><McpList /></Suspense>}
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
          <TabBar />
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden" style={{ display: isSettingsView ? 'none' : 'flex' }}>
            <Terminal />
          </main>

          {isSettingsView && (
            <div className="absolute inset-0 flex flex-col min-w-0 overflow-hidden bg-zinc-900">
              <Suspense fallback={<div className="flex-1 bg-zinc-900" />}><Settings /></Suspense>
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

      {updateToast && (
        <UpdateToast
          version={updateToast.version}
          url={updateToast.url}
          onDismiss={() => setUpdateToast(null)}
        />
      )}
    </div>
  );
}
