import { create } from 'zustand';
import * as tauri from '@/lib/tauri';
import type { AppSettings, AgentModeSettings, LlmConfig } from '@/lib/types';

const DEFAULT_AGENT_MODE_SETTINGS: AgentModeSettings = {
  listMode: 'denylist',
  commandList: ['rm', 'mkfs', 'dd', 'shutdown', 'reboot'],
  confirmEachCommand: true,
};

const DEFAULT_LLM_CONFIG: LlmConfig = {
  providerType: 'openai',
  apiKey: '',
  model: '',
  baseUrl: '',
  maxTokens: 4096,
  temperature: 0.1,
  allowInvalidCerts: false,
};

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: 'JetBrains Mono, Fira Code, Consolas, "Microsoft YaHei", monospace',
  defaultAgentMode: 'agent',
  llmConfig: DEFAULT_LLM_CONFIG,
  agentModeSettings: DEFAULT_AGENT_MODE_SETTINGS,
};

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;

  /** Load settings from disk on app startup. Idempotent. */
  load: () => Promise<void>;
  /** Persist a full settings object and update local state. */
  save: (settings: AppSettings) => Promise<void>;
  /** Patch a subset of fields, persist, and update local state. */
  update: (patch: Partial<AppSettings>) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const fromDisk = await tauri.getSettings();
      // Backwards compat: ensure agentModeSettings always present
      const merged: AppSettings = {
        ...DEFAULT_SETTINGS,
        ...fromDisk,
        agentModeSettings: fromDisk.agentModeSettings ?? DEFAULT_AGENT_MODE_SETTINGS,
        llmConfig: fromDisk.llmConfig ?? DEFAULT_LLM_CONFIG,
      };
      set({ settings: merged, loaded: true });
    } catch (err) {
      console.error('加载设置失败:', err);
      set({ loaded: true });
    }
  },

  save: async (settings: AppSettings) => {
    await tauri.saveSettings(settings);
    set({ settings });
  },

  update: async (patch: Partial<AppSettings>) => {
    const next = { ...get().settings, ...patch };
    await tauri.saveSettings(next);
    set({ settings: next });
  },
}));
