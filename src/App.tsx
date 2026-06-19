import { useEffect, useState, lazy, Suspense, useRef, useCallback } from 'react';
import NavRail, { type NavView } from '@/components/nav/NavRail';
import ConnectionList from '@/components/connection/ConnectionList';
import Terminal from '@/components/terminal/Terminal';
import TabBar from '@/components/terminal/TabBar';
import AgentPanel from '@/components/agent/AgentPanel';
import AppHeader from '@/components/layout/AppHeader';
import SettingsWarningToast from '@/components/layout/SettingsWarningToast';
import UpdateToast from '@/components/UpdateToast';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAgentStore } from '@/stores/agentStore';
import { useSkillStore } from '@/stores/skillStore';
import { attachTransferListeners, detachTransferListeners } from '@/stores/sftpTransferManager';
import { appReady, checkUpdate } from '@/lib/tauri';
import type { AgentMode, WorkspaceLayoutSettings } from '@/lib/types';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  displayedWidthToBaseWidth,
  normalizeWorkspaceLayout,
  resolveWorkspaceLayout,
  WORKSPACE_LAYOUT_LIMITS,
} from '@/lib/workspaceLayout';

const SkillList = lazy(() => import('@/components/skill/SkillList'));
const McpList = lazy(() => import('@/components/mcp/McpList'));
const Settings = lazy(() => import('@/components/settings/Settings'));

const SETTINGS_LEFT_PANEL_COLLAPSE_MS = 300;
const AGENT_PANEL_COLLAPSE_MS = 300;

