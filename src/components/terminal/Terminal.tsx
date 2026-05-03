import { useRef, useEffect, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { sshSendInput, sshResize } from '@/lib/tauri';
import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { TerminalColors } from '@/lib/types';

interface TerminalInstance {
  id: string;
  terminal: XTerm;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  unlistenOutput?: UnlistenFn;
}

export default function Terminal() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const terminalsRef = useRef<Map<string, TerminalInstance>>(new Map());
  const [activeInstanceId, setActiveInstanceId] = useState<string | null>(null);

  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const storeSettings = useSettingsStore((s) => s.settings);
  const preview = useSettingsStore((s) => s.preview);

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

    // Handle input
    const disposable = terminal.onData((data: string) => {
      sshSendInput(sessionId, data).catch((err) => {
        console.error('Failed to send input:', err);
      });
    });

    // Handle output
    let unlistenOutput: UnlistenFn | null = null;
    const setupListener = async () => {
      unlistenOutput = await listen<string>(`ssh://output/${sessionId}`, (event) => {
        terminal.write(event.payload);
      });
    };
    setupListener();

    // Focus on click
    const handleClick = () => terminal.focus();
    container.addEventListener('mousedown', handleClick);

    requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();
    });

    const instance: TerminalInstance = {
      id: sessionId,
      terminal,
      fitAddon,
      container,
      unlistenOutput: undefined,
    };

    // Store unlisten function when ready
    setupListener().then(() => {
      instance.unlistenOutput = unlistenOutput ?? undefined;
    });

    return instance;
  };

  // Cleanup terminal instance
  const cleanupTerminal = (instance: TerminalInstance) => {
    instance.terminal.dispose();
    instance.container.remove();
    if (instance.unlistenOutput) {
      instance.unlistenOutput();
    }
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
    <div className="relative flex-1 h-full bg-zinc-900">
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
  );
}
