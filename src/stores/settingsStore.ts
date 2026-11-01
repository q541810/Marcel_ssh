import { create } from 'zustand';
import * as tauri from '@/lib/tauri';
import type { AppSettings, AgentModeSettings, ExperimentalSettings, NotificationSettings, MobileNotificationSettings, MobileBackgroundSettings, MemorySettings, LlmRegistry, ChannelKeyStatus } from '@/lib/types';
import { DEFAULT_TERMINAL_COLORS } from '@/lib/constants';
import { DEFAULT_WORKSPACE_LAYOUT, normalizeWorkspaceLayout } from '@/lib/workspaceLayout';
import { setNotificationVolume } from '@/lib/notificationSound';
import { emptyRegistry, emptySlots, defaultNetPolicy, dedupeModelEntries } from '@/lib/llmRegistry';
import { normalizeUpdateMode } from '@/lib/updateMode';
import { normalizeUiTheme } from '@/lib/uiTheme';
import { defaultCustomRiskRules } from '@/lib/riskRules';
import { deepEqual, threeWayMerge } from '@/lib/settingsMerge';
import { getErrorMessage } from '@/lib/errors';

const DEFAULT_AGENT_MODE_SETTINGS: AgentModeSettings = {
  listMode: 'denylist',
  allowCommands: [],
  confirmEachCommand: true,
  planModeRequiresApproval: false,
  enableModelCommandApproval: false,
  commandApprovalEngine: 'model',
  jevModelId: '',
  jevBaseUrl: '',
  jevApprovalPrompt: '',
  // 默认关：开着会让每条需要人审的命令多打一次请求（延迟与花费都翻倍），
  // 这种成本不能由一次升级替用户决定。
  jevReasonFollowup: false,
  modelApprovalPrompt: '',
  systemPrompt: '',
  maxToolRounds: 500,
  contextWindow: 0,
  // 默认关：Auto 的定义是全自主；打开后只有 ForceApproval 档会弹窗。
  autoModeForceApproval: false,
  toolApprovalLevels: { edit_file: 'Approval', write_file: 'Approval' },
};

const DEFAULT_LLM_REGISTRY: LlmRegistry = emptyRegistry();

/** 归一化注册表：缺字段补默认（兼容旧数据 / 字段缺失 = 保持原样 + 默认填充）。
 *  模型列表按 id 去重（保留最后出现者）：历史「保存渠道」合并 bug 会写出同
 *  id 重复条目，这里在 hydrate/load 时兜底自愈，避免模型选择器出现同模型两次。
 *  全局最近使用（lastUsedModelId）一并保留；指向已删模型的失效值清空
 *  （与后端 resolve 的"失效回落第一个模型"语义一致，也避免 save 被后端
 *  validate 拦下）。 */
function normalizeRegistry(r: Partial<LlmRegistry> | null | undefined): LlmRegistry {
  if (!r) return DEFAULT_LLM_REGISTRY;
  const models = Array.isArray(r.models) ? dedupeModelEntries(r.models) : [];
  // 全局最近使用：须指向真实存在的模型才保留（以 dedupe 后的 models 为准），
  // 否则视为失效清空（undefined = 回落第一个模型，语义与 emptyRegistry 一致）
  const lastUsedModelId =
    typeof r.lastUsedModelId === 'string' &&
    r.lastUsedModelId.trim() !== '' &&
    models.some((m) => m.id === r.lastUsedModelId)
      ? r.lastUsedModelId
      : undefined;
  return {
    channels: Array.isArray(r.channels) ? r.channels : [],
    models,
    slots: r.slots ? { ...emptySlots(), ...r.slots } : emptySlots(),
    // 子agent 候选清单：缺字段补空数组（兼容旧数据），丢掉非对象/无 id 的脏
    // 条目；description 归一为字符串（手改配置缺该键时受控 input 不吃 undefined）
    subagentModels: Array.isArray(r.subagentModels)
      ? r.subagentModels
          .filter((c) => c && typeof c.modelId === 'string')
          .map((c) => ({
            modelId: c.modelId,
            description: typeof c.description === 'string' ? c.description : '',
          }))
      : [],
    netPolicy: r.netPolicy ? { ...defaultNetPolicy(), ...r.netPolicy } : defaultNetPolicy(),
    // 只在有有效值时设键：undefined 时与 emptyRegistry（无此键）形态一致
    ...(lastUsedModelId ? { lastUsedModelId } : {}),
  };
}

