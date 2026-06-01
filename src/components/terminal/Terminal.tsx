import { useRef, useEffect, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { sshSendInput, sshResize } from '@/lib/tauri';
import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import QuickCommandPanel from './QuickCommandPanel';
import ProcessPanel from './ProcessPanel';
import FileManagerPanel from '../sftp/FileManagerPanel';
import BottomTabBar from './BottomTabBar';
import PasteConfirmDialog from './PasteConfirmDialog';
import { useClipboardHandler } from '@/hooks/useClipboardHandler';
import type { TerminalColors } from '@/lib/types';

interface TerminalInstance {
  id: string;
  terminal: XTerm;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  unlistenOutput?: UnlistenFn;
  onDataDisposable?: { dispose: () => void };
  domListeners: Array<() => void>;
}

export default function Terminal() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const terminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [pasteConfirm, setPasteConfirm] = useState<{ text: string; sessionId: string } | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [displayTab, setDisplayTab] = useState<string | null>(null);
  const [isResizingPanel, setIsResizingPanel] = useState(false);
  const panelResizeStartRef = useRef<{ y: number; height: number } | null>(null);
  const hasResizedRef = useRef(false);
  const initialSyncDoneRef = useRef(false);

  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const storeSettings = useSettingsStore((s) => s.settings);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const preview = useSettingsStore((s) => s.preview);
  const [panelHeight, setPanelHeight] = useState(storeSettings.panelHeight ?? 256);

  // Sync panelHeight from store after initial load
  useEffect(() => {
    if (!initialSyncDoneRef.current && settingsLoaded) {
      initialSyncDoneRef.current = true;
      setPanelHeight(storeSettings.panelHeight ?? 256);
    }
  }, [settingsLoaded, storeSettings.panelHeight]);

  const { handleCopy } = useClipboardHandler();

  const fontSize = preview?.fontSize ?? storeSettings.fontSize;
  const fontFamily = preview?.fontFamily ?? storeSettings.fontFamily;
  const terminalColors = preview?.terminalColors ?? storeSettings.terminalColors ?? DEFAULT_TERMINAL_COLORS;

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
    const webLinksAddon = new WebLinksAddon();

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
        sshResize(activeSessionId, instance.terminal.cols, instance.terminal.rows).catch(() => {});
      });
    }

    setActiveInstanceId(activeSessionId);
  }, [sessions, activeSessionId]);

  // Handle resize
  useEffect(() => {
    if (!wrapperRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        for (const instance of terminalsRef.current.values()) {
          instance.fitAddon.fit();
          if (instance.id === activeInstanceId) {
            sshResize(instance.id, instance.terminal.cols, instance.terminal.rows).catch(() => {});
          }
        }
      });
    });

    resizeObserver.observe(wrapperRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [activeInstanceId]);

  // Apply settings changes
  useEffect(() => {
    for (const instance of terminalsRef.current.values()) {
      instance.terminal.options.fontSize = fontSize;
      instance.terminal.options.fontFamily = fontFamily;
      instance.terminal.options.theme = terminalColors;
      requestAnimationFrame(() => {
        instance.fitAddon.fit();
        if (instance.id === activeInstanceId) {
          sshResize(instance.id, instance.terminal.cols, instance.terminal.rows).catch(() => {});
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

  // Panel resize handlers
  const handlePanelResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    panelResizeStartRef.current = { y: e.clientY, height: panelHeight };
    setIsResizingPanel(true);
    hasResizedRef.current = true;
  }, [panelHeight]);

  useEffect(() => {
    if (!isResizingPanel) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelResizeStartRef.current) return;
      const delta = panelResizeStartRef.current.y - e.clientY;
      const newHeight = panelResizeStartRef.current.height + delta;
      setPanelHeight(Math.min(500, Math.max(100, newHeight)));
    };

    const handleMouseUp = () => {
      setIsResizingPanel(false);
      panelResizeStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingPanel]);

  // Save panel height when user has manually resized
  useEffect(() => {
    if (!isResizingPanel && panelResizeStartRef.current === null && hasResizedRef.current) {
      useSettingsStore.getState().update({ panelHeight });
    }
  }, [isResizingPanel, panelHeight]);

  // Delay content unmount until animation completes
  useEffect(() => {
    if (activeTab) {
      setDisplayTab(activeTab);
    } else {
      const timer = setTimeout(() => setDisplayTab(null), 200);
      return () => clearTimeout(timer);
    }
  }, [activeTab]);

  const hasSessions = Object.keys(sessions).length > 0;

  return (
    <div className="flex flex-col flex-1 h-full bg-zinc-900">
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
            <div className="bg-zinc-900" style={{ height: `${panelHeight - 4}px` }}>
              {displayTab === 'quick-command' && (
                <QuickCommandPanel sessionId={activeSessionId} sessionKey={activeSession.configId} />
              )}
              {displayTab === 'process' && (
                <ProcessPanel sessionId={activeSessionId} />
              )}
              {displayTab === 'file-manager' && (
                <FileManagerPanel sessionId={activeSessionId} />
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
