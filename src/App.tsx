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
import OnboardingWizard from '@/components/onboarding/OnboardingWizard';
import StarPromptModal from '@/components/star/StarPromptModal';
import GlobalInteractionOverlay from '@/components/agent/GlobalInteractionOverlay';
import { initInteractionListener } from '@/stores/interactionStore';
import { initJobWake } from '@/stores/jobWake';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskStore } from '@/stores/taskStore';
import { useSkillStore } from '@/stores/skillStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useMarketStore } from '@/stores/marketStore';
import { useJobStore } from '@/stores/jobStore';
import { useViewStore, byMount } from '@/stores/viewStore';
import { attachTransferListeners, detachTransferListeners } from '@/stores/sftpTransferManager';
import { appReady, sftpPreviewCleanup } from '@/lib/tauri';
import { playNotificationSound } from '@/lib/notificationSound';
import { useTauriEvent } from '@/hooks/useTauriEvent';
import type { AgentMode, ViewProvider, WorkspaceLayoutSettings } from '@/lib/types';
import {
  DEFAULT_WORKSPACE_LAYOUT,
  baseWidthPatch,
  defaultBaseWidthOf,
  dockBaseWidthOf,
  dockPanelOf,
  mergeWorkspaceLayout,
  normalizeWorkspaceLayout,
  resolvePanelBaseBounds,
  resolveWorkspaceLayout,
  resolveWorkspaceScale,
  type PanelBaseBounds,
  type PanelSide,
} from '@/lib/workspaceLayout';
import SplitHandle from '@/components/layout/SplitHandle';
import { registerBuiltinViews } from '@/plugins/builtinViews';
import PluginWebviewSlot from '@/plugins/PluginWebviewSlot';
import { initPluginIpc } from '@/plugins/pluginIpc';
import { ensurePluginRegistryListener } from '@/stores/pluginStore';
import { initRegionBridge, notifyNavChange } from '@/plugins/injection';
import { hydrateBootstrapData } from '@/lib/bootstrap';

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
/** 方向键连按：视觉立刻跟，落盘留到停手（和拖动一样，手势结束才写）。 */
const NUDGE_COMMIT_MS = 240;

/**
 * 一次拖动的全部状态。放 ref 而不是 state：指针移动期间只需要 setState 更新宽度，
 * 事件靠 Pointer 捕获直接回到把手，不挂 document 监听、不进 effect 依赖。
 * 宽度以**基准宽度**为单位推进（不是屏幕像素），松手存的就是推进到的那个值，
 * 所以「松手后停在松手前的位置」是构造出来的，不是对齐出来的。
 */
interface ResizeSession {
  side: PanelSide;
  pointerId: number;
  pointerStartX: number;
  baseStart: number;
  baseCurrent: number;
  bounds: PanelBaseBounds;
  scale: number;
}