export const DEFAULT_EXPERIMENTAL_SETTINGS: ExperimentalSettings = {
  enableWebSearch: true,
  enableHttpFetch: true,
  enableCloudPage: false,
  webSearchMode: 'browser',
  webSearchApiProvider: 'brave',
  webSearchCustom: { url: '', protocol: 'brave' },
  webSearchEndpoint: 'cn',
  httpFetchMode: 'browser',
  httpFetchCustom: { url: '', protocol: 'deepseek', sendPrivate: false },
  enableHtmlRender: true,
  multiHostConnectionIds: [],
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

/** 长期记忆默认开启、后台复盘默认关闭（与 Rust 侧 `MemorySettings::default` 一致）。 */
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  autoReflect: false,
};

const DEFAULT_SETTINGS: AppSettings = {
  terminalColors: DEFAULT_TERMINAL_COLORS,
  fontSize: 14,
  fontFamily: 'JetBrains Mono, Fira Code, Consolas, "Microsoft YaHei", monospace',
  defaultAgentMode: 'agent',
  llmRegistry: DEFAULT_LLM_REGISTRY,
  agentModeSettings: DEFAULT_AGENT_MODE_SETTINGS,
  experimentalSettings: DEFAULT_EXPERIMENTAL_SETTINGS,
  memorySettings: DEFAULT_MEMORY_SETTINGS,
  conversationImagesMode: 'onDemand',
  updateMode: 'auto',
  autoUpdate: true,
  fileManagerShowHidden: false,
  fileManagerPath: '/',
  fileManagerPaths: {},
  fileManagerTreeWidth: 200,
  fileManagerTreeUserHidden: false,
  folderUploadCompressionLevel: 6,
  panelHeight: 256,
  hideThinkingDisplay: false,
  /** 默认开启：只折叠「已完成且过程较长的回合」。 */
  foldCompletedTurns: true,
  privacyMode: false,
  /** 归档会话保留 30 天后自动清理（0 = 永不清理），与后端默认值一致。 */
  archiveRetentionDays: 30,
  notificationSettings: DEFAULT_NOTIFICATION_SETTINGS,
  mobileNotificationSettings: DEFAULT_MOBILE_NOTIFICATION_SETTINGS,
  mobileBackgroundSettings: DEFAULT_MOBILE_BACKGROUND_SETTINGS,
  workspaceLayout: DEFAULT_WORKSPACE_LAYOUT,
  uiTheme: normalizeUiTheme(undefined),
  customProtectedPaths: [],
  riskRuleOverrides: {},
  customRiskRules: defaultCustomRiskRules(),
  commandTimeoutSecs: 180,
  hasCompletedOnboarding: false,
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
  /** True if the DeepSeek tools API key (web search + web fetch) is stored in the system keychain. */
  hasDeepseekToolsApiKey: boolean;
  /** True if the custom search API key is stored in the system keychain (it is optional to have one). */
  hasCustomSearchApiKey: boolean;
  /** True if the custom page-fetch service key is stored in the system keychain (optional to have one). */
  hasCustomFetchApiKey: boolean;
  /** True if the Tavily page-fetch key is stored in the system keychain (empty = reuse the Tavily search key). */
  hasTavilyFetchApiKey: boolean;
  /** True if a TypeSafe（Jev）API Key is stored in the system keychain. */
  hasJevApiKey: boolean;
  /** 各渠道密钥是否存在（多渠道模型服务）。key = channelId。 */
  channelKeyStatus: Record<string, boolean>;
  /** Non-fatal warning from the backend (e.g. settings.json was backed up). */
  warning: string | null;

  /** Load settings from disk on app startup. Idempotent unless forced. */
  load: (force?: boolean) => Promise<void>;
  /** 从启动快照批量 Hydrate 设置 */
  hydrateFromBootstrap: (data: {
    settings: AppSettings;
    hasApiKey: boolean;
    hasWebSearchApiKey: boolean;
    /** 必填，理由同 `hasJevApiKey`：漏发会让设置页把已配的 DeepSeek Key 显示成没配。 */
    hasDeepseekToolsApiKey: boolean;
    /** 必填，理由同上：启动快照是唯一读取路径。 */
    hasCustomSearchApiKey: boolean;
    /** 必填，理由同上。 */
    hasCustomFetchApiKey: boolean;
    /** 必填，理由同上。 */
    hasTavilyFetchApiKey: boolean;
    /**
     * 必填：启动快照是读取该真值的**唯一**路径（`hydrateFromBootstrap` 会把
     * `loaded` 置真，随后的 `load()` 直接短路）。声明成可选会让后端漏发字段时
     * 静默退化成「没配 Key」，并藏起清除按钮。
     */
    hasJevApiKey: boolean;
    channelKeyStatus?: ChannelKeyStatus[];
    warning?: string | null;
  }) => void;
  /**
   * 保存一份整体设置（桌面设置页「草稿 + 保存」流）。
   *
   * 传 `base`（草稿打开 / 上次与 store 对齐时的快照）时，只把 `settings` 相对 `base`
   * **真正改过的字段**合并到此刻最新的设置上再保存——别的设备同步来的改动不会被旧草稿改回去。
   * 不传 `base` = 整份覆盖（仅限确定手上这份就是最新的场景）。
   */
  save: (settings: AppSettings, base?: AppSettings) => Promise<void>;
  /**
   * Patch a subset of fields, persist, and update local state.
   * 与 `save` 同一套合并：patch 相对「调用时的设置」改了什么，就只把那部分落到执行时的最新设置上。
   */
  update: (patch: Partial<AppSettings>) => Promise<void>;
  /**
   * 跨设备同步把别的设备的改动落到本机之后（`sync-data-applied`），从后端重读设置。
   * 与保存共用一条串行队列：不会和在途的保存交叉，保存之后读到的一定是落盘后的真值。
   * 失败只记日志，保留当前内存里的设置。
   */
  refreshFromBackend: () => Promise<void>;
  /** Acknowledge / dismiss a backend warning. */
  clearWarning: () => void;
  /** Preview settings for live updates (not persisted until save) */
  preview: Partial<AppSettings> | null;
  /** Update preview settings for live preview */
  setPreview: (preview: Partial<AppSettings>) => void;
  /** Clear preview settings */
  clearPreview: () => void;
}

