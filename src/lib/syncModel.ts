import { relativeTime } from '@/lib/memory';
import type {
  SyncHistoryEntry,
  SyncStatus,
  SyncStorageConfig,
} from '@/lib/types';

/**
 * 跨设备同步界面用到的纯逻辑（桌面设置页与手机设置页共用，不碰 React / Tauri）。
 * 状态怎么说、记录怎么读、向导填的东西怎么校验，都只在这里写一次。
 */

// ───── 状态呈现 ─────

/** 状态点 / 文案的色调。`off` = 没开启（中性灰），`busy` = 进行中。 */
export type SyncTone = 'off' | 'ok' | 'busy' | 'warn' | 'error';

export interface SyncStatusView {
  tone: SyncTone;
  /** 状态行主文案：「已同步 · 刚刚」。 */
  title: string;
  /** 主文案下的补充说明（出错原因、该怎么办）；没有就是 null。 */
  detail: string | null;
}

/** 最近一次同步出错时，给出错原因配上「会自动重试」的安抚。 */
const ERROR_FALLBACK = '同步没有成功，原因未知';

export function describeSyncStatus(
  status: Pick<SyncStatus, 'enabled' | 'state' | 'lastSyncAt' | 'lastError' | 'pendingCount'>,
  now: Date = new Date(),
): SyncStatusView {
  if (!status.enabled || status.state === 'off') {
    return { tone: 'off', title: '未开启', detail: null };
  }
  switch (status.state) {
    case 'syncing':
      return { tone: 'busy', title: '同步中…', detail: null };
    case 'error':
      return {
        tone: 'error',
        title: '同步出错',
        detail: `${status.lastError?.trim() || ERROR_FALLBACK}。应用会自动重试，也可以点「重试」马上再来一次。`,
      };
    case 'needsUpgrade':
      return {
        tone: 'warn',
        title: '需要升级到新版本',
        detail:
          '云端有更新版本的 Marcel SSH 写入的数据，这台设备的版本读不懂。升级应用后会自动继续同步，在此之前本机数据不受影响。',
      };
    case 'needsConfirm':
      return {
        tone: 'warn',
        title: '等待你确认',
        detail: '本机刚刚删除了不少内容。确认之前不会同步给其它设备。',
      };
    default: {
      const when = status.lastSyncAt ? relativeTime(status.lastSyncAt, now) : '';
      const title = when ? `已同步 · ${when}` : '已就绪';
      const detail =
        status.pendingCount > 0 ? `还有 ${status.pendingCount} 项改动等待上传` : null;
      return { tone: 'ok', title, detail };
    }
  }
}

/**
 * 是否需要用户注意（桌面顶栏图标 / 手机入口状态点）。正常、同步中、没开启都不打扰。
 */
export function needsAttention(state: SyncStatus['state'] | undefined | null): boolean {
  return state === 'error' || state === 'needsConfirm' || state === 'needsUpgrade';
}

/**
 * 存放位置的一行描述：「WebDAV · dav.jianguoyun.com · marcel-sync」。
 * 只给人看，不含账号和密码。SFTP 要靠连接名字，所以调用方把已保存连接的显示名传进来。
 */
export function describeStorage(
  storage: SyncStorageConfig | null,
  sftpConnectionLabel?: string | null,
): string {
  if (!storage) return '';
  if (storage.kind === 'webDav') {
    let host = storage.url;
    try {
      host = new URL(storage.url).host || storage.url;
    } catch {
      /* 地址不是合法 URL：原样显示 */
    }
    return `WebDAV · ${host} · ${storage.root}`;
  }
  return `我的服务器 · ${sftpConnectionLabel || '（该连接已被删除）'} · ${storage.root}`;
}

// ───── 同步范围与数据源 ─────

/** 同步源 key → 给人看的名字（key 是跨版本稳定的字符串，见后端 `DataSourceId::sync_key`）。 */
export const SYNC_SOURCE_LABELS: Record<string, string> = {
  settings: '设置',
  connections: '连接',
  quickCommands: '快捷命令',
  skills: '技能',
  mcpServers: 'MCP 服务',
  knownHosts: '已知主机',
  conversations: '对话',
  memory: '记忆',
  secrets: '机密',
};

export function syncSourceLabel(source: string): string {
  return SYNC_SOURCE_LABELS[source] ?? source;
}