export default function App() {
  const activeId = useViewStore((s) => s.activeId);
  const setActiveId = useViewStore((s) => s.setActiveId);
  const providers = useViewStore((s) => s.providers);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // 标记引导是否已结束：仅引导结束时触发主行滑出动画，
  // 避免首次加载 showOnboarding 由 false→true 时产生无效淡出
  const [onboardingExited, setOnboardingExited] = useState(false);
  const mainRowRef = useRef<HTMLDivElement>(null);
  const mainRowWidthRef = useRef(0);
  const windowResizingRef = useRef(false);
  const windowResizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNudgeRef = useRef<{ side: PanelSide; base: number } | null>(null);
  const [layoutWidth, setLayoutWidth] = useState(0);
  /** 拖动/方向键期间的基准宽度覆盖值；落盘生效后被撤掉，布局回到设置里的值。 */
  const [dragBase, setDragBase] = useState<{ side: PanelSide; base: number } | null>(null);
  const [resizingSide, setResizingSide] = useState<PanelSide | null>(null);
  const [isWindowResizing, setIsWindowResizing] = useState(false);
  const dockUnmountTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const defaultAgentMode = useSettingsStore((s) => s.settings.defaultAgentMode);
  const workspaceLayout = useSettingsStore((s) => s.settings.workspaceLayout);
  const updateSettings = useSettingsStore((s) => s.update);
  const setAgentMode = useTaskStore((s) => s.setMode);
  const fetchSkills = useSkillStore((s) => s.fetchSkills);
  const fetchPlugins = usePluginStore((s) => s.fetchPlugins);
  const syncInjections = usePluginStore((s) => s.syncInjections);
  const rehydrateInjections = usePluginStore((s) => s.rehydrateInjections);
  const pluginRefreshKey = usePluginStore((s) => s.refreshKey);

  const sidebarOpen = workspaceLayout?.sidebarOpen ?? DEFAULT_WORKSPACE_LAYOUT.sidebarOpen;
  const agentPanelOpen = workspaceLayout?.agentOpen ?? DEFAULT_WORKSPACE_LAYOUT.agentOpen;
  /**
   * 右侧固定栏（dock）现在停谁：默认 Agent 面板；开启「Agent 占主区域」后与终端互换，
   * dock 里是终端、主区域是 Agent。宽度、把手文案、落盘字段全按这个判断走。
   */
  const dockPanel = dockPanelOf(workspaceLayout);
  const agentPrimary = dockPanel === 'terminal';
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
  // dock 里停谁由 agentPrimary 决定：停终端时它永远在（终端是常驻中心视图）
  const dockProvider = agentPrimary ? centerProviders[0] : agentProvider;
  const effectiveAgentPanelOpen = agentPanelOpen && !isExclusive && dockProvider !== null;
  const [dockMounted, setAgentPanelMounted] = useState(effectiveAgentPanelOpen);
  const dockWasUnmountedRef = useRef(!effectiveAgentPanelOpen);

  useEffect(() => {
    attachTransferListeners();
    const detachInteractions = initInteractionListener();
    const detachJobs = useJobStore.getState().initEventListener();
    // 作业跑完自动继续：作业结算 → 给那条会话开一轮把结局交给模型
    const detachJobWake = initJobWake();
    // 启动恢复：拉取全部会话的后台作业（事件不会重放，重启前已存在的
    // 作业靠这次全量拉取回到 UI；只 upsert 合并，不覆盖事件实时状态）
    void useJobStore.getState().fetchJobs();
    return () => {
      detachTransferListeners();
      detachInteractions();
      detachJobs();
      detachJobWake();
    };
  }, []);

  useEffect(() => {
    if (providers.length > 0 && !providers.some((p) => p.id === activeId)) {
      setActiveId('builtin.sessions');
    }
  }, [providers, activeId]);

  // 提示音：声明式订阅，卸载即退订（旧写法是「动态 import 之后再 listen，
  // 把 unlisten 存进外面的变量」，卸载早于两层 Promise resolve 时必然泄漏）。
  useTauriEvent<string>('notification-sound', (payload) => {
    playNotificationSound(payload);
  });

  useEffect(() => {
    if (dockUnmountTimeoutRef.current) {
      clearTimeout(dockUnmountTimeoutRef.current);
      dockUnmountTimeoutRef.current = null;
    }

    if (effectiveAgentPanelOpen) {
      setAgentPanelMounted(true);
      return;
    }

    dockUnmountTimeoutRef.current = setTimeout(() => {
      setAgentPanelMounted(false);
      dockUnmountTimeoutRef.current = null;
    }, AGENT_PANEL_COLLAPSE_MS);
  }, [effectiveAgentPanelOpen]);

  useEffect(() => {
    if (!dockMounted) return;
    if (!dockWasUnmountedRef.current) return;
    dockWasUnmountedRef.current = false;
    rehydrateInjections();
  }, [dockMounted, rehydrateInjections]);

  useEffect(() => {
    if (dockMounted) return;
    dockWasUnmountedRef.current = true;
  }, [dockMounted]);

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

  // 拖动期间把候选基准宽度并进设置再求解：面板宽度、中栏、邻栏全部由同一个
  // resolveWorkspaceLayout 算出来，所以拖动中看到的布局就是松手后的布局。
  // 落盘字段按 dock 当前停谁选（互换模式下拖的是终端自己的宽度）。
  const dragBasePatch = useMemo(
    () =>
      dragBase === null
        ? null
        : baseWidthPatch(dragBase.side, workspaceLayout, dragBase.base),
    [dragBase, workspaceLayout],
  );

  const resolvedLayout = resolveWorkspaceLayout({
    containerWidth: layoutWidth,
    settings: dragBasePatch ? { ...workspaceLayout, ...dragBasePatch } : workspaceLayout,
    sidebarOpen,
    agentOpen: agentPanelOpen,
    isExclusive,
  });

  const sidebarWidth = resolvedLayout.sidebarWidth;
  const dockWidth = resolvedLayout.dockWidth;
  const dockVisible = effectiveAgentPanelOpen && dockWidth > 0;
  const isResizing = resizingSide !== null;

  // 可拖范围（拿 resolveWorkspaceLayout 自己当预言机扫出来的），只在窗口尺寸 /
  // 设置变化时重算——拖动期间不重算，区间对一次手势保持稳定。
  const sidebarBounds = useMemo(
    () =>
      resolvePanelBaseBounds({
        side: 'sidebar',
        containerWidth: layoutWidth,
        settings: workspaceLayout,
        sidebarOpen,
        agentOpen: agentPanelOpen,
        isExclusive,
      }),
    [agentPanelOpen, isExclusive, layoutWidth, sidebarOpen, workspaceLayout],
  );
  const dockBounds = useMemo(
    () =>
      resolvePanelBaseBounds({
        side: 'dock',
        containerWidth: layoutWidth,
        settings: workspaceLayout,
        sidebarOpen,
        agentOpen: agentPanelOpen,
        isExclusive,
      }),
    [agentPanelOpen, isExclusive, layoutWidth, sidebarOpen, workspaceLayout],
  );

  const persistWorkspaceLayout = useCallback((patch: Partial<WorkspaceLayoutSettings>) => {
    // 从 store 现取而不是用渲染闭包：update() 是「先落盘再改内存」，
    // 连续两次调整时闭包里的 workspaceLayout 可能还没有上一条的结果。
    const current = useSettingsStore.getState().settings.workspaceLayout;
    const next = mergeWorkspaceLayout(current, patch);
    return updateSettings({ workspaceLayout: next }).catch((err) => {
      console.error('Failed to save workspace layout:', err);
    });
  }, [updateSettings]);

  /** 落盘一次面板基准宽度，并在 store 真的拿到新值之后再撤掉本地覆盖值。 */
  const commitPanelBase = useCallback(
    (side: PanelSide, base: number) => {
      // 落盘字段从 store 现取（和 persistWorkspaceLayout 同一个理由）：互换模式下
      // dock 停的是终端，这一笔要写进 terminalBaseWidth，两栏各记各的宽度。
      const current = useSettingsStore.getState().settings.workspaceLayout;
      void persistWorkspaceLayout(baseWidthPatch(side, current, base)).then(() => {
        // 等 store 更新完再撤覆盖：早一步撤会先按旧宽度渲染一帧，看起来就是「松手闪一下」。
        // 期间若已经开出新的一次调整，就把它留给那一次收尾。
        setDragBase((current) =>
          current && current.side === side && current.base === base ? null : current,
        );
      });
    },
    [persistWorkspaceLayout],
  );

  const handleToggleSidebar = () => {
    persistWorkspaceLayout({ sidebarOpen: !sidebarOpen });
  };

  const handleToggleAgentPanel = () => {
    persistWorkspaceLayout({ agentOpen: !agentPanelOpen });
  };

  const startPanelResize = useCallback(
    (side: PanelSide, e: React.PointerEvent<HTMLDivElement>) => {
      const bounds = side === 'sidebar' ? sidebarBounds : dockBounds;
      if (e.button !== 0 || isExclusive || !bounds.draggable) return;
      // 只捕获指针、不 preventDefault：焦点与选区的守卫在 SplitHandle 的 mousedown 上
      // （取消 pointerdown 有引擎会连 click / dblclick 一起掐掉）。
      e.currentTarget.setPointerCapture(e.pointerId);
      const layout = normalizeWorkspaceLayout(workspaceLayout);
      const baseStart =
        side === 'sidebar' ? layout.sidebarBaseWidth : dockBaseWidthOf(layout);
      resizeSessionRef.current = {
        side,
        pointerId: e.pointerId,
        pointerStartX: e.clientX,
        baseStart,
        baseCurrent: baseStart,
        bounds,
        scale: resolveWorkspaceScale(layoutWidth),
      };
      setResizingSide(side);
    },
    [dockBounds, isExclusive, layoutWidth, sidebarBounds, workspaceLayout],
  );

  const movePanelResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const session = resizeSessionRef.current;
    if (!session || e.pointerId !== session.pointerId) return;
    const delta =
      session.side === 'sidebar' ? e.clientX - session.pointerStartX : session.pointerStartX - e.clientX;
    // 指针位移 ÷ 缩放 = 基准位移；自由空间里两次缩放正好抵消，面板与指针 1:1 跟手
    const base = Math.min(
      session.bounds.max,
      Math.max(session.bounds.min, Math.round(session.baseStart + delta / session.scale)),
    );
    if (base === session.baseCurrent) return;
    session.baseCurrent = base;
    setDragBase({ side: session.side, base });
  }, []);

  const endPanelResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const session = resizeSessionRef.current;
      if (!session || e.pointerId !== session.pointerId) return;
      resizeSessionRef.current = null;
      setResizingSide(null);
      if (session.baseCurrent === session.baseStart) {
        // 只是点了一下：撤掉覆盖值，别让没动过的宽度顶住布局
        setDragBase((current) => (current && current.side === session.side ? null : current));
        return;
      }
      commitPanelBase(session.side, session.baseCurrent);
    },
    [commitPanelBase],
  );

  const nudgePanelResize = useCallback(
    (side: PanelSide, delta: number) => {
      const bounds = side === 'sidebar' ? sidebarBounds : dockBounds;
      const layout = normalizeWorkspaceLayout(workspaceLayout);
      const current =
        dragBase && dragBase.side === side
          ? dragBase.base
          : side === 'sidebar'
            ? layout.sidebarBaseWidth
            : dockBaseWidthOf(layout);
      const base = Math.min(
        bounds.max,
        Math.max(bounds.min, current + Math.round(delta / resolveWorkspaceScale(layoutWidth))),
      );
      if (base === current) return;
      setDragBase({ side, base });
      pendingNudgeRef.current = { side, base };
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = setTimeout(() => {
        nudgeTimerRef.current = null;
        const pending = pendingNudgeRef.current;
        pendingNudgeRef.current = null;
        if (pending) commitPanelBase(pending.side, pending.base);
      }, NUDGE_COMMIT_MS);
    },
    [dockBounds, commitPanelBase, dragBase, layoutWidth, sidebarBounds, workspaceLayout],
  );

  const resetPanelWidth = useCallback(
    (side: PanelSide) => {
      const bounds = side === 'sidebar' ? sidebarBounds : dockBounds;
      // 复位到「当前停在 dock 上的那个面板」自己的默认宽度
      const fallback = defaultBaseWidthOf(side, workspaceLayout);
      const base = Math.min(bounds.max, Math.max(bounds.min, fallback));
      setDragBase({ side, base });
      commitPanelBase(side, base);
    },
    [dockBounds, commitPanelBase, sidebarBounds, workspaceLayout],
  );

  // 拖动期间把光标钉死：终端（xterm 自带 cursor: text）之类的内容会盖掉 body 上的继承值，
  // 拖到夹紧位置、指针离开把手之后光标就不该再变成 I 形。
  useEffect(() => {
    const className = 'marcel-resizing-x';
    if (resizingSide) document.body.classList.add(className);
    else document.body.classList.remove(className);
    return () => document.body.classList.remove(className);
  }, [resizingSide]);

  useEffect(
    () => () => {
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    appReady().catch(console.error);
    // 清理上次未正常退出的图片预览临时文件
    sftpPreviewCleanup().catch((err) => {
      console.warn('清理预览临时文件失败:', err);
    });
    // 预加载设置页面，消除首次进入的模块加载延迟
    const preload = () => import('@/components/settings/Settings');
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(preload);
    } else {
      setTimeout(preload, 1000);
    }
  }, []);

  useEffect(() => {
    // 聚合启动快照：一次 IPC 注入 settings + connections + skills
    hydrateBootstrapData().catch(err => {
      console.error('Failed to hydrate bootstrap data:', err);
    });
    initPluginIpc().catch(err => {
      console.error('Failed to init plugin IPC:', err);
    });
    initRegionBridge();
    // 插件市场后台检查更新（不阻塞启动）
    void useMarketStore.getState().fetch().catch(() => {});
    // 订阅是同步幂等的（守卫同步生效），返回值必须接：卸载时退订，
    // StrictMode 第二轮挂载会重新注册。
    return ensurePluginRegistryListener();
  }, []);

  // 设置加载完成、或 disabledPlugins 变化时再拉插件并对齐 viewStore。
  // 覆盖：启动竞态、设置页保存禁用、错误页「禁用」等路径。
  useEffect(() => {
    if (!settingsLoaded) return;
    fetchPlugins().catch(err => {
      console.error('Failed to load plugins:', err);
    });
  }, [settingsLoaded, disabledPlugins, fetchPlugins]);

  // Reconcile content-script injections when capability authorization / safe-mode
  // toggle changes. fetchPlugins already syncs on enablement changes.
  useEffect(() => {
    if (!settingsLoaded) return;
    syncInjections();
  }, [syncInjections, settingsLoaded, disableAllInjections, authorizedCapabilities]);

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
    const valid: AgentMode[] = ['plan', 'agent', 'auto'];
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

  /** 终端主体（不含标签栏）：进 dock 的只有这一份。标签栏恒驻主区域顶部，
   *  「Agent 占主区域」时它留在 Agent 上方（主区域顶条），不跟终端进 dock。 */
  const terminalBody = (
    <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {centerProvider && centerProvider.pluginId !== 'builtin' ? (
        <PluginWebviewSlot key={`${centerProvider.id}-${pluginRefreshKey}`} provider={centerProvider} />
      ) : (
        <Suspense fallback={null}>{CenterView && <CenterView />}</Suspense>
      )}
    </main>
  );

  /** 终端那一份内容（挂载点 center）：标签栏 + 中心视图。 */
  const terminalPane = (
    <>
      <TabBar />
      {terminalBody}
    </>
  );

  /** Agent 面板内容（挂载点 agent）。 */
  const agentPane =
    agentProvider && agentProvider.pluginId !== 'builtin' ? (
      <PluginWebviewSlot key={`${agentProvider.id}-${pluginRefreshKey}`} provider={agentProvider} />
    ) : (
      AgentView && <AgentView />
    );

  return (
    <div className="relative">
      <AppHeader
        onToggleSidebar={handleToggleSidebar}
        onToggleDock={handleToggleAgentPanel}
        dockPanel={dockPanel}
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
            <SplitHandle
              label="调整侧边栏宽度"
              value={sidebarWidth}
              min={sidebarBounds.minDisplayed}
              max={sidebarBounds.maxDisplayed}
              active={resizingSide === 'sidebar'}
              draggable={sidebarBounds.draggable && !isExclusive}
              growDirection={1}
              onPointerDown={(e) => startPanelResize('sidebar', e)}
              onPointerMove={movePanelResize}
              onPointerUp={endPanelResize}
              onPointerCancel={endPanelResize}
              onNudge={(delta) => nudgePanelResize('sidebar', delta)}
              onReset={() => resetPanelWidth('sidebar')}
            />
          )}

          {/*
            主区域：默认停终端（含标签栏），开启「Agent 占主区域」后主区域停 Agent、
            终端主体换到右侧固定栏。标签栏不跟着走：它恒驻主区域顶条（此时在
            Agent 上方），dock 里只停终端本体——终端没有可显示的会话时（dock
            合上）标签栏也一并隐藏。区域名跟随**逻辑面板**而不是物理左右
            （center = 终端那一份视图 / agent = Agent 面板）：挂载点本身就是逻辑的
            （builtin.terminal 的 mount 就是 center），插件按区域名注入时不会因为
            用户换了布局而漂到另一边。
          */}
          <div
            data-region={agentPrimary ? 'agent' : 'center'}
            className="layout-contained flex-1 flex flex-col min-w-0 overflow-hidden relative"
          >
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
            ) : agentPrimary ? (
              <>
                {dockMounted && dockVisible && <TabBar />}
                <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
                  {/* AgentPanel 是 lazy 的：agentPrimary 下它在主区域首帧就渲染，
                      没有边界的话，chunk 加载窗口内任何一个同步更新（启动时
                      settings/作业/会话事件齐发）都会致命——「A component
                      suspended while responding to synchronous input」。 */}
                  <Suspense fallback={<div className="flex-1 bg-zinc-900" />}>{agentPane}</Suspense>
                </main>
              </>
            ) : (
              terminalPane
            )}
          </div>

          <div
            className="layout-contained flex overflow-hidden flex-shrink-0"
            style={{
              width: dockVisible ? `${dockWidth + 4}px` : '0px',
              transition: isResizing || isWindowResizing ? 'none' : 'width 300ms var(--spring-bounce, cubic-bezier(0.34, 1.56, 0.64, 1))',
            }}
          >
            {dockMounted && dockVisible && (
              <>
                <SplitHandle
                  label={agentPrimary ? '调整终端栏宽度' : '调整 Agent 面板宽度'}
                  value={dockWidth}
                  min={dockBounds.minDisplayed}
                  max={dockBounds.maxDisplayed}
                  active={resizingSide === 'dock'}
                  draggable={dockBounds.draggable && !isExclusive}
                  // 把手在面板左缘：左方向键把面板拉宽
                  growDirection={-1}
                  onPointerDown={(e) => startPanelResize('dock', e)}
                  onPointerMove={movePanelResize}
                  onPointerUp={endPanelResize}
                  onPointerCancel={endPanelResize}
                  onNudge={(delta) => nudgePanelResize('dock', delta)}
                  onReset={() => resetPanelWidth('dock')}
                />
                <aside
                  data-region={agentPrimary ? 'center' : 'agent'}
                  className="layout-contained flex flex-col overflow-hidden border-l border-zinc-800 flex-shrink-0"
                  style={{ width: `${dockWidth}px` }}
                >
                  {agentPrimary ? terminalBody : (
                    /* 默认布局的 dock 同样渲染 lazy 的 agentPane：靠 ResizeObserver
                       时序躲过了同步更新窗口，那是运气不是保证，边界必须显式给。 */
                    <Suspense fallback={<div className="flex-1 bg-zinc-900" />}>{agentPane}</Suspense>
                  )}
                </aside>
              </>
            )}
          </div>
        </div>
      </div>

      <SettingsWarningToast />
      <HostKeyWarningToast />
      <StarPromptModal />
      <GlobalInteractionOverlay />

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
