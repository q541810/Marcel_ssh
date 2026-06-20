import { useRef, useEffect, useState } from 'react';
import { sshSendInput } from '@/lib/tauri';
import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import QuickCommandPanel from './QuickCommandPanel';
import ProcessPanel from './ProcessPanel';
import FileManagerPanel from '../sftp/FileManagerPanel';
import BottomTabBar from './BottomTabBar';
import PasteConfirmDialog from './PasteConfirmDialog';
import { useClipboardHandler } from '@/hooks/useClipboardHandler';
import { useTerminalBottomPanel } from './useTerminalBottomPanel';
import { terminalInstanceManager } from './TerminalInstanceManager';

export default function Terminal() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [pasteConfirm, setPasteConfirm] = useState(() => terminalInstanceManager.getPasteConfirm());
  const fitFrameRef = useRef<number | null>(null);
  const activeInstanceIdRef = useRef<string | null>(null);
  const lastWrapperSizeRef = useRef<{ width: number; height: number } | null>(null);

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

  const fontSize = preview?.fontSize ?? storeSettings.fontSize;
  const fontFamily = preview?.fontFamily ?? storeSettings.fontFamily;
  const terminalColors = preview?.terminalColors ?? storeSettings.terminalColors ?? DEFAULT_TERMINAL_COLORS;

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
    if (fitFrameRef.current !== null) return;
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      const instanceId = activeInstanceIdRef.current;
      if (!instanceId) return;
      const instance = terminalInstanceManager.get(instanceId);
      if (!instance) return;
      instance.fitAddon.fit();
      terminalInstanceManager.resizeRemoteIfChanged(instance);
    });
  };

  // Sync terminals with sessions
  useEffect(() => {
    const currentIds = new Set(Object.keys(sessions));

    // Create new terminals for new sessions
    for (const sessionId of currentIds) {
      if (!terminalInstanceManager.has(sessionId)) {
        terminalInstanceManager.create(sessionId);
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
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
    };
  }, []);

  // Apply settings changes
  useEffect(() => {
    for (const [, instance] of terminalInstanceManager.getAll()) {
      instance.terminal.options.fontSize = fontSize;
      instance.terminal.options.fontFamily = fontFamily;
      instance.terminal.options.theme = terminalColors;
      requestAnimationFrame(() => {
        instance.fitAddon.fit();
        if (instance.id === activeInstanceId) {
          terminalInstanceManager.resizeRemoteIfChanged(instance);
        }
      });
    }
  }, [fontSize, fontFamily, terminalColors, activeInstanceId]);

  const hasSessions = Object.keys(sessions).length > 0;

  return (
    <div ref={terminalRootRef} className="flex flex-col flex-1 h-full bg-zinc-900">
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
        {activeSession?.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/95 z-10 pointer-events-none px-6">
            <div className="w-full max-w-2xl rounded-2xl border border-red-500/25 bg-red-500/10 p-5 shadow-2xl shadow-red-950/20 pointer-events-auto">
              <div className="mb-2 text-lg font-medium text-red-200">连接失败</div>
              <div className="mb-3 text-sm text-zinc-400">
                {activeSession.connectionId}
              </div>
              <div className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-red-500/20 bg-zinc-950/50 p-3 font-mono text-xs leading-relaxed text-red-100 [overflow-wrap:anywhere]">
                {activeSession.errorMessage ?? '未知错误'}
              </div>
              <div className="mt-3 text-xs text-zinc-500">
                请检查主机、端口、网络和认证信息后重新连接。
              </div>
            </div>
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
            <div className="bg-zinc-900" style={{ height: `${panelHeight - 4}px` }}>
              {displayTab === 'quick-command' && (
                <QuickCommandPanel sessionId={activeSessionId} sessionKey={activeSession.configId} />
              )}
              {displayTab === 'process' && (
                <ProcessPanel sessionId={activeSessionId} />
              )}
              {displayTab === 'file-manager' && (
                <FileManagerPanel
                  key={activeSessionId}
                  sessionId={activeSessionId}
                  connectionKey={activeSession.configId ?? activeSession.connectionId}
                />
              )}
            </div>
          </div>
          <BottomTabBar activeTab={activeTab} onTabChange={setActiveTab} />
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
