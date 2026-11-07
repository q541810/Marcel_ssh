import { useRef, useEffect, useLayoutEffect, useState, useMemo } from 'react';
import { sshSendInput } from '@/lib/tauri';
import { BOTTOM_TABS, DEFAULT_TERMINAL_COLORS, type BottomTab } from '@/lib/constants';
import { buildTerminalFontFamily } from '@/lib/terminalFont';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useViewStore, byMount } from '@/stores/viewStore';
import QuickCommandPanel from './QuickCommandPanel';
import ProcessPanel from './ProcessPanel';
import NetworkPanel from './NetworkPanel';
import PortForwardPanel from './PortForwardPanel';
import FileManagerPanel from '../sftp/FileManagerPanel';
import BottomTabBar from './BottomTabBar';
import PasteConfirmDialog from './PasteConfirmDialog';
import PluginWebviewSlot from '@/plugins/PluginWebviewSlot';
import { usePluginStore } from '@/stores/pluginStore';
import { useClipboardHandler } from '@/hooks/useClipboardHandler';
import { useTerminalBottomPanel } from './useTerminalBottomPanel';
import { terminalInstanceManager } from './TerminalInstanceManager';
import {
  PanelTransition,
  PANEL_TRANSITION_EASING,
  PANEL_TRANSITION_MS,
} from './terminalPanelTransition';
import { isDebugSession } from '@/lib/debugServer';
import { resolveTerminalColors } from '@/lib/terminalTheme';
import { useDebugStore } from '@/stores/debugStore';
import { useTerminalFontZoom } from '@/hooks/useTerminalFontZoom';
import { isFontZooming, wheelZoomSteps } from '@/lib/terminalFontZoom';
import { TerminalZoomHint } from './TerminalZoomHint';

/** 最后一次 Ctrl+滚轮 / 触控板捏合之后，停多久才算这次缩放结束并落盘。 */
const FONT_ZOOM_COMMIT_DELAY_MS = 250;