/** 「删除了 3 个连接」里的量词。 */
const HELD_UNITS: Record<string, string> = {
  settings: '项设置',
  connections: '个连接',
  quickCommands: '条快捷命令',
  skills: '个技能',
  mcpServers: '个 MCP 服务',
  knownHosts: '条已知主机记录',
  conversations: '段对话',
  memory: '条记忆',
  secrets: '项机密',
};

/** 「本机一次删除了 3 个连接、5 条快捷命令」。没有等待确认的内容返回 null。 */
export function describeHeld(held: SyncStatus['held']): string | null {
  const parts = (held ?? [])
    .filter((h) => h.count > 0)
    .map((h) => `${h.count} ${HELD_UNITS[h.source] ?? `项${syncSourceLabel(h.source)}`}`);
  if (parts.length === 0) return null;
  return `本机一次删除了 ${parts.join('、')}`;
}

// ───── 同步记录 ─────

/** 设置里常见字段的中文名。认不得的字段原样显示，不猜。 */
const SETTING_KEY_LABELS: Record<string, string> = {
  fontSize: '终端字号',
  fontFamily: '终端字体',
  terminalColors: '终端配色',
  uiTheme: '应用主题',
  defaultAgentMode: '默认 Agent 模式',
  privacyMode: '隐私模式',
  llmRegistry: '模型服务',
  agentModeSettings: 'Agent 策略',
  experimentalSettings: '工具能力',
  memorySettings: '记忆',
  customProtectedPaths: '受保护路径',
  riskRuleOverrides: '风险规则',
  customRiskRules: '自定义风险规则',
  hideThinkingDisplay: '隐藏思考过程',
  foldCompletedTurns: '折叠已完成回合',
  archiveRetentionDays: '归档保留天数',
  commandTimeoutSecs: '命令超时',
  folderUploadCompressionLevel: '文件夹压缩等级',
  fileManagerShowHidden: '显示隐藏文件',
  notificationSettings: '通知',
};

const PLATFORM_PREFIX: Record<string, string> = {
  '@desktop': '仅桌面端',
  '@android': '仅手机端',
};

/** 把后端给的叶子路径拆成段。兼容 `a/b/c` 与 JSON 数组两种写法，后端怎么写都不至于显示成乱码。 */
function splitPath(path: string): string[] {
  const trimmed = path.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((seg) => {
          if (typeof seg === 'string') return seg;
          if (seg && typeof seg === 'object' && 'id' in seg) return `#${String((seg as { id: unknown }).id)}`;
          return '顺序';
        });
      }
    } catch {
      /* 不是 JSON，按普通路径处理 */
    }
  }
  return trimmed.split('/').filter((seg) => seg.length > 0);
}

/** 像 id 的一段（UUID / 长十六进制 / `#` 开头）缩成 `#abc123`，免得一长串挤满一行。 */
function shortenIdSegment(seg: string): string {
  const raw = seg.startsWith('#') ? seg.slice(1) : seg;
  if (/^[0-9a-f-]{8,}$/i.test(raw)) return `#${raw.replace(/-/g, '').slice(0, 6)}`;
  return seg;
}

export interface HistoryEntryView {
  /** 哪一类数据：「设置」「连接」。 */
  sourceLabel: string;
  /** 改的是哪个字段：「终端字号」「连接 #3f2a1b › host」。 */
  fieldLabel: string;
  /** 平台限定，例如「仅桌面端」；通用字段为 null。 */
  scope: string | null;
  oldValue: string | null;
  newValue: string | null;
  /**
   * 只显示「哪个 Key 变了」，不显示任何值。
   *
   * 机密（`source === 'secrets'`）的记录里后端本来就只有槽位名；前端即使拿到
   * `oldValue` / `newValue` 也不该画出来——值一旦出现在界面上，截图 / 录屏就会漏。
   */
  hideValues: boolean;
}

/** 路径拆出来的兜底说法：后端没给 `label` 时才用（老记录 / 老版本写入的历史）。 */
function describePath(entry: SyncHistoryEntry): HistoryEntryView {
  const segments = splitPath(entry.path);
  let scope: string | null = null;
  if (segments.length > 0 && PLATFORM_PREFIX[segments[0]]) {
    scope = PLATFORM_PREFIX[segments[0]];
    segments.shift();
  }
  // 路径首段有时就是同步源本身（`settings/fontSize`），已经单独显示了，不重复。
  if (segments.length > 0 && segments[0] === entry.source) segments.shift();
  const readable = segments.map((seg, index) => {
    if (entry.source === 'settings' && index === 0 && SETTING_KEY_LABELS[seg]) {
      return SETTING_KEY_LABELS[seg];
    }
    return shortenIdSegment(seg);
  });
  return {
    sourceLabel: syncSourceLabel(entry.source),
    fieldLabel: readable.length > 0 ? readable.join(' › ') : syncSourceLabel(entry.source),
    scope,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    hideValues: entry.source === 'secrets',
  };
}

