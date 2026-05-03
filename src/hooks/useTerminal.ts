import { useEffect, useRef, useCallback, useState, type RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { sshSendInput, sshResize } from '@/lib/tauri';
import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import { useSettingsStore } from '@/stores/settingsStore';
import type { TerminalColors } from '@/lib/types';

export function useTerminal(
  containerRef: RefObject<HTMLDivElement | null>,
  sessionId: string | null,
) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null);

  const storeSettings = useSettingsStore((s) => s.settings);
  const preview = useSettingsStore((s) => s.preview);
  
  const fontSize = preview?.fontSize ?? storeSettings.fontSize;
  const fontFamily = preview?.fontFamily ?? storeSettings.fontFamily;
  const terminalColors = preview?.terminalColors ?? storeSettings.terminalColors ?? DEFAULT_TERMINAL_COLORS;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initialFontSize = useSettingsStore.getState().settings.fontSize;
    const initialFontFamily = useSettingsStore.getState().settings.fontFamily;
    const initialColors = useSettingsStore.getState().settings.terminalColors ?? DEFAULT_TERMINAL_COLORS;

    const terminal = new Terminal({
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

    requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();
    });

    const handleContainerClick = () => {
      terminal.focus();
    };
    container.addEventListener('mousedown', handleContainerClick);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setTerminalInstance(terminal);
    setIsReady(true);

    return () => {
      setIsReady(false);
      setTerminalInstance(null);
      container.removeEventListener('mousedown', handleContainerClick);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !sessionId) return;

    terminal.focus();

    const disposable = terminal.onData((data: string) => {
      sshSendInput(sessionId, data).catch((err) => {
        console.error('Failed to send input:', err);
      });
    });

    return () => {
      disposable.dispose();
    };
  }, [sessionId, isReady]);

  useEffect(() => {
    if (!sessionId || !isReady) return;

    let unlisten: UnlistenFn | null = null;

    const setupListener = async () => {
      unlisten = await listen<string>(`ssh://output/${sessionId}`, (event) => {
        terminalRef.current?.write(event.payload);
      });
    };

    setupListener();

    return () => {
      unlisten?.();
    };
  }, [sessionId, isReady]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isReady) return;

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        const term = terminalRef.current;
        if (term && sessionId) {
          sshResize(sessionId, term.cols, term.rows).catch((err) => {
            console.warn('Failed to resize remote PTY:', err);
          });
        }
      });
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [isReady, sessionId]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term || !isReady) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    term.options.theme = terminalColors;
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      if (sessionId) {
        sshResize(sessionId, term.cols, term.rows).catch(() => {
        });
      }
    });
  }, [fontSize, fontFamily, terminalColors, isReady, sessionId]);

  const fitTerminal = useCallback(() => {
    fitAddonRef.current?.fit();
  }, []);

  return {
    terminal: terminalInstance,
    isReady,
    fitTerminal,
  };
}
