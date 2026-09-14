import type { UpdateMode } from './types';

/**
 * 更新方式三态（桌面端与移动端共用一套语义/文案）。
 *
 * 三态的引入动机：此前只有「自动下载并安装更新」一个开关，它只切「要不要自动
 * 下载」，新版本检查永远在跑 —— 于是「关掉开关」实际等于「仅提醒」，用户想
 * 「彻底别查了」时没有任何入口。三态把这两件事分开：
 *
 * - `auto`   自动更新：检查 + 自动后台下载 + 就绪后自动安装；
 * - `notify` 仅提醒：只检查并提示，下载与安装都由用户手动发起；
 * - `off`    关闭：不检查新版本，也不自动下载/安装。设置页的手动「检查更新」
 *            仍然可用（那是用户主动发起的，不该被自己的开关锁死），但只提供
 *            「去下载页」——本机不再缓存安装包。
 */
export const UPDATE_MODES: readonly UpdateMode[] = ['auto', 'notify', 'off'];

export const UPDATE_MODE_LABELS: Record<UpdateMode, string> = {
  auto: '自动更新',
  notify: '仅提醒',
  off: '关闭',
};

/** 当前模式的说明文案（展示在选择控件下方，随选中项变化）。
 *  `isApk` = 安卓：自动下载只在非计量网络（Wi-Fi/以太网）下进行，
 *  文案必须写明，否则用户在移动数据下等不到自动下载会以为坏了。 */
export function updateModeDescription(mode: UpdateMode, isApk: boolean): string {
  switch (mode) {
    case 'auto':
      return isApk
        ? '发现新版本后在 Wi-Fi 下自动后台下载，下载完成提示你安装'
        : '发现新版本后自动后台下载，退出应用时静默安装';
    case 'notify':
      return '只提示有新版本，不自动下载；下载和安装都由你手动发起';
    case 'off':
      return '不检查新版本，也不自动下载或安装；想更新时点上面的「检查更新」去下载页手动装';
  }
}

/** 选择控件里每一项的一句话说明（分段/列表项空间有限，比上个函数更短）。 */
export const UPDATE_MODE_HINTS: Record<UpdateMode, string> = {
  auto: '自动下载并安装',
  notify: '只提示不下载',
  off: '不检查新版本',
};

/**
 * 归一化后端返回的更新方式 —— 兼容两种旧数据：
 * 1. 旧后端（不认识 `updateMode`）返回的 settings 里没有这个字段；
 * 2. 旧配置文件迁移前，字段可能缺失或后端尚未写回。
 *
 * 取值规则与后端 Rust 侧完全一致：
 * - 已知三值 → 原样使用；
 * - 字段存在但不是已知取值（空串、或更高版本写入的第四种模式）→ 保守取
 *   「仅提醒」：绝不退化成 `auto`，否则会在用户毫不知情时自动下载几十 MB；
 * - 字段缺失（null/undefined）→ 按旧的 `autoUpdate` 推导：`true` → 自动更新
 *   （旧默认），`false` → 仅提醒（旧语义下关掉开关就是「仍然检查、只提示」）。
 */
export function normalizeUpdateMode(settings: {
  updateMode?: string | null;
  autoUpdate?: boolean | null;
} | null | undefined): UpdateMode {
  const mode = settings?.updateMode;
  if (mode === 'auto' || mode === 'notify' || mode === 'off') return mode;
  if (mode != null) return 'notify';
  return settings?.autoUpdate === false ? 'notify' : 'auto';
}

/**
 * 本机可展示/可选的三态：不支持后台下载的平台（macOS/Linux）没有「自动更新」
 * 这条路 —— 展示出来只会让用户点了必然失败，所以从选项里摘掉，并把已存的
 * `auto` 显示为等价的 `notify`（后端在那些平台本来也不会自动下载）。
 */
export function availableUpdateModes(supportsSilentDownload: boolean): UpdateMode[] {
  return supportsSilentDownload ? [...UPDATE_MODES] : ['notify', 'off'];
}

/** 把已存的模式映射成本机实际生效的展示值（见 `availableUpdateModes`）。 */
export function displayUpdateMode(
  mode: UpdateMode,
  supportsSilentDownload: boolean,
): UpdateMode {
  if (mode === 'auto' && !supportsSilentDownload) return 'notify';
  return mode;
}