/** 把后端 channelKeyStatus 数组转为 id → bool 映射。 */
function toKeyStatusMap(list: ChannelKeyStatus[] | undefined): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const s of list ?? []) map[s.channelId] = s.hasKey;
  return map;
}

/** 剥掉已删除/废弃的 experimental 字段（旧配置残留不落盘）。
 *  显式 delete 而非解构：enableMultiHost 已从类型删除，解构会让未用变量
 *  触发 lint；delete 对类型外键也安全（运行时旧配置可能仍带着它）。 */
function stripLegacyExperimental(
  es: Partial<ExperimentalSettings> | undefined,
): Partial<ExperimentalSettings> {
  if (!es) return {};
  const copy = { ...es };
  delete (copy as Record<string, unknown>).enableMultiHost;
  return copy;
}

function hydrateExperimental(
  es: Partial<ExperimentalSettings> | undefined,
): ExperimentalSettings {
  return {
    ...DEFAULT_EXPERIMENTAL_SETTINGS,
    ...stripLegacyExperimental(es),
  };
}

/**
 * 把磁盘 / 后端返回的原始设置补成前端使用的完整形态（缺字段补默认、旧数据归一化）。
 * 启动快照、`load`、同步落地后的 `refreshFromBackend` 三条读取路径共用这一份，
 * 不会出现「某条路径少补了一个字段」的漂移。
 */