export default function App() {
  const [navView, setNavView] = useState<NavView>('sessions');
  const [updateToast, setUpdateToast] = useState<{ version: string; url: string } | null>(null);
  const mainRowRef = useRef<HTMLDivElement>(null);
  const mainRowWidthRef = useRef(0);
  const windowResizingRef = useRef(false);
  const windowResizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarResizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const agentResizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [dragSidebarWidth, setDragSidebarWidth] = useState<number | null>(null);
  const [dragAgentWidth, setDragAgentWidth] = useState<number | null>(null);
  const [resizingSide, setResizingSide] = useState<'sidebar' | 'agent' | null>(null);
  const [isWindowResizing, setIsWindowResizing] = useState(false);
  const agentPanelUnmountTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const defaultAgentMode = useSettingsStore((s) => s.settings.defaultAgentMode);
  const workspaceLayout = useSettingsStore((s) => s.settings.workspaceLayout);
  const updateSettings = useSettingsStore((s) => s.update);
  const setAgentMode = useAgentStore((s) => s.setMode);
  const fetchSkills = useSkillStore((s) => s.fetchSkills);

  const sidebarOpen = workspaceLayout?.sidebarOpen ?? DEFAULT_WORKSPACE_LAYOUT.sidebarOpen;
  const agentPanelOpen = workspaceLayout?.agentOpen ?? DEFAULT_WORKSPACE_LAYOUT.agentOpen;
  const isSettingsView = navView === 'settings';
  const effectiveSidebarOpen = sidebarOpen && !isSettingsView;
  const effectiveAgentPanelOpen = agentPanelOpen && !isSettingsView;
  const [agentPanelMounted, setAgentPanelMounted] = useState(effectiveAgentPanelOpen);

  useEffect(() => {
    attachTransferListeners();
    return () => detachTransferListeners();
  }, []);

  useEffect(() => {
    if (agentPanelUnmountTimeoutRef.current) {
      clearTimeout(agentPanelUnmountTimeoutRef.current);
      agentPanelUnmountTimeoutRef.current = null;
    }

    if (effectiveAgentPanelOpen) {
      setAgentPanelMounted(true);
      return;
    }

    agentPanelUnmountTimeoutRef.current = setTimeout(() => {
      setAgentPanelMounted(false);
      agentPanelUnmountTimeoutRef.current = null;
    }, AGENT_PANEL_COLLAPSE_MS);
  }, [effectiveAgentPanelOpen]);

  useEffect(() => {
    const el = mainRowRef.current;
    if (!el) return;

    const ro = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const previousWidth = mainRowWidthRef.current;
      if (previousWidth === width) return;
      mainRowWidthRef.current = width;
      if (previousWidth === 0) {
        setLayoutWidth(width);
      }

      if (!windowResizingRef.current) {
        windowResizingRef.current = true;
        setIsWindowResizing(true);
      }
      if (windowResizeTimeoutRef.current) clearTimeout(windowResizeTimeoutRef.current);
      windowResizeTimeoutRef.current = setTimeout(() => {
        windowResizingRef.current = false;
        setIsWindowResizing(false);
        setLayoutWidth(mainRowWidthRef.current);
      }, 120);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (windowResizeTimeoutRef.current) clearTimeout(windowResizeTimeoutRef.current);
    };
  }, []);

  const resolvedLayout = resolveWorkspaceLayout({
    containerWidth: layoutWidth,
    settings: workspaceLayout,
    sidebarOpen,
    agentOpen: agentPanelOpen,
    isSettingsView,
  });

  const sidebarWidth = dragSidebarWidth ?? resolvedLayout.sidebarWidth;
  const agentPanelWidth = dragAgentWidth ?? resolvedLayout.agentWidth;
  const agentPanelVisible = effectiveAgentPanelOpen && agentPanelWidth > 0;
  const isResizing = resizingSide !== null;

  const persistWorkspaceLayout = useCallback((patch: Partial<WorkspaceLayoutSettings>) => {
    const next = normalizeWorkspaceLayout({ ...DEFAULT_WORKSPACE_LAYOUT, ...workspaceLayout, ...patch });
    updateSettings({ workspaceLayout: next }).catch((err) => {
      console.error('Failed to save workspace layout:', err);
    });
  }, [updateSettings, workspaceLayout]);

  const handleToggleSidebar = () => {
    persistWorkspaceLayout({ sidebarOpen: !sidebarOpen });
  };

  const handleToggleAgentPanel = () => {
    persistWorkspaceLayout({ agentOpen: !agentPanelOpen });
  };

  const handleSidebarResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (!effectiveSidebarOpen || isSettingsView) return;
    e.preventDefault();
    sidebarResizeStartRef.current = { x: e.clientX, width: sidebarWidth };
    setResizingSide('sidebar');
  }, [effectiveSidebarOpen, isSettingsView, sidebarWidth]);

  const handleAgentResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (!agentPanelVisible || isSettingsView) return;
    e.preventDefault();
    agentResizeStartRef.current = { x: e.clientX, width: agentPanelWidth };
    setResizingSide('agent');
  }, [agentPanelWidth, agentPanelVisible, isSettingsView]);

  useEffect(() => {
    if (!resizingSide) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (resizingSide === 'sidebar' && sidebarResizeStartRef.current) {
        const delta = e.clientX - sidebarResizeStartRef.current.x;
        const width = Math.min(
          WORKSPACE_LAYOUT_LIMITS.sidebar.max,
          Math.max(WORKSPACE_LAYOUT_LIMITS.sidebar.min, sidebarResizeStartRef.current.width + delta),
        );
        setDragSidebarWidth(width);
        return;
      }

      if (resizingSide === 'agent' && agentResizeStartRef.current) {
        const delta = agentResizeStartRef.current.x - e.clientX;
        const width = Math.min(
          WORKSPACE_LAYOUT_LIMITS.agent.max,
          Math.max(WORKSPACE_LAYOUT_LIMITS.agent.min, agentResizeStartRef.current.width + delta),
        );
        setDragAgentWidth(width);
      }
    };

    const handleMouseUp = () => {
      if (resizingSide === 'sidebar' && dragSidebarWidth !== null) {
        persistWorkspaceLayout({
          sidebarBaseWidth: displayedWidthToBaseWidth(
            dragSidebarWidth,
            layoutWidth,
            WORKSPACE_LAYOUT_LIMITS.sidebar.min,
            WORKSPACE_LAYOUT_LIMITS.sidebar.max,
          ),
        });
      }
      if (resizingSide === 'agent' && dragAgentWidth !== null) {
        persistWorkspaceLayout({
          agentBaseWidth: displayedWidthToBaseWidth(
            dragAgentWidth,
            layoutWidth,
            WORKSPACE_LAYOUT_LIMITS.agent.min,
            WORKSPACE_LAYOUT_LIMITS.agent.max,
          ),
        });
      }
      sidebarResizeStartRef.current = null;
      agentResizeStartRef.current = null;
      setDragSidebarWidth(null);
      setDragAgentWidth(null);
      setResizingSide(null);
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
  }, [dragAgentWidth, dragSidebarWidth, layoutWidth, persistWorkspaceLayout, resizingSide]);

  useEffect(() => {
    appReady().catch(console.error);
    // 预加载设置页面，消除首次进入的模块加载延迟
    const preload = () => import('@/components/settings/Settings');
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(preload);
    } else {
      setTimeout(preload, 1000);
    }
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

    setNavView(view);
    if ((view === 'sessions' || view === 'skills' || view === 'mcp') && !sidebarOpen) {
      persistWorkspaceLayout({ sidebarOpen: true });
    }
  };

  return (
    <div
      className="flex flex-col h-screen bg-zinc-900 text-zinc-100 overflow-hidden"
      data-window-resizing={isWindowResizing ? 'true' : undefined}
    >
      <AppHeader
        onToggleSidebar={handleToggleSidebar}
        onToggleAgentPanel={handleToggleAgentPanel}
      />

      <div ref={mainRowRef} className="flex flex-1 overflow-hidden">
        <NavRail active={navView} onChange={handleNavChange} />

        <aside
          className="layout-contained flex-shrink-0 bg-zinc-900 border-r border-zinc-800 overflow-hidden"
          style={{
            width: effectiveSidebarOpen ? `${sidebarWidth}px` : '0rem',
            borderRightWidth: effectiveSidebarOpen ? '1px' : '0px',
            transition: isResizing || isWindowResizing
              ? 'none'
              : `width ${SETTINGS_LEFT_PANEL_COLLAPSE_MS}ms cubic-bezier(0.16, 1, 0.3, 1), border-right-width ${SETTINGS_LEFT_PANEL_COLLAPSE_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`,
          }}
        >
          <div style={{ width: `${sidebarWidth}px`, height: '100%' }}>
            {navView === 'sessions' && <ConnectionList />}
            {navView === 'skills' && <Suspense fallback={null}><SkillList /></Suspense>}
            {navView === 'mcp' && <Suspense fallback={null}><McpList /></Suspense>}
          </div>
        </aside>

        {effectiveSidebarOpen && !isSettingsView && (
          <div
            className="w-1 cursor-col-resize hover:bg-indigo-500/50 transition-colors z-10 flex-shrink-0"
            onMouseDown={handleSidebarResizeMouseDown}
            style={{ touchAction: 'none' }}
          />
        )}

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
            width: agentPanelVisible ? `${agentPanelWidth + 4}px` : '0px',
            transition: isResizing || isWindowResizing ? 'none' : 'width 300ms var(--spring-bounce, cubic-bezier(0.34, 1.56, 0.64, 1))',
          }}
        >
          {agentPanelMounted && agentPanelVisible && (
            <>
              <div
                className="w-1 cursor-col-resize hover:bg-indigo-500/50 transition-colors z-10 flex-shrink-0"
                onMouseDown={handleAgentResizeMouseDown}
                style={{ touchAction: 'none' }}
              />
              <aside
                className="layout-contained overflow-hidden border-l border-zinc-800 flex-shrink-0"
                style={{ width: `${agentPanelWidth}px` }}
              >
                <AgentPanel />
              </aside>
            </>
          )}
        </div>
      </div>

      {updateToast && (
        <UpdateToast
          version={updateToast.version}
          url={updateToast.url}
          onDismiss={() => setUpdateToast(null)}
        />
      )}

      <SettingsWarningToast />
    </div>
  );
}