export default function Terminal() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [pasteConfirm, setPasteConfirm] = useState(() => terminalInstanceManager.getPasteConfirm());
  const fitFrameRef = useRef<number | null>(null);
  const activeInstanceIdRef = useRef<string | null>(null);
  const lastWrapperSizeRef = useRef<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelTransitionRef = useRef<PanelTransition | null>(null);
  if (panelTransitionRef.current === null) panelTransitionRef.current = new PanelTransition();
  const panelTransition = panelTransitionRef.current;

  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const storeSettings = useSettingsStore((s) => s.settings);
  const preview = useSettingsStore((s) => s.preview);
  const {
    terminalRootRef,
    activeTab,
    setActiveTab,
    displayTab,
    isResizingPanel,
    panelHeight,
    handlePanelResizeMouseDown,
  } = useTerminalBottomPanel();

  const { handleCopy } = useClipboardHandler();

  const providers = useViewStore((s) => s.providers);
  const pluginRefreshKey = usePluginStore((s) => s.refreshKey);
  const pluginBottomProviders = useMemo(() => byMount(providers, 'bottom'), [providers]);
  const pluginBottomTabs: BottomTab[] = useMemo(
    () =>
      pluginBottomProviders.map((p) => ({
        id: `plugin:${p.id}`,
        icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
        label: p.title,
      })),
    [pluginBottomProviders],
  );
  const allTabs = useMemo(() => [...BOTTOM_TABS, ...pluginBottomTabs], [pluginBottomTabs]);
  const activePluginView = useMemo(
    () => pluginBottomProviders.find((p) => `plugin:${p.id}` === activeTab) ?? null,
    [pluginBottomProviders, activeTab],
  );

  useEffect(() => {
    if (activeTab?.startsWith('plugin:') && !activePluginView) {
      setActiveTab(null);
    }
  }, [activeTab, activePluginView, setActiveTab]);

  const fontSize = preview?.fontSize ?? storeSettings.fontSize;
  const fontFamily = preview?.fontFamily ?? storeSettings.fontFamily;
  // The debug light theme is persisted by debugStore and mirrored on <html>.
  // Resolve it here so already-mounted xterm instances repaint immediately.
  const lightMode = useDebugStore((s) => s.lightMode);
  const terminalColors = resolveTerminalColors(
    preview?.terminalColors ?? storeSettings.terminalColors ?? DEFAULT_TERMINAL_COLORS,
    lightMode,
  );

  // Register callbacks for paste confirm and copy
  useEffect(() => {
    const unsubscribePasteConfirm = terminalInstanceManager.onPasteConfirmChange(setPasteConfirm);
    terminalInstanceManager.setCopyCallback((terminal) => {
      handleCopy(terminal);
    });
    return () => {
      unsubscribePasteConfirm();
      terminalInstanceManager.setCopyCallback(null);
    };
  }, [handleCopy]);

  useEffect(() => {
    activeInstanceIdRef.current = activeInstanceId;
  }, [activeInstanceId]);

  // 底栏展开 / 收起：把整个 200ms 过渡期的 fit 收敛成一次，并让文字位移保持平滑
  // （原理见 terminalPanelTransition.ts）。布局 effect：必须在浏览器画第一帧之前
  // 读到面板的起始高度、定下终端的最终行数。
  const panelOpen = activeTab !== null;
  const panelOpenRef = useRef(panelOpen);
  const panelHeightRef = useRef(panelHeight);
  useLayoutEffect(() => {
    panelHeightRef.current = panelHeight;
  });
  useLayoutEffect(() => {
    if (panelOpenRef.current === panelOpen) return;
    panelOpenRef.current = panelOpen;
    const panel = panelRef.current;
    const instanceId = useSessionStore.getState().activeSessionId;
    // 面板没挂载（会话未连接）或没有活动终端：没有动画可协调，交给 ResizeObserver。
    if (!panel || !instanceId) return;
    const instance = terminalInstanceManager.get(instanceId);
    if (!instance) return;
    const from = panel.offsetHeight;
    const to = panelOpen ? panelHeightRef.current : 0;
    panelTransition.run({
      instance,
      delta: to - from,
      onSettled: (settled) => terminalInstanceManager.resizeRemoteIfChanged(settled),
    });
  }, [panelOpen, panelTransition]);

  useEffect(() => () => panelTransition.settle(), [panelTransition]);

  // Ctrl+滚轮 / 触控板捏合调终端字号。Chromium 把触控板捏合也报成 ctrlKey 的 wheel，
  // 所以一个监听两种输入都管。途中只在本地重排，停手后才落盘并通知远端 resize。
  const fontZoom = useTerminalFontZoom({
    commitDelayMs: FONT_ZOOM_COMMIT_DELAY_MS,
    onSettled: () => {
      const instanceId = activeInstanceIdRef.current;
      const instance = instanceId ? terminalInstanceManager.get(instanceId) : undefined;
      if (!instance?.fitAddon) return;
      terminalInstanceManager.fit(instance);
      terminalInstanceManager.resizeRemoteIfChanged(instance);
    },
  });
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    let residual = 0;
    // 捕获阶段 + 非 passive：既要抢在 xterm 自己的滚轮处理（回滚 / 鼠标上报）之前，
    // 也要 preventDefault，免得 WebView 把 Ctrl+滚轮当成整页缩放。只拦终端区域内的。
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const result = wheelZoomSteps(event.deltaY, event.deltaMode, residual);
      residual = result.residual;
      if (result.steps !== 0) fontZoom.step(result.steps);
    };
    wrapper.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => wrapper.removeEventListener('wheel', onWheel, { capture: true });
  }, [fontZoom]);

  const scheduleActiveFit = () => {
    if (fitFrameRef.current !== null) return;
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      const instanceId = activeInstanceIdRef.current;
      if (!instanceId) return;
      const instance = terminalInstanceManager.get(instanceId);
      // 休眠中的终端没有 xterm 可 fit；唤醒后的 fit 由同步 effect 负责。
      if (!instance?.fitAddon) return;
      terminalInstanceManager.fit(instance);
      terminalInstanceManager.resizeRemoteIfChanged(instance);
    });
  };

  // Sync terminals with sessions
  useEffect(() => {
    // 过渡中途切走 / 关掉了会话：让它立刻收尾，别把位移和 fit 留给不在前台的终端。
    panelTransition.settleUnless(activeSessionId);

    const currentIds = new Set(Object.keys(sessions));

    // Create new terminals for new sessions; apply status if already terminal
    for (const sessionId of currentIds) {
      const justCreated = !terminalInstanceManager.has(sessionId);
      if (justCreated) {
        terminalInstanceManager.create(sessionId);
      }
      // Cover races where status became error/disconnected before xterm existed
      // (e.g. initial connect failure on tempId). Idempotent via banner flag.
      const session = sessions[sessionId];
      if (session?.status === 'error') {
        terminalInstanceManager.showDisconnectBanner(
          sessionId,
          'error',
          session.errorMessage ?? '未知错误',
        );
      } else if (session?.status === 'disconnected') {
        terminalInstanceManager.showDisconnectBanner(
          sessionId,
          session.errorMessage === '已主动断开连接' ? 'manual' : 'disconnected',
          session.errorMessage ?? '连接已关闭',
        );
      } else if (session?.status === 'connecting') {
        terminalInstanceManager.setStdinEnabled(sessionId, false);
      }
    }

    // Remove terminals for closed sessions
    for (const sessionId of terminalInstanceManager.getIds()) {
      if (!currentIds.has(sessionId)) {
        terminalInstanceManager.destroy(sessionId);
      }
    }

    // Attach terminals to wrapper and show/hide
    if (wrapperRef.current) {
      for (const sessionId of terminalInstanceManager.getIds()) {
        terminalInstanceManager.attach(sessionId, wrapperRef.current);
        terminalInstanceManager.setVisible(sessionId, sessionId === activeSessionId);
      }
    }

    // Focus active terminal。后台久了的终端会被休眠成内存快照，先等它还原完
    // 再 fit / 聚焦（setVisible 已经触发了唤醒，这里只是等它落定）。
    if (activeSessionId) {
      const focusId = activeSessionId;
      void terminalInstanceManager.wake(focusId).then(() => {
        requestAnimationFrame(() => {
          // 等待期间用户可能又切走了，别把焦点抢回已经不在前台的终端。
          if (useSessionStore.getState().activeSessionId !== focusId) return;
          const instance = terminalInstanceManager.get(focusId);
          if (!instance?.terminal || !instance.fitAddon) return;
          terminalInstanceManager.fit(instance);
          instance.terminal.focus();
          terminalInstanceManager.resizeRemoteIfChanged(instance);
        });
      });
    }

    setActiveInstanceId(activeSessionId);
  }, [sessions, activeSessionId, panelTransition]);

  // Handle resize
  useEffect(() => {
    if (!wrapperRef.current) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
      // 底栏过渡期间终端区逐帧变矮，但 fit 只在过渡开始 / 结束时做一次（见上）。
      // 不记录尺寸：收尾后的最终尺寸要能触发一次兜底 fit。
      if (panelTransition.active) return;
      const size = {
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      };
      const lastSize = lastWrapperSizeRef.current;
      if (lastSize?.width === size.width && lastSize?.height === size.height) return;
      lastWrapperSizeRef.current = size;
      scheduleActiveFit();
    });

    resizeObserver.observe(wrapperRef.current);

    return () => {
      resizeObserver.disconnect();
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
    };
  }, [panelTransition]);

  // Apply settings changes
  useEffect(() => {
    const appliedFontFamily = buildTerminalFontFamily(fontFamily);
    // 外观交给管理器记下来：休眠后重建的终端要用最终生效的字体 / 配色，
    // 而不是只读设置存档（预览与调试主题不在存档里）。
    terminalInstanceManager.applyAppearance({
      fontSize,
      fontFamily: appliedFontFamily,
      theme: terminalColors,
    });
    for (const [, instance] of terminalInstanceManager.getAll()) {
      if (!instance.terminal) continue;
      requestAnimationFrame(() => {
        terminalInstanceManager.fit(instance);
        // 缩放手势途中只在本地重排，远端 resize 等手势结束由 fontZoom 的 onSettled 补发。
        if (instance.id === activeInstanceId && !isFontZooming()) {
          terminalInstanceManager.resizeRemoteIfChanged(instance);
        }
      });
    }
  }, [fontSize, fontFamily, terminalColors, activeInstanceId]);

  const hasSessions = Object.keys(sessions).length > 0;

  return (
    <div ref={terminalRootRef} data-region="terminal" className="flex flex-col flex-1 h-full bg-surface">
      {/* overflow-hidden：过渡期间终端内容带着位移，不能越过终端区盖住正在滑动的面板 */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div ref={wrapperRef} className="absolute inset-0" />
        <TerminalZoomHint />
        {!hasSessions && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/95 z-10">
            <div className="text-center">
              <div className="text-fg-secondary text-lg mb-2">未连接</div>
              <p className="text-fg-tertiary text-read">
                从侧边栏选择一个连接或使用快速连接来启动会话。
              </p>
            </div>
          </div>
        )}
        {hasSessions && !activeSessionId && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/90 z-10">
            <div className="text-fg-secondary">请选择一个会话</div>
          </div>
        )}
      </div>

      {hasSessions && activeSessionId && activeSession?.status === 'connected' && !isDebugSession(activeSessionId) && (
        <div className="flex flex-col flex-shrink-0">
          <div
            ref={panelRef}
            style={{
              maxHeight: activeTab ? `${panelHeight}px` : '0',
              transition: isResizingPanel
                ? 'none'
                : `max-height ${PANEL_TRANSITION_MS}ms ${PANEL_TRANSITION_EASING}`,
            }}
            className={`overflow-hidden ${
              activeTab ? 'border-t border-edge-subtle' : ''
            }`}
          >
            <div
              className="h-1 cursor-row-resize hover:bg-indigo-500/50 transition-colors flex-shrink-0"
              onMouseDown={handlePanelResizeMouseDown}
              style={{ touchAction: 'none' }}
            />
            <div
              className="bg-surface"
              style={{ height: `${panelHeight - 4}px` }}
            >
              {displayTab === 'quick-command' && (
                <QuickCommandPanel sessionId={activeSessionId} sessionKey={activeSession.configId} />
              )}
              {displayTab === 'process' && (
                <ProcessPanel sessionId={activeSessionId} />
              )}
              {displayTab === 'network' && (
                <NetworkPanel sessionId={activeSessionId} />
              )}
              {displayTab === 'port-forward' && (
                <PortForwardPanel sessionId={activeSessionId} />
              )}
              {displayTab === 'file-manager' && (
                <FileManagerPanel
                  key={activeSessionId}
                  sessionId={activeSessionId}
                  connectionKey={activeSession.configId ?? activeSession.connectionId}
                />
              )}
              {activePluginView && activeTab === `plugin:${activePluginView.id}` && (
                <PluginWebviewSlot key={`${activePluginView.id}-${pluginRefreshKey}`} provider={activePluginView} />
              )}
            </div>
          </div>
          <BottomTabBar activeTab={activeTab} onTabChange={setActiveTab} tabs={allTabs} />
        </div>
      )}

      {/* Paste confirmation dialog for multi-line content */}
      {pasteConfirm && (
        <PasteConfirmDialog
          text={pasteConfirm.text}
          sessionId={pasteConfirm.sessionId}
          onConfirm={(sessionId, text) => {
            sshSendInput(sessionId, text).catch((err) => {
              console.error('Failed to paste from clipboard:', err);
            });
            terminalInstanceManager.setPasteConfirm(null);
          }}
          onCancel={() => terminalInstanceManager.setPasteConfirm(null)}
        />
      )}
    </div>
  );
}
