/**
 * sftpFileOpen — SFTP 文件管理器桌面 / 移动共用的纯逻辑。
 *
 * 职责：
 *  - 列表排序（sortFileEntries：隐藏过滤 + 目录优先 + 名称比较；名称比较的
 *    唯一来源是 compareFileNames，目录树 fileTreeModel 也用它）
 *  - 远端路径拼接（joinRemotePath）
 *  - 主操作（点按 / 双击 / 单击已选项）打开方式的判定（openFileKind）与
 *    「拒绝打开」的统一文案构造（图片过大 / 文件过大 / 二进制不可编辑）
 *  - 压缩默认目标路径推导（defaultArchiveTargetPath，桌面 CompressModal 与
 *    移动 MobileCompressSheet 同一份）
 *
 * 只放纯函数：不 import 组件、不碰 Tauri IPC，两端 UI 各自决定怎么呈现。
 */

import { BINARY_EXTENSIONS, MAX_EDITOR_FILE_SIZE, MAX_PREVIEW_IMAGE_SIZE } from './constants';
import { formatSize, getFileExtension, isPreviewableImage } from './sftp-helpers';
import type { SftpFileEntry } from './types';

// ──────────── 列表排序 ────────────

/**
 * 全进程共用一个 Collator。
 *
 * 不能在比较器里写 `a.localeCompare(b, undefined, options)`：带 locale / options 的
 * `localeCompare` 每次调用都要解析并构造排序规则，比复用 `Intl.Collator#compare`
 * 慢两个数量级 —— 5000 项目录实测 175 ms → 6 ms（排序结果逐项一致）。大目录
 * （/var/log、node_modules、/usr/bin）每次进入都要排一遍，这笔账会直接算进导航延迟。
 */
const fileNameCollator = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});

/** 文件名比较：大小写不敏感、数字按数值。列表与目录树共用，保证两处顺序一致。 */
export function compareFileNames(a: string, b: string): number {
  return fileNameCollator.compare(a, b);
}

/**
 * 目录优先、名称排序（大小写不敏感、数字按数值），可选过滤点开头的隐藏条目。
 * 不改动入参数组。
 */
export function sortFileEntries(
  entries: SftpFileEntry[],
  showHidden = true,
): SftpFileEntry[] {
  const result = showHidden
    ? [...entries]
    : entries.filter((e) => !e.name.startsWith('.'));
  result.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return compareFileNames(a.name, b.name);
  });
  return result;
}

// ──────────── 路径拼接 ────────────

/**
 * 把条目名拼到远端父路径后面；父路径为根（或空）时不产生双斜杠。
 *
 * 会剥掉父路径尾部的 `/` 再拼：桌面 / 移动的路径栏都允许手动输入以 `/` 结尾的
 * 路径（编辑框原样提交），不剥的话拼出来是 `/var/log//name`。POSIX 上双斜杠
 * 等价单斜杠、SFTP 服务器会归一化，剥不剥都能用 —— 这里选剥，让拼接结果保持
 * 规范形（桌面 fileTreeModel.joinRemotePath 经 normalizeRemotePath 也是剥尾斜杠
 * 的同向语义；桌面面板里的内联三元则不剥，本函数统一为剥）。
 */
export function joinRemotePath(parent: string, name: string): string {
  const base = parent.replace(/\/+$/, '') || '';
  if (!base || base === '') return `/${name}`;
  return `${base}/${name}`;
}

// ──────────── 打开方式判定 ────────────

export type OpenFileKind = 'image' | 'text' | 'binary';

/** Image open/preview by extension (desktop isPreviewableImage / IMAGE_EXTENSIONS). */
export function isImageFileName(name: string): boolean {
  return isPreviewableImage(name);
}

/**
 * Heuristic: not a known binary extension → probably text/code (including no-extension).
 * Images are not text even though desktop BINARY_EXTENSIONS also lists them.
 */
