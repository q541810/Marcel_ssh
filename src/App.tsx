import {
  useEffect,
  useState,
  lazy,
  Suspense,
  useRef,
  useCallback,
  useMemo,
  type ComponentType,
  type LazyExoticComponent,
} from 'react';
import NavRail from '@/components/nav/NavRail';
import TabBar from '@/components/terminal/TabBar';
import AppHeader from '@/components/layout/AppHeader';
import HostKeyWarningToast from '@/components/layout/HostKeyWarningToast';
import SettingsWarningToast from '@/components/layout/SettingsWarningToast';
import UpdateToast from '@/components/UpdateToast';
import OnboardingWizard from '@/components/onboarding/OnboardingWizard';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAgentStore } from '@/stores/agentStore';
import { useSkillStore } from '@/stores/skillStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useViewStore, byMount } from '@/stores/viewStore';
import { attachTransferListeners, detachTransferListeners } from '@/stores/sftpTransferManager';
import { appReady, checkUpdate } from '@/lib/tauri';
import { playNotificationSound } from '@/lib/notificationSound';
import type { AgentMode, ViewProvider, WorkspaceLayoutSettings } from '@/lib/types';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  displayedWidthToBaseWidth,
  normalizeWorkspaceLayout,
  resolveWorkspaceLayout,
  WORKSPACE_LAYOUT_LIMITS,
} from '@/lib/workspaceLayout';
import { registerBuiltinViews } from '@/plugins/builtinViews';
import PluginWebviewSlot from '@/plugins/PluginWebviewSlot';
import { initPluginIpc } from '@/plugins/pluginIpc';
import { ensurePluginRegistryListener } from '@/stores/pluginStore';
import { initRegionBridge, notifyNavChange } from '@/plugins/injection';

const lazyCache = new Map<string, LazyExoticComponent<ComponentType>>();

function getLazy(provider: ViewProvider): LazyExoticComponent<ComponentType> {
  let c = lazyCache.get(provider.id);
  if (!c) {
    c = lazy(provider.component);
    lazyCache.set(provider.id, c);
  }
  return c;
}

registerBuiltinViews();

const SETTINGS_LEFT_PANEL_COLLAPSE_MS = 300;
const AGENT_PANEL_COLLAPSE_MS = 300;