function hydrateSettings(fromDisk: AppSettings): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...fromDisk,
    terminalColors: fromDisk.terminalColors ?? DEFAULT_TERMINAL_COLORS,
    // 审批引擎等新字段：旧数据缺字段时用默认值兜底。
    // 「兼容旧数据 = 保持原样 + 默认值填充」——`commandApprovalEngine` 缺省
    // 走 `model`，行为与引入 Jev 之前一致，不改变任何用户现状。
    agentModeSettings: {
      ...DEFAULT_AGENT_MODE_SETTINGS,
      ...(fromDisk.agentModeSettings ?? {}),
    },
    llmRegistry: normalizeRegistry(fromDisk.llmRegistry),
    experimentalSettings: hydrateExperimental(fromDisk.experimentalSettings),
    memorySettings: { ...DEFAULT_MEMORY_SETTINGS, ...(fromDisk.memorySettings ?? {}) },
    // 旧配置没有归档保留天数：按默认 30 天兜底（与 Rust 默认值一致）
    archiveRetentionDays: fromDisk.archiveRetentionDays ?? 30,
    fileManagerPaths: fromDisk.fileManagerPaths ?? {},
    workspaceLayout: normalizeWorkspaceLayout(fromDisk.workspaceLayout),
    // 应用主题：缺字段/非法颜色由 normalizeUiTheme 按默认值兜底（兼容旧数据 = 保持原样 + 默认填充）。
    uiTheme: normalizeUiTheme(fromDisk.uiTheme),
    mobileNotificationSettings: {
      ...DEFAULT_MOBILE_NOTIFICATION_SETTINGS,
      ...(fromDisk.mobileNotificationSettings ?? {}),
    },
    mobileBackgroundSettings: {
      ...DEFAULT_MOBILE_BACKGROUND_SETTINGS,
      ...(fromDisk.mobileBackgroundSettings ?? {}),
    },
    // 更新方式三态：旧后端/旧配置没有该字段时按旧的 autoUpdate 推导，
    // 保持用户现状（旧语义下 autoUpdate=false = 仅提醒），不清空也不报错。
    updateMode: normalizeUpdateMode(fromDisk),
  };
}

/**
 * 设置读写的串行队列（保存与同步后刷新共用）。
 *
 * 没有它：两次几乎同时的 `update` 各自拿同一份旧设置合并，后完成的整份覆盖先完成的
 * （丢更新）；同步刷新夹在一次在途保存中间，则会被保存完成后的 `set` 盖回旧值。
 * 空闲时 job 同步开跑（不多等一个微任务），排队时接在上一个之后；上一个失败不影响下一个。
 */