export function isProbablyTextFileName(name: string): boolean {
  if (isImageFileName(name)) return false;
  const ext = getFileExtension(name);
  if (!ext) return true;
  return !BINARY_EXTENSIONS.has(ext);
}

/** How a file should open on primary action (点按 / 双击 / 单击已选项). */
export function openFileKind(name: string): OpenFileKind {
  if (isImageFileName(name)) return 'image';
  if (isProbablyTextFileName(name)) return 'text';
  return 'binary';
}

// ──────────── 拒绝打开的统一文案 ────────────

/**
 * 「拒绝打开」的三条提示，桌面（handleNavigate + 右键菜单）与移动（openFile）
 * 共用一份，避免两端措辞漂移。数值 / 扩展名展示口径：
 *  - 大小走 formatSize（与传输中心一致）
 *  - 二进制的扩展名带点小写（如 `.zip`），无扩展名时留空括号
 */

export function imageTooLargeMessage(size: number): string {
  return `图片过大 (${formatSize(size)})，预览上限为 ${formatSize(MAX_PREVIEW_IMAGE_SIZE)}，请使用下载功能`;
}

export function fileTooLargeMessage(size: number): string {
  return `文件过大 (${formatSize(size)})，编辑器限制为 ${formatSize(MAX_EDITOR_FILE_SIZE)}，请使用下载功能`;
}

export function binaryNotEditableMessage(name: string): string {
  const ext = getFileExtension(name);
  return `无法编辑二进制文件 (${ext})，请使用下载功能`;
}

// ──────────── 压缩 ────────────

export type ArchiveFormat = 'tar.gz' | 'zip';

/** 从 remoteDir 推导默认压缩目标路径：父目录/basename.{ext}，避免递归包含。 */
export function defaultArchiveTargetPath(
  remoteDir: string,
  format: ArchiveFormat,
): string {
  const trimmed = remoteDir.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  const basename = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  const parent = lastSlash >= 0 ? trimmed.slice(0, lastSlash) : '/';
  const joinedParent = parent === '' ? '/' : parent;
  return joinedParent === '/'
    ? `/${basename}.${format}`
    : `${joinedParent}/${basename}.${format}`;
}

// ──────────── 「打开这个文件」的统一决策 ────────────

/**
 * 想怎么打开：`auto` = 主操作（双击 / 点按）的默认方式；`editor` / `preview` = 用户
 * 明确选了「在编辑器中打开」「在预览中打开」。
 */
export type OpenIntent = 'auto' | 'editor' | 'preview';

export type OpenDecision =
  | { kind: 'preview' }
  | { kind: 'editor' }
  /** 打不开：`message` 是给用户看的原因（与双击 / 右键菜单 / 手机端完全同一句）。 */
  | { kind: 'refuse'; message: string };

/**
 * 一个普通文件该用什么方式打开（桌面双击、右键菜单、手机点按、以及 agent 链接 / 交付卡片
 * 的「打开」共用的**唯一**判定）：图片走预览（先于二进制判断，图片扩展名也在
 * BINARY_EXTENSIONS 里），二进制拒绝，超大文件拒绝，其余进编辑器。
 */
export function decideOpen(name: string, size: number, intent: OpenIntent = 'auto'): OpenDecision {
  const kind = openFileKind(name);
  if (intent !== 'editor' && kind === 'image') {
    if (size > MAX_PREVIEW_IMAGE_SIZE) return { kind: 'refuse', message: imageTooLargeMessage(size) };
    return { kind: 'preview' };
  }
  if (intent === 'preview') {
    return { kind: 'refuse', message: `「${name}」没有可用的预览，请在编辑器中打开或使用下载` };
  }
  if (kind !== 'text') return { kind: 'refuse', message: binaryNotEditableMessage(name) };
  if (size > MAX_EDITOR_FILE_SIZE) return { kind: 'refuse', message: fileTooLargeMessage(size) };
  return { kind: 'editor' };
}
