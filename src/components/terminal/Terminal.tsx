import { useRef, useEffect, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { sshSendInput, sshResize } from '@/lib/tauri';
import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import { openExternalLink } from '@/lib/externalLinks';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import QuickCommandPanel from './QuickCommandPanel';
import ProcessPanel from './ProcessPanel';
import FileManagerPanel from '../sftp/FileManagerPanel';
import BottomTabBar from './BottomTabBar';
import PasteConfirmDialog from './PasteConfirmDialog';
import { useClipboardHandler } from '@/hooks/useClipboardHandler';
import { useTerminalBottomPanel } from './useTerminalBottomPanel';

interface TerminalInstance {
  id: string;
  terminal: XTerm;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  lastResize?: { cols: number; rows: number };
  unlistenOutput?: UnlistenFn;
  onDataDisposable?: { dispose: () => void };
  domListeners: Array<() => void>;
}

export default function Terminal() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const terminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [pasteConfirm, setPasteConfirm] = useState<{ text: string; sessionId: string } | null>(null);
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

  const resizeRemoteIfChanged = (instance: TerminalInstance) => {
    const cols = instance.terminal.cols;
    const rows = instance.terminal.rows;
    if (instance.lastResize?.cols === cols && instance.lastResize?.rows === rows) return;
    instance.lastResize = { cols, rows };
    sshResize(instance.id, cols, rows).catch(() => {});
  };

  useEffect(() => {
    activeInstanceIdRef.current = activeInstanceId;
  }, [activeInstanceId]);

  const scheduleActiveFit = () => {
    if (fitFrameRef.current !== null) return;
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      const instanceId = activeInstanceIdRef.current;
      if (!instanceId) return;
      const instance = terminalsRef.current.get(instanceId);
      if (!instance) return;
      instance.fitAddon.fit();
      resizeRemoteIfChanged(instance);
    });
  };

  // Create terminal instance for a session
  const createTerminal = (sessionId: string): TerminalInstance => {
    const container = document.createElement('div');
    container.className = 'absolute inset-0 p-1 cursor-text';
    container.style.display = 'none';
    wrapperRef.current?.appendChild(container);

    const initialFontSize = useSettingsStore.getState().settings.fontSize;
    const initialFontFamily = useSettingsStore.getState().settings.fontFamily;
    const initialColors = useSettingsStore.getState().settings.terminalColors ?? DEFAULT_TERMINAL_COLORS;

    const terminal = new XTerm({
      theme: initialColors,
      fontSize: initialFontSize,
      fontFamily: initialFontFamily,
      cursorBlink: true,
      cursorStyle: 'block',
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => openExternalLink(uri));

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(container);

    const instance: TerminalInstance = {
      id: sessionId,
      terminal,
      fitAddon,
      container,
      domListeners: [],
    };

    const onDataDisposable = terminal.onData((data: string) => {
      sshSendInput(sessionId, data).catch((err) => {
        console.error('Failed to send input:', err);
      });
    });
    instance.onDataDisposable = onDataDisposable;

    // Windows 风格 Ctrl+C 复制 (仅在有选区时拦截, 否则透传到 SSH)
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent): boolean => {
      if (
        event.type === 'keydown' &&
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        (event.key === 'c' || event.key === 'C')
      ) {
        if (terminal.hasSelection()) {
          handleCopy(terminal);
          return false;
        }
      }
      return true;
    });

    // 右键粘贴: 从系统剪贴板读取并写入 SSH 输入流
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      readText()
        .then((text) => {
          if (!text) return;
          if (text.includes('\n') || text.includes('\r')) {
            setPasteConfirm({ text, sessionId });
          } else {
            return sshSendInput(sessionId, text);
          }
        })
        .catch((err) => {
          console.error('Failed to paste from clipboard:', err);
        });
    };
    container.addEventListener('contextmenu', handleContextMenu);
    instance.domListeners.push(() =>
      container.removeEventListener('contextmenu', handleContextMenu),
    );

    void (async () => {
      const unlistenOutput = await listen<string>(`ssh://output/${sessionId}`, (event) => {
        terminal.write(event.payload);
      });
      instance.unlistenOutput = unlistenOutput;
    })();

    const handleClick = () => terminal.focus();
    container.addEventListener('mousedown', handleClick);
    instance.domListeners.push(() =>
      container.removeEventListener('mousedown', handleClick),
    );

    requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();
    });

    return instance;
  };

  // Cleanup terminal instance
  const cleanupTerminal = (instance: TerminalInstance) => {
    for (const off of instance.domListeners) {
      try {
        off();
      } catch (err) {
        console.error('Failed to detach listener:', err);
      }
    }
    instance.domListeners.length = 0;
    if (instance.onDataDisposable) {
      instance.onDataDisposable.dispose();
    }
    if (instance.unlistenOutput) {
      instance.unlistenOutput();
    }
    instance.terminal.dispose();
    instance.container.remove();
  };

  // Sync terminals with sessions
  useEffect(() => {
    const currentIds = new Set(Object.keys(sessions));
    const terminals = terminalsRef.current;

    // Create new terminals for new sessions
    for (const sessionId of currentIds) {
      if (!terminals.has(sessionId)) {
        const instance = createTerminal(sessionId);
        terminals.set(sessionId, instance);
      }
    }

    // Remove terminals for closed sessions
    for (const [sessionId, instance] of terminals) {
      if (!currentIds.has(sessionId)) {
        cleanupTerminal(instance);
        terminals.delete(sessionId);
      }
    }

    // Show active terminal, hide others
    for (const [sessionId, instance] of terminals) {
      instance.container.style.display = sessionId === activeSessionId ? 'block' : 'none';
    }

    // Focus active terminal
    if (activeSessionId && terminals.has(activeSessionId)) {
      const instance = terminals.get(activeSessionId)!;
      requestAnimationFrame(() => {
        instance.fitAddon.fit();
        instance.terminal.focus();
        resizeRemoteIfChanged(instance);
      });
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
    for (const instance of terminalsRef.current.values()) {
      instance.terminal.options.fontSize = fontSize;
      instance.terminal.options.fontFamily = fontFamily;
      instance.terminal.options.theme = terminalColors;
      requestAnimationFrame(() => {
        instance.fitAddon.fit();
        if (instance.id === activeInstanceId) {
          resizeRemoteIfChanged(instance);
        }
      });
    }
  }, [fontSize, fontFamily, terminalColors, activeInstanceId]);

  // Cleanup all on unmount
  useEffect(() => {
    return () => {
      for (const instance of terminalsRef.current.values()) {
        cleanupTerminal(instance);
      }
      terminalsRef.current.clear();
    };
  }, []);

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
            setPasteConfirm(null);
          }}
          onCancel={() => setPasteConfirm(null)}
        />
      )}
    </div>
  );
}