let writeTail: Promise<void> | null = null;
function serialize<T>(job: () => Promise<T>): Promise<T> {
  const run = writeTail ? writeTail.then(job) : job();
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  writeTail = settled;
  void settled.then(() => {
    if (writeTail === settled) writeTail = null;
  });
  return run;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  hasApiKey: false,
  hasWebSearchApiKey: false,
  hasDeepseekToolsApiKey: false,
  hasCustomSearchApiKey: false,
  hasCustomFetchApiKey: false,
  hasTavilyFetchApiKey: false,
  hasJevApiKey: false,
  channelKeyStatus: {},
  warning: null,
  preview: null,

  hydrateFromBootstrap: (data) => {
    const merged = hydrateSettings(data.settings);
    set({
      settings: merged,
      loaded: true,
      hasApiKey: data.hasApiKey,
      hasWebSearchApiKey: data.hasWebSearchApiKey ?? false,
      hasDeepseekToolsApiKey: data.hasDeepseekToolsApiKey ?? false,
      hasCustomSearchApiKey: data.hasCustomSearchApiKey ?? false,
      hasCustomFetchApiKey: data.hasCustomFetchApiKey ?? false,
      hasTavilyFetchApiKey: data.hasTavilyFetchApiKey ?? false,
      hasJevApiKey: data.hasJevApiKey ?? false,
      channelKeyStatus: toKeyStatusMap(data.channelKeyStatus),
      warning: data.warning ?? null,
    });
    setNotificationVolume(merged.notificationSettings?.notificationVolume ?? 70);
  },

  load: async (force = false) => {
    if (get().loaded && !force) return;
    try {
      const resp = await tauri.getSettings();
      const merged = hydrateSettings(resp.settings);
      set({
        settings: merged,
        loaded: true,
        hasApiKey: resp.hasApiKey,
        hasWebSearchApiKey: resp.hasWebSearchApiKey ?? false,
        hasDeepseekToolsApiKey: resp.hasDeepseekToolsApiKey ?? false,
        hasCustomSearchApiKey: resp.hasCustomSearchApiKey ?? false,
        hasCustomFetchApiKey: resp.hasCustomFetchApiKey ?? false,
        hasTavilyFetchApiKey: resp.hasTavilyFetchApiKey ?? false,
        hasJevApiKey: resp.hasJevApiKey ?? false,
        channelKeyStatus: toKeyStatusMap(resp.channelKeyStatus),
        warning: resp.warning ?? null,
      });
      setNotificationVolume(merged.notificationSettings?.notificationVolume ?? 70);
    } catch (err) {
      console.error('加载设置失败:', err);
      set({ loaded: false });
      throw err;
    }
  },

  save: async (settings: AppSettings, base?: AppSettings) => {
    if (!get().loaded) {
      console.warn('[settingsStore] save() blocked — settings not loaded yet');
      return;
    }
    await serialize(async () => {
      // 排到队里再取「最新」：前面的保存 / 同步刷新可能已经改过 store。
      const next = base ? threeWayMerge(base, settings, get().settings) : settings;
      await tauri.saveSettings(next);
      set({ settings: next, preview: null });
    });
  },

  update: async (patch: Partial<AppSettings>) => {
    if (!get().loaded) {
      console.warn('[settingsStore] update() blocked — settings not loaded yet');
      return;
    }
    // base = 调用方此刻看到的设置；mine = 调用方想要的结果。
    // 真正落盘时再拿最新值做合并（见 serialize 的说明）。
    const base = get().settings;
    const mine = { ...base, ...patch };
    await serialize(async () => {
      const next = threeWayMerge(base, mine, get().settings);
      await tauri.saveSettings(next);
      set({ settings: next, preview: null });
    });
  },

  refreshFromBackend: () =>
    serialize(async () => {
      if (!get().loaded) return;
      try {
        const resp = await tauri.getSettings();
        const merged = hydrateSettings(resp.settings);
        const flags = {
          hasApiKey: resp.hasApiKey,
          hasWebSearchApiKey: resp.hasWebSearchApiKey ?? false,
          hasDeepseekToolsApiKey: resp.hasDeepseekToolsApiKey ?? false,
          hasCustomSearchApiKey: resp.hasCustomSearchApiKey ?? false,
          hasCustomFetchApiKey: resp.hasCustomFetchApiKey ?? false,
          hasTavilyFetchApiKey: resp.hasTavilyFetchApiKey ?? false,
          hasJevApiKey: resp.hasJevApiKey ?? false,
          channelKeyStatus: toKeyStatusMap(resp.channelKeyStatus),
        };
        const current = get();
        // 内容没变就别换引用 / 别触发订阅：下游 effect（主题 / 终端外观）不该白白跑一遍。
        const settingsChanged = !deepEqual(merged, current.settings);
        const flagsChanged = (Object.keys(flags) as (keyof typeof flags)[]).some(
          (key) => !deepEqual(flags[key], current[key]),
        );
        if (settingsChanged || flagsChanged) {
          set({ ...(settingsChanged ? { settings: merged } : {}), ...(flagsChanged ? flags : {}) });
        }
        setNotificationVolume(merged.notificationSettings?.notificationVolume ?? 70);
      } catch (err) {
        console.error('同步后刷新设置失败:', getErrorMessage(err));
      }
    }),

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
