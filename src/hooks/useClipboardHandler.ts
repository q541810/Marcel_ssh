import { useCallback } from 'react';
import type { Terminal } from '@xterm/xterm';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';

export function useClipboardHandler() {
  const handleCopy = useCallback(async (terminal: Terminal) => {
    if (terminal.hasSelection()) {
      const text = terminal.getSelection();
      try {
        await writeText(text);
        terminal.clearSelection();
      } catch {
        // ignore
      }
    }
  }, []);

  const handlePaste = useCallback(async (terminal: Terminal) => {
    try {
      const text = await readText();
      terminal.paste(text);
    } catch {
      // ignore
    }
  }, []);

  return { handleCopy, handlePaste };
}
