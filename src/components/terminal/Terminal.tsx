import { useRef, useEffect, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { sshSendInput, sshResize } from '@/lib/tauri';
import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import QuickCommandPanel from './QuickCommandPanel';
import BottomTabBar from './BottomTabBar';
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

/**
 * 在终端容器内以 toast 形式展示短暂的错误提示。
 */
const showClipboardError = (message: string) => {
  const toast = document.createElement('div');
  toast.className =
    'fixed bottom-8 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-red-900/90 text-red-200 text-sm border border-red-700/60 shadow-lg pointer-events-none transition-opacity duration-300';
  toast.textContent = message;
  document.body.appendChild(toast);

  const fadeOut = () => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  };

  setTimeout(fadeOut, 2500);
};

/**
 * Windows 风格的终端剪贴板快捷键处理器。
 *
 * 行为:
 *  - Ctrl+C 有选区: 复制选中文本到系统剪贴板, 不将 \x03 发送到 SSH。
 *  - Ctrl+C 无选区: 交由 xterm.js 默认处理 (发送 SIGINT 到远端)。
 *
 * 返回 false 告知 xterm.js 忽略该按键事件。
 */
const createCopyOnSelectionHandler = (terminal: XTerm) => {
  return (event: KeyboardEvent): boolean => {
    if (
      event.type === 'keydown' &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      (event.key === 'c' || event.key === 'C')
    ) {
      const selection = terminal.getSelection();
      if (selection.length > 0) {
        const container = terminal.element;
        void writeText(selection).catch((err) => {
          console.error('Failed to write clipboard:', err);
          if (container) {
            showClipboardError('复制失败，请重试');
          }
        });
        terminal.clearSelection();
        return false;
      }
    }
    return true;
  };
};

export default function Terminal() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const terminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);
  const [pasteConfirm, setPasteConfirm] = useState<{ text: string; sessionId: string } | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const storeSettings = useSettingsStore((s) => s.settings);
  const preview = useSettingsStore((s) => s.preview);

  const handlePasteConfirm = useCallback(() => {
    if (pasteConfirm) {
      sshSendInput(pasteConfirm.sessionId, pasteConfirm.text).catch((err) => {
        console.error('Failed to paste from clipboard:', err);
        showClipboardError('粘贴失败，请重试');
      });
      setPasteConfirm(null);
    }
  }, [pasteConfirm]);

  const handlePasteCancel = useCallback(() => {
    setPasteConfirm(null);
  }, []);

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
    terminal.attachCustomKeyEventHandler(createCopyOnSelectionHandler(terminal));

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
          showClipboardError('粘贴失败，请重试');
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
              maxHeight: activeTab === 'quick-command' ? '16rem' : '0',
              transition: 'max-height 200ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
            className={`overflow-hidden ${
              activeTab === 'quick-command' ? 'border-t border-zinc-800' : ''
            }`}
          >
            <div className="h-64 bg-zinc-900">
              <QuickCommandPanel sessionId={activeSessionId} sessionKey={activeSession.configId} />
            </div>
          </div>
          <BottomTabBar activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      )}

      {/* Paste confirmation dialog for multi-line content */}
      {pasteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-lg mx-4 rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl">
            {/* Header with warning */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                <h2 className="text-lg font-semibold text-amber-300">安全提示</h2>
              </div>
              <button
                onClick={handlePasteCancel}
                className="text-zinc-400 hover:text-zinc-200 text-xl leading-none"
                aria-label="关闭"
              >
                &times;
              </button>
            </div>

            {/* Warning message */}
            <div className="px-4 pt-3 pb-2">
              <p className="text-sm text-zinc-200 font-medium">
                您粘贴的内容中含有回车，可能会意外执行某些命令。
              </p>
            </div>

            {/* Content preview */}
            <div className="px-4 pb-3">
              <pre className="p-3 rounded-lg bg-zinc-900 text-xs text-zinc-300 overflow-auto max-h-48 whitespace-pre-wrap break-all">
                {pasteConfirm.text}
              </pre>
            </div>

            {/* Action buttons */}
            <div className="flex justify-end gap-2 px-4 pb-4 border-t border-zinc-700 pt-3">
              <button
                onClick={handlePasteCancel}
                className="px-4 py-1.5 rounded-lg text-sm text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handlePasteConfirm}
                className="px-4 py-1.5 rounded-lg text-sm text-white bg-indigo-600 hover:bg-indigo-500 transition-colors"
              >
                确认粘贴
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