export default function App() {
  const [activeId, setActiveId] = useState<string>('builtin.sessions');
  const providers = useViewStore((s) => s.providers);
  const [updateToast, setUpdateToast] = useState<{ version: string; url: string } | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // 标记引导是否已结束：仅引导结束时触发主行滑出动画，
  // 避免首次加载 showOnboarding 由 false→true 时产生无效淡出
  const [onboardingExited, setOnboardingExited] = useState(false);
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
  const fetchPlugins = usePluginStore((s) => s.fetchPlugins);
  const syncInjections = usePluginStore((s) => s.syncInjections);
  const rehydrateInjections = usePluginStore((s) => s.rehydrateInjections);
  const pluginRefreshKey = usePluginStore((s) => s.refreshKey);

  const sidebarOpen = workspaceLayout?.sidebarOpen ?? DEFAULT_WORKSPACE_LAYOUT.sidebarOpen;
  const agentPanelOpen = workspaceLayout?.agentOpen ?? DEFAULT_WORKSPACE_LAYOUT.agentOpen;
  const disabledPlugins = useSettingsStore((s) => s.settings.disabledPlugins);
  const disableAllInjections = useSettingsStore((s) => s.settings.disableAllInjections);
  const authorizedCapabilities = useSettingsStore((s) => s.settings.authorizedCapabilities);
  const centerProviders = useMemo(() => byMount(providers, 'center'), [providers]);
  const agentProviders = useMemo(() => byMount(providers, 'agent'), [providers]);
  const activeProvider = useMemo(
    () => providers.find((p) => p.id === activeId),
    [providers, activeId],
  );
  const isExclusive = activeProvider?.exclusive ?? false;
  // sidebar: 跟随当前激活的 NavRail 项，插件可用（需设置 navGroup 才能出现在导航栏）
  const sidebarProvider =
    !isExclusive && activeProvider?.mount === 'sidebar' ? activeProvider : null;
  // center: 非 exclusive 时固定取 order 最小者，builtin.terminal(order=10, 不可禁用) 常驻，插件实际无法使用
  const centerProvider = isExclusive ? activeProvider : centerProviders[0];
  // agent: 固定取 order 最小者，builtin.agent(order=10, 不可禁用) 常驻，
  // 插件 agent 视图必须 order<10 才能显示（同时顶掉内置 Agent 面板），实际不可用
  const agentProvider = isExclusive ? null : agentProviders[0];
  const effectiveSidebarOpen = sidebarOpen && !isExclusive && sidebarProvider !== null;
  const effectiveAgentPanelOpen = agentPanelOpen && !isExclusive && agentProvider !== null;
  const [agentPanelMounted, setAgentPanelMounted] = useState(effectiveAgentPanelOpen);
  const agentPanelWasUnmountedRef = useRef(!effectiveAgentPanelOpen);

  useEffect(() => {
    attachTransferListeners();
    return () => detachTransferListeners();
  }, []);

  useEffect(() => {
    if (providers.length > 0 && !providers.some((p) => p.id === activeId)) {
      setActiveId('builtin.sessions');
    }
  }, [providers, activeId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('notification-sound', (event) => {
        playNotificationSound(event.payload);
      }).then((fn) => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
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
    if (!agentPanelMounted) return;
    if (!agentPanelWasUnmountedRef.current) return;
    agentPanelWasUnmountedRef.current = false;
    rehydrateInjections();
  }, [agentPanelMounted, rehydrateInjections]);

  useEffect(() => {
    if (agentPanelMounted) return;
    agentPanelWasUnmountedRef.current = true;
  }, [agentPanelMounted]);

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
    isExclusive,
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
    if (!effectiveSidebarOpen || isExclusive) return;
    e.preventDefault();
    sidebarResizeStartRef.current = { x: e.clientX, width: sidebarWidth };
    setResizingSide('sidebar');
  }, [effectiveSidebarOpen, isExclusive, sidebarWidth]);

  const handleAgentResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (!agentPanelVisible || isExclusive) return;
    e.preventDefault();
    agentResizeStartRef.current = { x: e.clientX, width: agentPanelWidth };
    setResizingSide('agent');
  }, [agentPanelWidth, agentPanelVisible, isExclusive]);

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
    fetchPlugins().catch(err => {
      console.error('Failed to load plugins:', err);
    });
    initPluginIpc().catch(err => {
      console.error('Failed to init plugin IPC:', err);
    });
    ensurePluginRegistryListener();
    initRegionBridge();
    checkUpdate().then(res => {
      if (res.hasUpdate) setUpdateToast({ version: res.latestVersion, url: res.releaseUrl });
    }).catch(() => {});
  }, [loadSettings, fetchSkills, fetchPlugins]);

  // Reconcile content-script injections when plugin enablement / capability
  // authorization / safe-mode toggle changes. Runs after fetchPlugins (which
  // does its own sync) and on every settings change that affects injection
  // eligibility.
  useEffect(() => {
    syncInjections();
  }, [syncInjections, disabledPlugins, disableAllInjections, authorizedCapabilities]);

  // Emit a UI nav-change event to content scripts when the active view
  // switches. Also fire once on mount so late-loaded plugins learn the
  // initial view.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  useEffect(() => {
    notifyNavChange(null, activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    const valid: AgentMode[] = ['chat', 'agent', 'auto'];
    if ((valid as string[]).includes(defaultAgentMode)) {
      setAgentMode(defaultAgentMode as AgentMode);
    }
    // Check if onboarding should be shown
    const hasCompletedOnboarding = useSettingsStore.getState().settings.hasCompletedOnboarding;
    if (!hasCompletedOnboarding) {
      setShowOnboarding(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  const handleNavChange = (id: string) => {
    if (id === activeId) return;

    setActiveId(id);
    notifyNavChange(activeId, id);
    const p = providers.find((x) => x.id === id);
    if (p && p.mount === 'sidebar' && !sidebarOpen) {
      persistWorkspaceLayout({ sidebarOpen: true });
    }
  };

  const SidebarView = sidebarProvider ? getLazy(sidebarProvider) : null;
  const CenterView = centerProvider ? getLazy(centerProvider) : null;
  const AgentView = agentProvider ? getLazy(agentProvider) : null;

  return (
    <div className="relative">
      <AppHeader
        onToggleSidebar={handleToggleSidebar}
        onToggleAgentPanel={handleToggleAgentPanel}
        className="fixed top-0 left-0 right-0 z-[99999]"
      />

      <div
        className="flex flex-col h-screen bg-zinc-900 text-zinc-100 overflow-hidden pt-8"
        data-window-resizing={isWindowResizing ? 'true' : undefined}
      >
        <div
          ref={mainRowRef}
          className={`flex flex-1 overflow-hidden ${
            onboardingExited && !showOnboarding
              ? 'main-row-enter'
              : showOnboarding
                ? 'opacity-0'
                : ''
          }`}
        >
          <NavRail activeId={activeId} onChange={handleNavChange} />

          <aside
            data-region="sidebar"
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
              {sidebarProvider && sidebarProvider.pluginId !== 'builtin' ? (
                <PluginWebviewSlot key={`${sidebarProvider.id}-${pluginRefreshKey}`} provider={sidebarProvider} />
              ) : SidebarView ? (
                <Suspense fallback={null}>
                  <SidebarView />
                </Suspense>
              ) : null}
            </div>
          </aside>

          {effectiveSidebarOpen && (
            <div
              className="w-1 cursor-col-resize hover:bg-indigo-500/50 transition-colors z-10 flex-shrink-0"
              onMouseDown={handleSidebarResizeMouseDown}
              style={{ touchAction: 'none' }}
            />
          )}

          <div data-region="center" className="layout-contained flex-1 flex flex-col min-w-0 overflow-hidden relative">
            {isExclusive ? (
              <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-zinc-900 animate-settings-workspace-enter">
                {centerProvider && centerProvider.pluginId !== 'builtin' ? (
                  <PluginWebviewSlot key={`${centerProvider.id}-${pluginRefreshKey}`} provider={centerProvider} />
                ) : (
                  <Suspense fallback={<div className="flex-1 bg-zinc-900" />}>
                    {CenterView && <CenterView />}
                  </Suspense>
                )}
              </div>
            ) : (
              <>
                <TabBar />
                <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
                  {centerProvider && centerProvider.pluginId !== 'builtin' ? (
                    <PluginWebviewSlot key={`${centerProvider.id}-${pluginRefreshKey}`} provider={centerProvider} />
                  ) : (
                    <Suspense fallback={null}>{CenterView && <CenterView />}</Suspense>
                  )}
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
                  data-region="agent"
                  className="layout-contained overflow-hidden border-l border-zinc-800 flex-shrink-0"
                  style={{ width: `${agentPanelWidth}px` }}
                >
                  {agentProvider && agentProvider.pluginId !== 'builtin' ? (
                    <PluginWebviewSlot key={`${agentProvider.id}-${pluginRefreshKey}`} provider={agentProvider} />
                  ) : (
                    AgentView && <AgentView />
                  )}
                </aside>
              </>
            )}
          </div>
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
      <HostKeyWarningToast />

      {/* Shared overlay container for content-script plugins. Fixed, full
          screen, no pointer events by default; plugins opt-in via
          marcel.overlay.create(). Children are tagged data-plugin-id for
          cleanup on deactivation. */}
      <div id="marcel-overlays" style={{ position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 99998 }} />

      <OnboardingWizard
        open={showOnboarding}
        onComplete={() => {
          setShowOnboarding(false);
          setOnboardingExited(true);
        }}
      />
    </div>
  );
}