export function describeHistoryEntry(entry: SyncHistoryEntry): HistoryEntryView {
  const base = describePath(entry);
  // 后端给了人话说明就直接用：「连接『生产服务器』的主机地址」比「连接 › #c1 › host」好读得多。
  // 老记录（这个字段加之前写的）没有 `label`，那时才回落到按路径猜。
  const label = entry.label?.trim();
  return label ? { ...base, fieldLabel: label } : base;
}

// ───── 恢复密钥 / 同步码 ─────

/** 恢复密钥字符集（与后端一致，去掉了 0 1 i l o 这些易混字符），共 32 位。 */
const RECOVERY_KEY_PATTERN = /^[2-9a-hjkmnp-z]{32}$/;

/** 忽略 `-`、空白、大小写——用户从哪抄来、怎么分的段都认。 */
export function normalizeRecoveryKey(input: string): string {
  return input.replace(/[\s-]+/g, '').toLowerCase();
}

export function isPlausibleRecoveryKey(input: string): boolean {
  return RECOVERY_KEY_PATTERN.test(normalizeRecoveryKey(input));
}

/** 4 个一组、用 `-` 连接，方便抄写与核对。输入不合法就原样返回（不替用户猜）。 */
export function formatRecoveryKey(key: string): string {
  const normalized = normalizeRecoveryKey(key);
  if (!RECOVERY_KEY_PATTERN.test(normalized)) return key;
  return normalized.match(/.{4}/g)!.join('-');
}

export const SYNC_CODE_PREFIX = 'MSYNC1-';

/** 同步码的粗检：只看前缀和长度，真伪交给后端（解码 / 解密才是权威）。 */
export function isPlausibleSyncCode(input: string): boolean {
  const code = input.trim();
  return code.startsWith(SYNC_CODE_PREFIX) && code.length > SYNC_CODE_PREFIX.length + 16;
}

// ───── 向导（开启 / 加入）─────

export type WizardMode = 'create' | 'join';
export type JoinMethod = 'code' | 'manual';
export type StorageKind = SyncStorageConfig['kind'];

export const DEFAULT_SYNC_ROOT = 'marcel-sync';

export interface WizardState {
  mode: WizardMode;
  joinMethod: JoinMethod;
  storageKind: StorageKind;
  webDav: { url: string; username: string; password: string; root: string };
  sftp: { connectionId: string; root: string };
  recoveryKeyInput: string;
  syncCodeInput: string;
  /** 「测试连接」的结果；存储相关输入一变就回到 idle（上一次的结论不再适用）。 */
  test: { status: 'idle' | 'testing' | 'ok' | 'failed'; message: string | null };
  /** 「开启 / 加入」这一步的进度与失败原因。 */
  submit: { status: 'idle' | 'working' | 'failed'; message: string | null };
  /** 创建成功后拿到的密钥与同步码——只在向导的局部状态里短暂存在。 */
  created: { recoveryKey: string; syncCode: string } | null;
  /** 「我已妥善保存」。 */
  acknowledged: boolean;
}

export function initialWizardState(mode: WizardMode): WizardState {
  return {
    mode,
    joinMethod: 'code',
    storageKind: 'webDav',
    webDav: { url: '', username: '', password: '', root: DEFAULT_SYNC_ROOT },
    sftp: { connectionId: '', root: DEFAULT_SYNC_ROOT },
    recoveryKeyInput: '',
    syncCodeInput: '',
    test: { status: 'idle', message: null },
    submit: { status: 'idle', message: null },
    created: null,
    acknowledged: false,
  };
}

