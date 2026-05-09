import { create } from 'zustand';
import type { QuickCommand, QuickCommandInput, QuickCommandPatch } from '@/lib/types';
import * as tauri from '@/lib/tauri';

interface QuickCommandState {
  commands: QuickCommand[];
  loading: boolean;
  error: string | null;
  executingId: string | null;
  lastSessionKey: string | null;
  load: (sessionKey?: string | null) => Promise<void>;
  add: (input: QuickCommandInput) => Promise<void>;
  update: (id: string, patch: QuickCommandPatch) => Promise<void>;
  delete: (id: string) => Promise<void>;
  execute: (command: QuickCommand, sessionId: string) => Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeCommandLine(command: string): string {
  return command.endsWith('\n') || command.endsWith('\r') ? command : `${command}\n`;
}

export const useQuickCommandStore = create<QuickCommandState>((set, get) => ({
  commands: [],
  loading: false,
  error: null,
  executingId: null,
  lastSessionKey: null,

  load: async (sessionKey?: string | null) => {
    set({ loading: true, error: null, lastSessionKey: sessionKey ?? null });
    try {
      const commands = await tauri.quickCommandList(sessionKey ?? null);
      set({ commands, loading: false });
    } catch (err) {
      set({ loading: false, error: String(err) });
      throw err;
    }
  },

  add: async (input: QuickCommandInput) => {
    const created = await tauri.quickCommandAdd(input);
    set((state) => ({ commands: [...state.commands, created], error: null }));
  },

  update: async (id: string, patch: QuickCommandPatch) => {
    await tauri.quickCommandUpdate(id, patch);
    const sessionKey = get().lastSessionKey;
    await get().load(sessionKey);
  },

  delete: async (id: string) => {
    await tauri.quickCommandDelete(id);
    set((state) => ({
      commands: state.commands.filter((cmd) => cmd.id !== id),
      error: null,
    }));
  },

  execute: async (command: QuickCommand, sessionId: string) => {
    if (get().executingId) return;
    const lines = command.commands.map((cmd) => cmd.trim()).filter(Boolean);
    if (lines.length === 0) return;

    set({ executingId: command.id, error: null });
    try {
      for (let i = 0; i < lines.length; i += 1) {
        await tauri.sshSendInput(sessionId, normalizeCommandLine(lines[i]));
        if (i < lines.length - 1 && command.intervalMs > 0) {
          await sleep(command.intervalMs);
        }
      }
    } catch (err) {
      set({ error: String(err) });
      throw err;
    } finally {
      set({ executingId: null });
    }
  },
}));
