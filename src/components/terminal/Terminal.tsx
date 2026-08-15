import { useRef, useEffect, useState, useMemo } from 'react';
import { sshSendInput } from '@/lib/tauri';
import { resolveAppearanceTheme } from '@/lib/appearance';
import { resolveTerminalBackground, resolveTerminalThemeColors } from '@/lib/terminalBackground';
import { BOTTOM_TABS, DEFAULT_TERMINAL_COLORS, type BottomTab } from '@/lib/constants';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useViewStore, byMount } from '@/stores/viewStore';
import QuickCommandPanel from './QuickCommandPanel';
import ProcessPanel from './ProcessPanel';
import NetworkPanel from './NetworkPanel';
import FileManagerPanel from '../sftp/FileManagerPanel';
import BottomTabBar from './BottomTabBar';
import PasteConfirmDialog from './PasteConfirmDialog';
import PluginWebviewSlot from '@/plugins/PluginWebviewSlot';
import { usePluginStore } from '@/stores/pluginStore';
import { useClipboardHandler } from '@/hooks/useClipboardHandler';
import { useTerminalBottomPanel } from './useTerminalBottomPanel';
import { terminalInstanceManager } from './TerminalInstanceManager';

export default function Terminal() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [pasteConfirm, setPasteConfirm] = useState(() => terminalInstanceManager.getPasteConfirm());
  const fitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeInstanceIdRef = useRef<string | null>(null);
  const lastWrapperSizeRef = useRef<{ width: number; height: number } | null>(null);
  /** 侧栏/底栏/窗口尺寸过渡期间高频触发 ResizeObserver，防抖后再 fit，
      避免每帧 re-fit + 反复发 SSH resize 导致的掉帧与终端闪烁 */
  const FIT_DEBOUNCE_MS = 120;

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
  const terminalColors = preview?.terminalColors ?? storeSettings.terminalColors ?? DEFAULT_TERMINAL_COLORS;
  const appearance = preview?.appearance ?? storeSettings.appearance;
  const acrylicOn = appearance?.acrylic ?? true;
  const theme = resolveAppearanceTheme(appearance?.theme ?? 'light');
  const effectiveTerminalColors = useMemo(() => {
    // 未自定义配色时跟随应用主题（浅色主题 -> 亮色终端）
    const themeColors = resolveTerminalThemeColors(terminalColors, theme);
    return resolveTerminalBackground(themeColors, acrylicOn);
  }, [terminalColors, theme, acrylicOn]);

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

  const scheduleActiveFit = () => {
    if (fitTimeoutRef.current !== null) clearTimeout(fitTimeoutRef.current);
    fitTimeoutRef.current = setTimeout(() => {
      fitTimeoutRef.current = null;
      const instanceId = activeInstanceIdRef.current;
      if (!instanceId) return;
      const instance = terminalInstanceManager.get(instanceId);
      if (!instance) return;
      instance.fitAddon.fit();
      terminalInstanceManager.resizeRemoteIfChanged(instance);
    }, FIT_DEBOUNCE_MS);
  };

  // Sync terminals with sessions
  useEffect(() => {
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

    // Focus active terminal
    if (activeSessionId) {
      const instance = terminalInstanceManager.get(activeSessionId);
      if (instance) {
        requestAnimationFrame(() => {
          instance.fitAddon.fit();
          instance.terminal.focus();
          terminalInstanceManager.resizeRemoteIfChanged(instance);
        });
      }
    }

    setActiveInstanceId(activeSessionId);
  }, [sessions, activeSessionId]);

  // Handle resize
  useEffect(() => {
    if (!wrapperRef.current) return;

    const resizeObserver = new ResizeObserver(([entry]) => {
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
      if (fitTimeoutRef.current !== null) {
        clearTimeout(fitTimeoutRef.current);
        fitTimeoutRef.current = null;
      }
    };
  }, []);

  // Apply settings changes
  useEffect(() => {
    for (const [, instance] of terminalInstanceManager.getAll()) {
      instance.terminal.options.fontSize = fontSize;
      instance.terminal.options.fontFamily = fontFamily;
      instance.terminal.options.theme = effectiveTerminalColors;
      requestAnimationFrame(() => {
        instance.fitAddon.fit();
        if (instance.id === activeInstanceId) {
          terminalInstanceManager.resizeRemoteIfChanged(instance);
        }
      });
    }
  }, [fontSize, fontFamily, effectiveTerminalColors, activeInstanceId]);

  const hasSessions = Object.keys(sessions).length > 0;

  return (
    <div
      ref={terminalRootRef}
      data-region="terminal"
      className="flex flex-col flex-1 h-full win-terminal"
    >
      <div className="relative flex-1 min-h-0">
        <div ref={wrapperRef} className="absolute inset-0" />
        {!hasSessions && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/95 z-10">
            <div className="text-center">
              <div className="text-zinc-400 text-lg mb-2">未连接</div>
              <p className="text-zinc-500 text-sm">
                从侧边栏选择一个连接或使用快速连接来启动会话。
              </p>
            </div>
          </div>
        )}
        {hasSessions && !activeSessionId && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/90 z-10">
            <div className="text-zinc-400">请选择一个会话</div>
          </div>
        )}
      </div>

      {hasSessions && activeSessionId && activeSession?.status === 'connected' && (
        <div className="flex flex-col flex-shrink-0">
          <div
            style={{
              maxHeight: activeTab ? `${panelHeight}px` : '0',
              transition: isResizingPanel ? 'none' : 'max-height 200ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
            className={`overflow-hidden ${
              activeTab ? 'border-t border-zinc-800' : ''
            }`}
          >
            <div
              className="h-1 cursor-row-resize hover:bg-indigo-500/50 transition-colors flex-shrink-0"
              onMouseDown={handlePanelResizeMouseDown}
              style={{ touchAction: 'none' }}
            />
            <div
              className="bg-zinc-900"
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
