import { create } from 'zustand';
import * as tauri from '@/lib/tauri';
import type { AppSettings, AgentModeSettings, LlmConfig, ExperimentalSettings, NotificationSettings, MobileNotificationSettings, MobileBackgroundSettings } from '@/lib/types';
import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import { DEFAULT_WORKSPACE_LAYOUT, normalizeWorkspaceLayout } from '@/lib/workspaceLayout';
import { setNotificationVolume } from '@/lib/notificationSound';

const DEFAULT_AGENT_MODE_SETTINGS: AgentModeSettings = {
  listMode: 'denylist',
  commandList: ['rm', 'mkfs', 'dd', 'shutdown', 'reboot'],
  confirmEachCommand: true,
  enableModelCommandApproval: false,
  modelApprovalModel: '',
  modelApprovalPrompt: '',
  systemPrompt: '',
  maxToolRounds: 80,
  compactContext: false,
  confirmEditFile: true,
};

const DEFAULT_LLM_CONFIG: LlmConfig = {
  providerType: 'openai',
  apiKey: '',
  model: '',
  baseUrl: '',
  temperature: 0.1,
  maxRetries: 1,
  retryDelaySecs: 5,
  retryHttpStatuses: '408, 429, 500-599',
  vision: false,
  extraBody: null,
};

const DEFAULT_EXPERIMENTAL_SETTINGS: ExperimentalSettings = {
  enableWebSearch: true,
  enableHttpFetch: true,
  enableCloudPage: false,
  webSearchMode: 'browser',
  webSearchApiProvider: 'brave',
  httpFetchMode: 'browser',
};



export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  agentApproval: true,
  agentQuestion: true,
  agentTaskDone: true,
  agentTaskFailed: true,
  notificationVolume: 70,
};

export const DEFAULT_MOBILE_NOTIFICATION_SETTINGS: MobileNotificationSettings = {
  agentApproval: true,
  agentQuestion: true,
  agentTaskDone: true,
  agentTaskFailed: true,
};

export const DEFAULT_MOBILE_BACKGROUND_SETTINGS: MobileBackgroundSettings = {
  keepAliveEnabled: false,
};

const DEFAULT_SETTINGS: AppSettings = {
  terminalColors: DEFAULT_TERMINAL_COLORS,
  fontSize: 14,
  fontFamily: 'JetBrains Mono, Fira Code, Consolas, "Microsoft YaHei", monospace',
  defaultAgentMode: 'agent',
  llmConfig: DEFAULT_LLM_CONFIG,
  agentModeSettings: DEFAULT_AGENT_MODE_SETTINGS,
  experimentalSettings: DEFAULT_EXPERIMENTAL_SETTINGS,
  fileManagerShowHidden: false,
  fileManagerPath: '/',
  fileManagerPaths: {},
  fileManagerTreeWidth: 200,
  fileManagerTreeUserHidden: false,
  folderUploadCompressionLevel: 6,
  panelHeight: 256,
  hideThinkingDisplay: false,
  privacyMode: false,
  notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
  mobileNotificationSettings: DEFAULT_MOBILE_NOTIFICATION_SETTINGS,
  mobileBackgroundSettings: DEFAULT_MOBILE_BACKGROUND_SETTINGS,
  workspaceLayout: DEFAULT_WORKSPACE_LAYOUT,
  customProtectedPaths: [],
  commandTimeoutSecs: 120,
  hasCompletedOnboarding: false,
  hasAcceptedSyncDisclaimer: false,
  disabledPlugins: [],
  authorizedCapabilities: {},
  disableAllInjections: false,
};

interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  /** True if a key is currently stored in the system keychain. */
  hasApiKey: boolean;
  /** True if a web search API key is stored in the system keychain. */
  hasWebSearchApiKey: boolean;
  /** Non-fatal warning from the backend (e.g. settings.json was backed up). */
  warning: string | null;

  /** Load settings from disk on app startup. Idempotent unless forced. */
  load: (force?: boolean) => Promise<void>;
  /** Persist a full settings object and update local state. */
  save: (settings: AppSettings) => Promise<void>;
  /** Patch a subset of fields, persist, and update local state. */
  update: (patch: Partial<AppSettings>) => Promise<void>;
  /** Acknowledge / dismiss a backend warning. */
  clearWarning: () => void;
  /** Preview settings for live updates (not persisted until save) */
  preview: Partial<AppSettings> | null;
  /** Update preview settings for live preview */
  setPreview: (preview: Partial<AppSettings>) => void;
  /** Clear preview settings */
  clearPreview: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  hasApiKey: false,
  hasWebSearchApiKey: false,
  warning: null,
  preview: null,

  load: async (force = false) => {
    if (get().loaded && !force) return;
    try {
      const resp = await tauri.getSettings();
      const fromDisk = resp.settings;
      const merged: AppSettings = {
        ...DEFAULT_SETTINGS,
        ...fromDisk,
        terminalColors: fromDisk.terminalColors ?? DEFAULT_TERMINAL_COLORS,
        agentModeSettings: fromDisk.agentModeSettings ?? DEFAULT_AGENT_MODE_SETTINGS,
        llmConfig: fromDisk.llmConfig ?? DEFAULT_LLM_CONFIG,
        experimentalSettings: {
          ...DEFAULT_EXPERIMENTAL_SETTINGS,
          ...(fromDisk.experimentalSettings ?? {}),
        },
        fileManagerPaths: fromDisk.fileManagerPaths ?? {},
        workspaceLayout: normalizeWorkspaceLayout(fromDisk.workspaceLayout),
        // 移动端独立设置：旧数据无此字段时用默认值兜底（兼容旧数据 = 保持原样 + 默认值填充）
        mobileNotificationSettings: {
          ...DEFAULT_MOBILE_NOTIFICATION_SETTINGS,
          ...(fromDisk.mobileNotificationSettings ?? {}),
        },
        mobileBackgroundSettings: {
          ...DEFAULT_MOBILE_BACKGROUND_SETTINGS,
          ...(fromDisk.mobileBackgroundSettings ?? {}),
        },
      };
      set({
        settings: merged,
        loaded: true,
        hasApiKey: resp.hasApiKey,
        hasWebSearchApiKey: resp.hasWebSearchApiKey ?? false,
        warning: resp.warning ?? null,
      });
      setNotificationVolume(merged.notificationSettings?.notificationVolume ?? 70);
    } catch (err) {
      console.error('加载设置失败:', err);
      set({ loaded: false });
      throw err;
    }
  },

  save: async (settings: AppSettings) => {
    if (!get().loaded) {
      console.warn('[settingsStore] save() blocked — settings not loaded yet');
      return;
    }
    await tauri.saveSettings(settings);
    set({ settings, preview: null });
  },

  update: async (patch: Partial<AppSettings>) => {
    if (!get().loaded) {
      console.warn('[settingsStore] update() blocked — settings not loaded yet');
      return;
    }
    const next = { ...get().settings, ...patch };
    await tauri.saveSettings(next);
    set({ settings: next, preview: null });
  },

  setPreview: (preview: Partial<AppSettings>) => {
    set({ preview });
  },

  clearWarning: () => {
    set({ warning: null });
  },

  clearPreview: () => {
    set({ preview: null });
  },
}));