export type WizardAction =
  | { type: 'reset'; mode: WizardMode }
  | { type: 'setJoinMethod'; method: JoinMethod }
  | { type: 'setStorageKind'; kind: StorageKind }
  | { type: 'setWebDav'; patch: Partial<WizardState['webDav']> }
  | { type: 'setSftp'; patch: Partial<WizardState['sftp']> }
  | { type: 'setRecoveryKey'; value: string }
  | { type: 'setSyncCode'; value: string }
  | { type: 'testStart' }
  | { type: 'testOk' }
  | { type: 'testFail'; message: string }
  | { type: 'submitStart' }
  | { type: 'submitFail'; message: string }
  | { type: 'created'; recoveryKey: string; syncCode: string }
  | { type: 'acknowledge'; value: boolean };

const IDLE_TEST: WizardState['test'] = { status: 'idle', message: null };
const IDLE_SUBMIT: WizardState['submit'] = { status: 'idle', message: null };

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'reset':
      return initialWizardState(action.mode);
    case 'setJoinMethod':
      return { ...state, joinMethod: action.method, test: IDLE_TEST, submit: IDLE_SUBMIT };
    case 'setStorageKind':
      return { ...state, storageKind: action.kind, test: IDLE_TEST, submit: IDLE_SUBMIT };
    case 'setWebDav':
      return {
        ...state,
        webDav: { ...state.webDav, ...action.patch },
        test: IDLE_TEST,
        submit: IDLE_SUBMIT,
      };
    case 'setSftp':
      return {
        ...state,
        sftp: { ...state.sftp, ...action.patch },
        test: IDLE_TEST,
        submit: IDLE_SUBMIT,
      };
    case 'setRecoveryKey':
      return { ...state, recoveryKeyInput: action.value, submit: IDLE_SUBMIT };
    case 'setSyncCode':
      return { ...state, syncCodeInput: action.value, submit: IDLE_SUBMIT };
    case 'testStart':
      return { ...state, test: { status: 'testing', message: null }, submit: IDLE_SUBMIT };
    case 'testOk':
      return { ...state, test: { status: 'ok', message: null } };
    case 'testFail':
      return { ...state, test: { status: 'failed', message: action.message } };
    case 'submitStart':
      return { ...state, submit: { status: 'working', message: null } };
    case 'submitFail':
      return { ...state, submit: { status: 'failed', message: action.message } };
    case 'created':
      return {
        ...state,
        submit: IDLE_SUBMIT,
        created: { recoveryKey: action.recoveryKey, syncCode: action.syncCode },
        acknowledged: false,
      };
    case 'acknowledge':
      return { ...state, acknowledged: action.value };
  }
}

/** 填写的存储位置 → 后端要的配置。必填项没填全返回 null。 */
export function buildStorageConfig(state: WizardState): SyncStorageConfig | null {
  if (state.storageKind === 'webDav') {
    const url = state.webDav.url.trim();
    const username = state.webDav.username.trim();
    if (!/^https?:\/\/\S+$/i.test(url) || !username) return null;
    return {
      kind: 'webDav',
      url,
      username,
      root: state.webDav.root.trim() || DEFAULT_SYNC_ROOT,
    };
  }
  const connectionId = state.sftp.connectionId.trim();
  if (!connectionId) return null;
  return {
    kind: 'sftp',
    connectionId,
    root: state.sftp.root.trim() || DEFAULT_SYNC_ROOT,
  };
}

/** 存储密码：WebDAV = 账号密码（坚果云要用「应用密码」）；SFTP 的密码走已保存连接，不在这里填。 */
export function buildStorageSecret(state: WizardState): string | null {
  if (state.storageKind !== 'webDav') return null;
  return state.webDav.password.length > 0 ? state.webDav.password : null;
}

/** 存储部分是否填完整（决定「测试连接」能不能点）。 */
export function canTestStorage(state: WizardState): boolean {
  if (buildStorageConfig(state) === null) return false;
  return state.storageKind === 'sftp' || state.webDav.password.length > 0;
}

/** 当前这一步的主按钮能不能点。 */
export function canSubmitWizard(state: WizardState): boolean {
  if (state.submit.status === 'working') return false;
  if (state.mode === 'create') {
    return canTestStorage(state) && state.test.status === 'ok';
  }
  if (state.joinMethod === 'code') return isPlausibleSyncCode(state.syncCodeInput);
  return canTestStorage(state) && isPlausibleRecoveryKey(state.recoveryKeyInput);
}

/** WebDAV 地址看起来是坚果云吗？是的话在表单里补一条针对性的提示。 */
export function isJianguoyunUrl(url: string): boolean {
  return /jianguoyun\.com/i.test(url);
}
