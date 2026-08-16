import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { sshSendInput, sshResize } from '@/lib/tauri';
import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import { openExternalLink } from '@/lib/externalLinks';
import { useSettingsStore } from '@/stores/settingsStore';
import { attachClickLocate } from './terminalClickLocate';

export interface TerminalInstance {
  id: string;
  terminal: XTerm;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  lastResize?: { cols: number; rows: number };
  unlistenOutput?: UnlistenFn;
  onDataDisposable?: { dispose: () => void };
  webglAddon?: WebglAddon;
  webglContextLossDisposable?: { dispose: () => void };
  domListeners: Array<() => void>;
  /** Prevents duplicate disconnect banners for the same session lifecycle. */
  disconnectBannerShown?: boolean;
}

export type PasteConfirmCallback = (text: string, sessionId: string) => void;
export type CopyCallback = (terminal: XTerm) => void;
export type PasteConfirmState = { text: string; sessionId: string } | null;
export type PasteConfirmListener = (confirm: PasteConfirmState) => void;

class TerminalInstanceManager {
  private instances = new Map<string, TerminalInstance>();
  private copyCallback: CopyCallback | null = null;
  private pasteConfirm: PasteConfirmState = null;
  private pasteConfirmListeners: PasteConfirmListener[] = [];

  setCopyCallback(callback: CopyCallback | null) {
    this.copyCallback = callback;
  }

  getPasteConfirm(): PasteConfirmState {
    return this.pasteConfirm;
  }

  setPasteConfirm(confirm: PasteConfirmState) {
    this.pasteConfirm = confirm;
    for (const listener of this.pasteConfirmListeners) {
      listener(confirm);
    }
  }

  onPasteConfirmChange(listener: PasteConfirmListener): () => void {
    this.pasteConfirmListeners.push(listener);
    return () => {
      const index = this.pasteConfirmListeners.indexOf(listener);
      if (index >= 0) {
        this.pasteConfirmListeners.splice(index, 1);
      }
    };
  }

