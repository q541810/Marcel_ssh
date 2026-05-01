import { useEffect, useRef, useCallback, useState, type RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { sshSendInput, sshResize } from '@/lib/tauri';
import { TERMINAL_THEMES } from '@/lib/constants';
import { useSettingsStore } from '@/stores/settingsStore';

export function useTerminal(
  containerRef: RefObject<HTMLDivElement | null>,
  sessionId: string | null,
) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isReady, setIsReady] = useState(false);
  // Expose terminal instance via state so consumers get reactive updates
  const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null);

  // Live-bound settings — re-renders this hook when user changes font/theme
  const fontSize = useSettingsStore((s) => s.settings.fontSize);
  const fontFamily = useSettingsStore((s) => s.settings.fontFamily);
  const theme = useSettingsStore((s) => s.settings.theme);

  // Initialize terminal
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Read latest settings synchronously at construction time. Subsequent
    // changes are applied via a separate effect below (no remount needed).
    const initialFontSize = useSettingsStore.getState().settings.fontSize;
    const initialFontFamily = useSettingsStore.getState().settings.fontFamily;
    const initialTheme = useSettingsStore.getState().settings.theme;

    const terminal = new Terminal({
      theme: TERMINAL_THEMES[initialTheme as keyof typeof TERMINAL_THEMES] || TERMINAL_THEMES.dark,
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

    // Small delay to ensure DOM is ready before fitting and focusing
    requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();
    });

    // Re-focus terminal whenever the user clicks anywhere in the container.
    // Without this, clicking the terminal area doesn't give it keyboard focus,
    // so typing and shortcuts like Ctrl+C don't reach the SSH session.
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle terminal input -> SSH
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !sessionId) return;

    // Bring focus back when an active session is attached
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

  // Listen for SSH output from Tauri backend
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

  // Handle container resize — also notify backend so the remote PTY resizes
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, sessionId]);

  // Live-apply font and theme changes from settings without recreating the terminal.
  useEffect(() => {
    const term = terminalRef.current;
    if (!term || !isReady) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    term.options.theme = TERMINAL_THEMES[theme as keyof typeof TERMINAL_THEMES] || TERMINAL_THEMES.dark;
    // Re-fit so cols/rows recalculate against the new metrics
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      if (sessionId) {
        sshResize(sessionId, term.cols, term.rows).catch(() => {
          /* ignore — session may have just disconnected */
        });
      }
    });
  }, [fontSize, fontFamily, theme, isReady, sessionId]);

  const fitTerminal = useCallback(() => {
    fitAddonRef.current?.fit();
  }, []);

  return {
    terminal: terminalInstance,
    isReady,
    fitTerminal,
  };
}
