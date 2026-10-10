import {
  useEffect,
  useLayoutEffect,
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
  type ResolvedWorkspaceLayout,
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
 * 一次指针拖动的全部状态。放 ref 而不是 state：指针移动期间**不进 React 渲染路径**
 * （每个 pointermove 都 setState 会让整棵 App 树跟着每帧重渲，右侧分隔条拖动时
 * 叠加聊天区回流 + 终端跨格重画，是拖动卡顿的根源），事件靠 Pointer 捕获直接回到
 * 把手，不挂 document 监听、不进 effect 依赖。
 *
 * 宽度以**基准宽度**为单位推进（不是屏幕像素），松手存的就是推进到的那个值，
 * 所以「松手后停在松手前的位置」是构造出来的，不是对齐出来的。
 */
interface ResizeSession {
  side: PanelSide;
  pointerId: number;
  pointerStartX: number;
  /** 最新指针位置，rAF 帧里消费。 */
  latestClientX: number;
  baseStart: number;
  baseCurrent: number;
  bounds: PanelBaseBounds;
  scale: number;
  /** 求解输入快照：与 bounds 一样对手势冻结（拖动中途改设置是走不到的路径）。 */
  workspaceLayout: WorkspaceLayoutSettings;
  sidebarOpen: boolean;
  agentOpen: boolean;
  isExclusive: boolean;
  rafId: number | null;
  /** 本次手势是否写过候选宽度（决定「只是点了一下」收摊时要不要撤覆盖值）。 */
  touchedOverride: boolean;
}

/**
 * 拖动/方向键期间尚未落盘的候选宽度。每帧算好的三栏显示宽直接写 DOM
 * （与 panel/ContentWidthHandles 同一架构），渲染路径不感知；store 拿到
 * 提交值之后才撤掉。快照字段用于自愈 effect 判废：与当前不一致就作废，
 * 交还给 React 的正常渲染。
 */
interface LiveWidthOverride {
  side: PanelSide;
  base: number;
  layout: ResolvedWorkspaceLayout;
  containerWidth: number;
  sidebarOpen: boolean;
  agentOpen: boolean;
  isExclusive: boolean;
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
  /** 拖动/方向键期间未落盘的候选宽度（含算好的三栏显示宽），直写 DOM 用。 */
  const liveOverrideRef = useRef<LiveWidthOverride | null>(null);
  const sidebarAsideRef = useRef<HTMLElement>(null);
  const sidebarInnerRef = useRef<HTMLDivElement>(null);
  const dockWrapRef = useRef<HTMLDivElement>(null);
  const dockAsideRef = useRef<HTMLElement>(null);
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNudgeRef = useRef<{ side: PanelSide; base: number } | null>(null);
  const [layoutWidth, setLayoutWidth] = useState(0);
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

  // 布局求解只依赖 store 与窗口宽。拖动/方向键期间的候选宽度走 liveOverride
  // 直写 DOM，不进渲染路径；store 拿到提交值后，这里的求解结果自然与 DOM 一致。
  const resolvedLayout = useMemo(
    () =>
      resolveWorkspaceLayout({
        containerWidth: layoutWidth,
        settings: workspaceLayout,
        sidebarOpen,
        agentOpen: agentPanelOpen,
        isExclusive,
      }),
    [agentPanelOpen, isExclusive, layoutWidth, workspaceLayout, sidebarOpen],
  );

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

  /** 落盘一次面板基准宽度，返回落盘完成的 promise（调用方据此撤候选宽度覆盖值）。 */
  const commitPanelBase = useCallback(
    (side: PanelSide, base: number) => {
      // 落盘字段从 store 现取（和 persistWorkspaceLayout 同一个理由）：互换模式下
      // dock 停的是终端，这一笔要写进 terminalBaseWidth，两栏各记各的宽度。
      const current = useSettingsStore.getState().settings.workspaceLayout;
      return persistWorkspaceLayout(baseWidthPatch(side, current, base));
    },
    [persistWorkspaceLayout],
  );

  const cancelPendingNudge = useCallback(() => {
    if (nudgeTimerRef.current) {
      clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = null;
    }
    pendingNudgeRef.current = null;
  }, []);

  const handleToggleSidebar = () => {
    persistWorkspaceLayout({ sidebarOpen: !sidebarOpen });
  };

  const handleToggleAgentPanel = () => {
    persistWorkspaceLayout({ agentOpen: !agentPanelOpen });
  };

  /** 把一次求解结果直接写到四块承载宽度的 DOM 上（不经过 React）。 */
  const applyDragWidths = useCallback((layout: ResolvedWorkspaceLayout) => {
    const { sidebarWidth, dockWidth } = layout;
    if (sidebarAsideRef.current) sidebarAsideRef.current.style.width = `${sidebarWidth}px`;
    if (sidebarInnerRef.current) sidebarInnerRef.current.style.width = `${sidebarWidth}px`;
    if (dockWrapRef.current) {
      dockWrapRef.current.style.width = `${dockWidth > 0 ? dockWidth + 4 : 0}px`;
    }
    if (dockAsideRef.current) dockAsideRef.current.style.width = `${dockWidth}px`;
  }, []);

  /** 一帧拖动推进：算候选基准 → 求解三栏显示宽 → 写 DOM + 记覆盖值。 */
  const runResizeFrame = useCallback(() => {
    const session = resizeSessionRef.current;
    if (!session) return;
    session.rafId = null;
    const dx =
      session.side === 'sidebar'
        ? session.latestClientX - session.pointerStartX
        : session.pointerStartX - session.latestClientX;
    // 指针位移 ÷ 缩放 = 基准位移；自由空间里两次缩放正好抵消，面板与指针 1:1 跟手
    const base = Math.min(
      session.bounds.max,
      Math.max(session.bounds.min, Math.round(session.baseStart + dx / session.scale)),
    );
    const override = liveOverrideRef.current;
    if (base === session.baseCurrent && override?.side === session.side) return;
    // 容器宽取实时值：窗口缩放插进来的帧也按新宽求解
    const containerWidth = mainRowWidthRef.current;
    const layout = resolveWorkspaceLayout({
      containerWidth,
      settings: {
        ...session.workspaceLayout,
        ...baseWidthPatch(session.side, session.workspaceLayout, base),
      },
      sidebarOpen: session.sidebarOpen,
      agentOpen: session.agentOpen,
      isExclusive: session.isExclusive,
    });
    session.baseCurrent = base;
    session.touchedOverride = true;
    liveOverrideRef.current = {
      side: session.side,
      base,
      layout,
      containerWidth,
      sidebarOpen: session.sidebarOpen,
      agentOpen: session.agentOpen,
      isExclusive: session.isExclusive,
    };
    applyDragWidths(layout);
  }, [applyDragWidths]);

  const startPanelResize = useCallback(
    (side: PanelSide, e: React.PointerEvent<HTMLDivElement>) => {
      const bounds = side === 'sidebar' ? sidebarBounds : dockBounds;
      if (e.button !== 0 || isExclusive || !bounds.draggable) return;
      // 只捕获指针、不 preventDefault：焦点与选区的守卫在 SplitHandle 的 mousedown 上
      // （取消 pointerdown 有引擎会连 click / dblclick 一起掐掉）。
      e.currentTarget.setPointerCapture(e.pointerId);
      // 上一次手势/方向键的候选宽度还没落盘时从它接着走，别跳回 store 旧值；
      // 同时掐掉未决的方向键提交——拖动的松手提交会一并把最终值落盘。
      // 不管来源是哪，都先夹进响应区间：旧版本落盘过「撞墙后基准仍在前进」的
      // 值（显示已贴死、基准还虚高），不夹的话下一次拖拽要先把虚高消费完才有响应。
      const pendingOverride = liveOverrideRef.current;
      const layout = normalizeWorkspaceLayout(workspaceLayout);
      const rawBase =
        pendingOverride && pendingOverride.side === side
          ? pendingOverride.base
          : side === 'sidebar'
            ? layout.sidebarBaseWidth
            : dockBaseWidthOf(layout);
      const baseStart = Math.min(bounds.max, Math.max(bounds.min, rawBase));
      cancelPendingNudge();
      resizeSessionRef.current = {
        side,
        pointerId: e.pointerId,
        pointerStartX: e.clientX,
        latestClientX: e.clientX,
        baseStart,
        baseCurrent: baseStart,
        bounds,
        scale: resolveWorkspaceScale(layoutWidth),
        workspaceLayout: layout,
        sidebarOpen,
        agentOpen: agentPanelOpen,
        isExclusive,
        rafId: null,
        touchedOverride: false,
      };
      setResizingSide(side);
    },
    [
      agentPanelOpen,
      cancelPendingNudge,
      dockBounds,
      isExclusive,
      layoutWidth,
      sidebarBounds,
      sidebarOpen,
      workspaceLayout,
    ],
  );

  const movePanelResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const session = resizeSessionRef.current;
      if (!session || e.pointerId !== session.pointerId) return;
      session.latestClientX = e.clientX;
      // rAF 合帧：一帧最多求解一次、写一次 DOM，渲染路径完全不感知
      session.rafId ??= requestAnimationFrame(runResizeFrame);
    },
    [runResizeFrame],
  );

  const endPanelResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const session = resizeSessionRef.current;
      if (!session || e.pointerId !== session.pointerId) return;
      if (session.rafId !== null) {
        cancelAnimationFrame(session.rafId);
        session.rafId = null;
      }
      if (session.baseCurrent === session.baseStart) {
        // 只是点了一下：候选宽度没动过（或回到了起点），撤掉本次手势可能写过的
        // 覆盖值，别让没动过的宽度顶住布局；先前手势留下的覆盖值不动。
        resizeSessionRef.current = null;
        if (session.touchedOverride) liveOverrideRef.current = null;
        setResizingSide(null);
        return;
      }
      // 落盘一次；store 拿到新值之前会话还活着（自愈 effect 把 DOM 宽度钉在
      // 拖动终值上），拿到之后再交还 React——早交还就会先按旧宽度渲染一帧，
      // 看起来就是「松手弹回」。
      const { side, baseCurrent: base } = session;
      void commitPanelBase(side, base).then(() => {
        const override = liveOverrideRef.current;
        if (override && override.side === side && override.base === base) {
          liveOverrideRef.current = null;
        }
        // 期间若已经开出新的一次调整，会话已被它替换，这里不动它的状态。
        if (resizeSessionRef.current === session) {
          resizeSessionRef.current = null;
          setResizingSide(null);
        }
      });
    },
    [commitPanelBase],
  );

  const nudgePanelResize = useCallback(
    (side: PanelSide, delta: number) => {
      const containerWidth = mainRowWidthRef.current;
      if (containerWidth <= 0) return;
      const bounds = side === 'sidebar' ? sidebarBounds : dockBounds;
      const layout = normalizeWorkspaceLayout(workspaceLayout);
      const override = liveOverrideRef.current;
      // 同 startPanelResize：store 里可能存着撞墙虚高的旧基准，先夹进响应区间
      const current = Math.min(
        bounds.max,
        Math.max(
          bounds.min,
          override && override.side === side
            ? override.base
            : side === 'sidebar'
              ? layout.sidebarBaseWidth
              : dockBaseWidthOf(layout),
        ),
      );
      const base = Math.min(
        bounds.max,
        Math.max(bounds.min, current + Math.round(delta / resolveWorkspaceScale(layoutWidth))),
      );
      if (base === current) return;
      const solved = resolveWorkspaceLayout({
        containerWidth,
        settings: { ...layout, ...baseWidthPatch(side, layout, base) },
        sidebarOpen,
        agentOpen: agentPanelOpen,
        isExclusive,
      });
      liveOverrideRef.current = {
        side,
        base,
        layout: solved,
        containerWidth,
        sidebarOpen,
        agentOpen: agentPanelOpen,
        isExclusive,
      };
      applyDragWidths(solved);
      pendingNudgeRef.current = { side, base };
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current);
      nudgeTimerRef.current = setTimeout(() => {
        nudgeTimerRef.current = null;
        const pending = pendingNudgeRef.current;
        pendingNudgeRef.current = null;
        if (!pending) return;
        void commitPanelBase(pending.side, pending.base).then(() => {
          const o = liveOverrideRef.current;
          if (o && o.side === pending.side && o.base === pending.base) {
            liveOverrideRef.current = null;
          }
        });
      }, NUDGE_COMMIT_MS);
    },
    [
      agentPanelOpen,
      applyDragWidths,
      commitPanelBase,
      dockBounds,
      isExclusive,
      layoutWidth,
      sidebarBounds,
      sidebarOpen,
      workspaceLayout,
    ],
  );

  const resetPanelWidth = useCallback(
    (side: PanelSide) => {
      // 双击复位会改写该栏宽度，未决的方向键提交不许再盖上来
      cancelPendingNudge();
      const bounds = side === 'sidebar' ? sidebarBounds : dockBounds;
      // 复位到「当前停在 dock 上的那个面板」自己的默认宽度
      const fallback = defaultBaseWidthOf(side, workspaceLayout);
      const base = Math.min(bounds.max, Math.max(bounds.min, fallback));
      void commitPanelBase(side, base).then(() => {
        const override = liveOverrideRef.current;
        if (override && override.side === side) liveOverrideRef.current = null;
      });
    },
    [cancelPendingNudge, commitPanelBase, dockBounds, sidebarBounds, workspaceLayout],
  );

  // 拖动期间把光标钉死：终端（xterm 自带 cursor: text）之类的内容会盖掉 body 上的继承值，
  // 拖到夹紧位置、指针离开把手之后光标就不该再变成 I 形。
  useEffect(() => {
    const className = 'marcel-resizing-x';
    if (resizingSide) document.body.classList.add(className);
    else document.body.classList.remove(className);
    return () => document.body.classList.remove(className);
  }, [resizingSide]);

  // 自愈：候选宽度尚未落盘期间，任何其他原因触发的渲染（流式消息、store 事件）
  // 都会用 store 旧宽度重写 inline style；渲染完成后立刻把覆盖值重新套回去，
  // 避免单帧跳变。求解输入已变的（窗口缩放、开合切换、视图互换）覆盖值作废。
  // 没有覆盖值时把 DOM 对齐到本次渲染的求解结果：手势期间的直写不经过 React，
  // React 对「值没变」的渲染会跳过 DOM 写入，不对账就会在 React 视角之外留残值
  // （落盘失败时尤其如此——松手后 DOM 必须回到 store 的真相）。
  useLayoutEffect(() => {
    const override = liveOverrideRef.current;
    if (override) {
      if (
        override.containerWidth !== mainRowWidthRef.current ||
        override.sidebarOpen !== effectiveSidebarOpen ||
        override.agentOpen !== effectiveAgentPanelOpen ||
        override.isExclusive !== isExclusive
      ) {
        liveOverrideRef.current = null;
      } else {
        applyDragWidths(override.layout);
        return;
      }
    }
    applyDragWidths(resolvedLayout);
  });

  useEffect(
    () => () => {
      cancelPendingNudge();
      const session = resizeSessionRef.current;
      if (session && session.rafId !== null) cancelAnimationFrame(session.rafId);
    },
    [cancelPendingNudge],
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
            ref={sidebarAsideRef}
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
            <div ref={sidebarInnerRef} style={{ width: `${sidebarWidth}px`, height: '100%' }}>
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
            Agent 上方），dock 里只停终端本体——dock 合上（终端没显示）时标签栏
            照样在：只要还有 SSH 会话，这里就是唯一能看见/切换/重连它们的地方
            （没有会话时 TabBar 自己返回 null）。区域名跟随**逻辑面板**而不是物理左右
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
                <TabBar />
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
            ref={dockWrapRef}
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
                  ref={dockAsideRef}
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
