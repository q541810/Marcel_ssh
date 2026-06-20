import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { sshSendInput, sshResize } from '@/lib/tauri';
import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import { openExternalLink } from '@/lib/externalLinks';
import { useSettingsStore } from '@/stores/settingsStore';

export interface TerminalInstance {
  id: string;
  terminal: XTerm;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  lastResize?: { cols: number; rows: number };
  unlistenOutput?: UnlistenFn;
  onDataDisposable?: { dispose: () => void };
  domListeners: Array<() => void>;
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
}

export const terminalInstanceManager = new TerminalInstanceManager();