  create(sessionId: string): TerminalInstance {
    const container = document.createElement('div');
    container.className = 'absolute inset-0 p-1 cursor-text';
    container.style.display = 'none';

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

    // WebGL renderer (GPU); fall back to Canvas 2D if context unavailable.
    try {
      const webglAddon = new WebglAddon();
      terminal.loadAddon(webglAddon);
      instance.webglAddon = webglAddon;
      instance.webglContextLossDisposable = webglAddon.onContextLoss(() => {
        try {
          webglAddon.dispose();
        } catch {
          // already disposed
        }
        instance.webglAddon = undefined;
        instance.webglContextLossDisposable = undefined;
      });
    } catch (err) {
      console.warn('WebGL terminal renderer unavailable, using Canvas 2D:', err);
    }

    // SSH input
    const onDataDisposable = terminal.onData((data: string) => {
      sshSendInput(sessionId, data).catch((err) => {
        console.error('Failed to send input:', err);
      });
    });
    instance.onDataDisposable = onDataDisposable;

    // Windows Ctrl+C copy (only intercept when selection exists, otherwise pass through to SSH)
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
          this.copyCallback?.(terminal);
          return false;
        }
      }
      return true;
    });

    // Right-click paste
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      readText()
        .then((text) => {
          if (!text) return;
          if (text.includes('\n') || text.includes('\r')) {
            this.setPasteConfirm({ text, sessionId });
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

    // SSH output listener
    void (async () => {
      const unlistenOutput = await listen<string>(`ssh://output/${sessionId}`, (event) => {
        terminal.write(event.payload);
      });
      instance.unlistenOutput = unlistenOutput;
    })();

    // Focus on click
    const handleClick = () => terminal.focus();
    container.addEventListener('mousedown', handleClick);
    instance.domListeners.push(() =>
      container.removeEventListener('mousedown', handleClick),
    );

    // Click-to-locate: same semantics as the mobile tap — move the remote
    // shell cursor to the clicked cell when it is on the cursor's screen row.
    // Skipped when the app enabled mouse tracking (vim/htop/tmux handle the
    // click via xterm's mouse protocol) and for drags (text selection).
    const clickLocate = attachClickLocate({
      container,
      getTerminal: () => terminal,
      onLocate: (seq) => {
        sshSendInput(sessionId, seq).catch((err) => {
          console.error('Failed to send input:', err);
        });
      },
    });
    instance.domListeners.push(() => clickLocate.dispose());

    this.instances.set(sessionId, instance);
    return instance;
  }

  get(sessionId: string): TerminalInstance | undefined {
    return this.instances.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.instances.has(sessionId);
  }

  attach(sessionId: string, wrapper: HTMLDivElement) {
    const instance = this.instances.get(sessionId);
    if (!instance) return;
    if (instance.container.parentElement !== wrapper) {
      wrapper.appendChild(instance.container);
    }
  }

  detach(sessionId: string) {
    const instance = this.instances.get(sessionId);
    if (!instance) return;
    instance.container.style.display = 'none';
    if (instance.container.parentElement) {
      instance.container.parentElement.removeChild(instance.container);
    }
  }

  setVisible(sessionId: string, visible: boolean) {
    const instance = this.instances.get(sessionId);
    if (!instance) return;
    instance.container.style.display = visible ? 'block' : 'none';
  }

  resizeRemoteIfChanged(instance: TerminalInstance) {
    const cols = instance.terminal.cols;
    const rows = instance.terminal.rows;
    if (instance.lastResize?.cols === cols && instance.lastResize?.rows === rows) return;
    instance.lastResize = { cols, rows };
    sshResize(instance.id, cols, rows).catch(() => {});
  }

  destroy(sessionId: string) {
    const instance = this.instances.get(sessionId);
    if (!instance) return;

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
    if (instance.webglContextLossDisposable) {
      try {
        instance.webglContextLossDisposable.dispose();
      } catch {
        // ignore
      }
    }
    if (instance.webglAddon) {
      try {
        instance.webglAddon.dispose();
      } catch {
        // ignore
      }
    }
    instance.terminal.dispose();
    instance.container.remove();

    this.instances.delete(sessionId);
  }

  destroyAll() {
    for (const sessionId of this.instances.keys()) {
      this.destroy(sessionId);
    }
  }

  getAll(): IterableIterator<[string, TerminalInstance]> {
    return this.instances.entries();
  }

  getIds(): string[] {
    return Array.from(this.instances.keys());
  }

  /** Write local (non-SSH) text into the terminal. No-op if instance is gone. */
  writeLocal(sessionId: string, text: string) {
    const instance = this.instances.get(sessionId);
    if (!instance) return;
    try {
      instance.terminal.write(text);
    } catch {
      // Instance may be mid-dispose
    }
  }

  setStdinEnabled(sessionId: string, enabled: boolean) {
    const instance = this.instances.get(sessionId);
    if (!instance) return;
    try {
      instance.terminal.options.disableStdin = !enabled;
    } catch {
      // Instance may be mid-dispose
    }
  }

  /**
   * Append a disconnect/error banner once per disconnect cycle, and disable input.
   * Safe when the xterm instance is already destroyed (no-op).
   */
  showDisconnectBanner(
    sessionId: string,
    kind: 'disconnected' | 'error' | 'manual',
    detail: string,
  ) {
    const instance = this.instances.get(sessionId);
    if (!instance) return;
    if (instance.disconnectBannerShown) {
      this.setStdinEnabled(sessionId, false);
      return;
    }
    instance.disconnectBannerShown = true;
    this.setStdinEnabled(sessionId, false);

    const title =
      kind === 'error'
        ? '--- 连接失败 ---'
        : kind === 'manual'
          ? '--- 已断开连接 ---'
          : '--- 连接已断开 ---';
    const safeDetail = detail.trim() || (kind === 'error' ? '未知错误' : '连接已关闭');
    // Red title + gray detail, looks like terminal output
    const banner =
      `\r\n\x1b[31m${title}\x1b[0m\r\n` +
      `\x1b[90m详细信息：${safeDetail}\x1b[0m\r\n` +
      `\x1b[90m若您想要尝试重新连接，请点击 SSH 会话标签上的重试按钮\x1b[0m\r\n`;
    this.writeLocal(sessionId, banner);
  }

  /**
   * Enter reconnecting: keep stdin off, allow a new banner if reconnect fails.
   * Does not write any text (history stays intact).
   */
  prepareReconnect(sessionId: string) {
    const instance = this.instances.get(sessionId);
    if (!instance) return;
    instance.disconnectBannerShown = false;
    this.setStdinEnabled(sessionId, false);
  }

  /** Clear banner flag and re-enable stdin after a successful reconnect. */
  onReconnected(sessionId: string) {
    const instance = this.instances.get(sessionId);
    if (!instance) return;
    instance.disconnectBannerShown = false;
    this.setStdinEnabled(sessionId, true);
  }
}

export const terminalInstanceManager = new TerminalInstanceManager();
