import { useEffect, useState, lazy, Suspense, useRef, useCallback } from 'react';
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
const AGENT_RATIO_KEY = 'marcel:agentPanelWidthRatio';
const SETTINGS_LEFT_PANEL_COLLAPSE_MS = 300;

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);
  const [navView, setNavView] = useState<NavView>('sessions');
  const [updateToast, setUpdateToast] = useState<{ version: string; url: string } | null>(null);
  const mainRowRef = useRef<HTMLDivElement>(null);
  const agentRatioRef = useRef(0);
  const agentPanelWidthRef = useRef(AGENT_PANEL_DEFAULT_WIDTH);
  const mainRowWidthRef = useRef(0);
  const windowResizingRef = useRef(false);
  const preSettingsPanelsRef = useRef<{ sidebarOpen: boolean; agentPanelOpen: boolean } | null>(null);
  const windowResizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isWindowResizing, setIsWindowResizing] = useState(false);

  const saveAgentRatio = useCallback((ratio: number) => {
    agentRatioRef.current = ratio;
    try { localStorage.setItem(AGENT_RATIO_KEY, String(ratio)); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem(AGENT_RATIO_KEY);
      if (v) agentRatioRef.current = parseFloat(v) || 0;
    } catch { /* ignore */ }
  }, []);

  const handleAgentWidthChange = useCallback((w: number) => {
    if (mainRowWidthRef.current > 0) {
      saveAgentRatio(w / mainRowWidthRef.current);
    }
  }, [saveAgentRatio]);

  const { width: agentPanelWidth, isResizing, startResize: handleResizeMouseDown, setWidth: setAgentWidth } =
    useResizablePanel({
      minWidth: AGENT_PANEL_MIN_WIDTH,
      maxWidth: AGENT_PANEL_MAX_WIDTH,
      initialWidth: AGENT_PANEL_DEFAULT_WIDTH,
      onChange: handleAgentWidthChange,
    });

  useEffect(() => {
    agentPanelWidthRef.current = agentPanelWidth;
  }, [agentPanelWidth]);

  useEffect(() => {
    const el = mainRowRef.current;
    if (!el) return;

    const syncAgentWidth = () => {
      const width = mainRowWidthRef.current;
      if (width <= 0 || !agentPanelOpen) return;
      if (agentRatioRef.current > 0) {
        const w = Math.min(AGENT_PANEL_MAX_WIDTH, Math.max(AGENT_PANEL_MIN_WIDTH, Math.round(agentRatioRef.current * width)));
        setAgentWidth(w);
      } else if (agentPanelWidthRef.current > 0) {
        agentRatioRef.current = agentPanelWidthRef.current / width;
      }
    };

    const ro = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (mainRowWidthRef.current === width) return;
      mainRowWidthRef.current = width;

      if (!windowResizingRef.current) {
        windowResizingRef.current = true;
        setIsWindowResizing(true);
      }
      if (windowResizeTimeoutRef.current) clearTimeout(windowResizeTimeoutRef.current);
      windowResizeTimeoutRef.current = setTimeout(() => {
        windowResizingRef.current = false;
        setIsWindowResizing(false);
        syncAgentWidth();
      }, 120);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (windowResizeTimeoutRef.current) clearTimeout(windowResizeTimeoutRef.current);
    };
  }, [agentPanelOpen, setAgentWidth]);

  useEffect(() => {
    const width = mainRowWidthRef.current;
    if (width <= 0 || !agentPanelOpen || agentRatioRef.current <= 0) return;
    const w = Math.min(AGENT_PANEL_MAX_WIDTH, Math.max(AGENT_PANEL_MIN_WIDTH, Math.round(agentRatioRef.current * width)));
    setAgentWidth(w);
  }, [agentPanelOpen, setAgentWidth]);

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
    if (view === navView) return;

    if (view === 'settings') {
      preSettingsPanelsRef.current = { sidebarOpen, agentPanelOpen };
      setNavView(view);
      setSidebarOpen(false);
      setAgentPanelOpen(false);
      return;
    }

    if (navView === 'settings') {
      const previous = preSettingsPanelsRef.current;
      if (previous) {
        setSidebarOpen(previous.sidebarOpen);
        setAgentPanelOpen(previous.agentPanelOpen);
        preSettingsPanelsRef.current = null;
      }
    }

    setNavView(view);
    if (view === 'sessions' || view === 'skills' || view === 'mcp') {
      setSidebarOpen(true);
    }
  };

  const isSettingsView = navView === 'settings';
  const effectiveSidebarOpen = sidebarOpen && !isSettingsView;
  const effectiveAgentPanelOpen = agentPanelOpen && !isSettingsView;

  return (
    <div
      className="flex flex-col h-screen bg-zinc-900 text-zinc-100 overflow-hidden"
      data-window-resizing={isWindowResizing ? 'true' : undefined}
    >
      <AppHeader
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onToggleAgentPanel={() => setAgentPanelOpen((v) => !v)}
      />

      <div ref={mainRowRef} className="flex flex-1 overflow-hidden">
        <NavRail active={navView} onChange={handleNavChange} />

        <aside
          className="layout-contained flex-shrink-0 bg-zinc-900 border-r border-zinc-800 overflow-hidden"
          style={{
            width: effectiveSidebarOpen ? '16rem' : '0rem',
            borderRightWidth: effectiveSidebarOpen ? '1px' : '0px',
            transition: `width ${SETTINGS_LEFT_PANEL_COLLAPSE_MS}ms cubic-bezier(0.16, 1, 0.3, 1), border-right-width ${SETTINGS_LEFT_PANEL_COLLAPSE_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          }}
        >
          <div style={{ width: '16rem', height: '100%' }}>
            {navView === 'sessions' && <ConnectionList />}
            {navView === 'skills' && <Suspense fallback={null}><SkillList /></Suspense>}
            {navView === 'mcp' && <Suspense fallback={null}><McpList /></Suspense>}
          </div>
        </aside>

        <div className="layout-contained flex-1 flex flex-col min-w-0 overflow-hidden relative">
          {isSettingsView ? (
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-zinc-900 animate-settings-workspace-enter">
              <Suspense fallback={<div className="flex-1 bg-zinc-900" />}>
                <Settings />
              </Suspense>
            </div>
          ) : (
            <>
              <TabBar />
              <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
                <Terminal />
              </main>
            </>
          )}
        </div>

        <div
          className="layout-contained flex overflow-hidden flex-shrink-0"
          style={{
            width: effectiveAgentPanelOpen ? `${agentPanelWidth + 4}px` : '0px',
            transition: isResizing || isWindowResizing ? 'none' : 'width 300ms var(--spring-bounce, cubic-bezier(0.34, 1.56, 0.64, 1))',
          }}
        >
          <div
            className="w-1 cursor-col-resize hover:bg-indigo-500/50 transition-colors z-10 flex-shrink-0"
            onMouseDown={handleResizeMouseDown}
            style={{ touchAction: 'none' }}
          />
          <aside
            className="layout-contained overflow-hidden border-l border-zinc-800 flex-shrink-0"
            style={{ width: `${agentPanelWidth}px` }}
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
