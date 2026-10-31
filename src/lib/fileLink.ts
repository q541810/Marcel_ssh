/**
 * fileLink — 「agent 说到的某个文件」的纯逻辑（桌面 / 移动共用，唯一来源）。
 *
 * 管三件事：
 *  1. 解析 markdown 里的 `remote:` / `local:` 链接（`parseFileLink`）；
 *  2. 从工具调用参数里取出它碰过的文件（`toolFileRefs`），工具卡片据此挂路径芯片；
 *  3. 一个文件上能做哪些动作（`fileLinkActionItems`），右键菜单与手机面板共用同一份清单。
 *
 * 还包括「这台机器是哪台」的解析（`resolveFileMachine`）：链接里的 `host` 是连接名，
 * 要落到某个**在线会话**上才能操作。解析不出来就明确说原因，绝不静默落到别的机器。
 *
 * 只放纯函数：不碰 Tauri、不碰 store，方便单测；副作用在 `fileNav.ts`。
 */

import { openFileKind } from './sftpFileOpen';
import type { SavedConnection, Session } from './types';

// ──────────── 数据形状 ────────────

export type FileSide = 'remote' | 'local';

/** 指向一个文件 / 目录的引用。`host` 为 null = 「这个对话所在的那台机器」。 */
export interface FileRef {
  side: FileSide;
  /** 连接名（可带重名消歧后缀 `:1`）；远端且省略 = 对话绑定的会话；本机恒 null。 */
  host: string | null;
  /** 绝对路径（远端为 POSIX 路径；本机沿用用户系统的写法）。 */
  path: string;
  /** 已知是目录 / 链接写了结尾斜杠（stat 之前的线索，stat 之后以 stat 为准）。 */
  isDir?: boolean;
}

// ──────────── 链接解析 ────────────

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 去掉结尾分隔符（根目录 / 盘符根保留）。 */
function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (trimmed === '') return path.startsWith('/') || path.startsWith('\\') ? '/' : path;
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}/`;
  return trimmed;
}

const LOCAL_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;

/**
 * 解析 agent 输出里的文件链接。只认两种协议，其余（含 http）一律返回 null，
 * 由调用方走原来的外链逻辑：
 *
 *  - `remote:/abs/path`        对话所在服务器上的文件；
 *  - `remote://<连接名>/abs`   指定机器（多机场景），连接名可 percent 编码；
 *  - `local:C:/x/y` `local:/x` 运行 Marcel SSH 的这台电脑上的文件。
 *
 * href 到这里时已被 markdown 库做过一次 percent 编码（空格、中文都变成 `%XX`），
 * 所以路径、连接名都要解码；解码失败（字面量里就有孤立的 `%`）原样保留。
 */
export function parseFileLink(href: string | null | undefined): FileRef | null {
  if (!href) return null;
  const text = href.trim();
  const scheme = /^(remote|local):/i.exec(text);
  if (!scheme) return null;
  const rest = text.slice(scheme[0].length);

  if (scheme[1].toLowerCase() === 'remote') {
    let host: string | null = null;
    let rawPath: string;
    if (rest.startsWith('//')) {
      const afterSlashes = rest.slice(2);
      const slash = afterSlashes.indexOf('/');
      if (slash < 0) return null;
      const rawHost = safeDecode(afterSlashes.slice(0, slash)).trim();
      host = rawHost === '' ? null : rawHost;
      rawPath = afterSlashes.slice(slash);
    } else if (rest.startsWith('/')) {
      rawPath = rest;
    } else {
      return null;
    }
    const decoded = safeDecode(rawPath);
    if (!decoded.startsWith('/')) return null;
    return {
      side: 'remote',
      host,
      path: trimTrailingSeparators(decoded),
      isDir: decoded.length > 1 && decoded.endsWith('/') ? true : undefined,
    };
  }

  // local: `local:C:/x`、`local:/C:/x`、`local:///C:/x`、`local:/home/u/x`
  let decoded = safeDecode(rest);
  decoded = decoded.replace(/^\/{1,3}(?=[A-Za-z]:[\\/])/, '');
  if (!LOCAL_ABSOLUTE.test(decoded)) return null;
  return {
    side: 'local',
    host: null,
    path: trimTrailingSeparators(decoded),
    isDir: decoded.length > 1 && /[\\/]$/.test(decoded) ? true : undefined,
  };
}

// ──────────── 路径小工具 ────────────

/** 路径最后一段（根返回 `/`）。兼容本机的反斜杠。 */
export function fileBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  if (!trimmed) return '/';
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** 所在目录。`/a/b` → `/a`，`/a` → `/`；本机盘符路径同理。 */
export function fileParentDir(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return path;
  if (idx === 0) return trimmed[0] === '\\' ? '\\' : '/';
  const parent = trimmed.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p);

/** 统一成正斜杠、去结尾分隔符（根保持 `/`）。 */
function normalizeForRelative(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  const trimmed = slashed.replace(/\/+$/, '');
  return trimmed === '' && slashed.startsWith('/') ? '/' : trimmed;
}

/**
 * `path` 相对 `base` 的写法；`path` 不在 `base` 之下（或恰好就是 `base`、没有可写的相对部分）
 * 返回 null——绝不产出 `../`。`tilde` = 家目录写法：`/home/u/a/b` → `~/a/b`。
 * 分隔符不分 `/` `\`；Windows 盘符路径比较时不分大小写。
 */
export function relativePathUnder(
  path: string,
  base: string | null | undefined,
  options: { tilde?: boolean } = {},
): string | null {
  if (!base) return null;
  const target = normalizeForRelative(path);
  const root = normalizeForRelative(base);
  if (!target || !root) return null;
  const fold = isWindowsPath(target) && isWindowsPath(root);
  const eq = (a: string, b: string) => (fold ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (eq(target, root)) return null;
  const prefix = root === '/' ? '/' : `${root}/`;
  if (!eq(target.slice(0, prefix.length), prefix)) return null;
  const rest = target.slice(prefix.length);
  if (!rest) return null;
  if (options.tilde) return root === '/' ? null : `~/${rest}`;
  return rest;
}

export type RelativeBaseId = 'fileManager' | 'project' | 'home';

export interface RelativeBase {
  id: RelativeBaseId;
  dir: string;
}

export interface RelativeCandidate {
  id: RelativeBaseId;
  label: string;
  /** 复制出来的文本——菜单上直接展示它。 */
  text: string;
}

const BASE_LABEL: Record<RelativeBaseId, string> = {
  fileManager: '相对文件管理当前目录',
  project: '相对项目根目录',
  home: '相对家目录',
};

/**
 * 「候选基准 → 相对路径」：只列路径确实位于该基准之下的项。顺序即菜单顺序（由近到远），
 * 不同基准恰好得到同一段文本时只留靠前的一个，免得菜单里两行一模一样。
 * 终端当前目录不在候选里：前端没有 shell 上报的 cwd（未做 OSC 7 跟踪），确定不了就不列。
 */
export function relativeCandidates(path: string, bases: ReadonlyArray<RelativeBase>): RelativeCandidate[] {
  const order: RelativeBaseId[] = ['fileManager', 'project', 'home'];
  const out: RelativeCandidate[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const base = bases.find((b) => b.id === id);
    if (!base) continue;
    const text = relativePathUnder(path, base.dir, { tilde: id === 'home' });
    if (text === null || seen.has(text)) continue;
    seen.add(text);
    out.push({ id, label: BASE_LABEL[id], text });
  }
  return out;
}

// ──────────── 动作清单 ────────────

export type FileActionId =
  | 'open'
  | 'editor'
  | 'preview'
  | 'reveal'
  | 'cd'
  | 'copyPath'
  | 'copyRelative';

export interface FileActionItem {
  id: FileActionId | 'divider';
  label: string;
  /** 菜单项下面一行小字：复制类动作在这里写出「到底会复制什么」。 */
  hint?: string;
  /** 二级菜单（复制相对路径：每项就是一个候选基准，hint 直接是复制出来的文本）。 */
  children?: RelativeCandidate[];
}

/** 这个文件的文件类型（决定能不能进编辑器 / 预览）。目录单独一类。 */
export type FileLinkKind = 'dir' | 'image' | 'text' | 'binary';

export function fileLinkKind(ref: Pick<FileRef, 'path' | 'isDir'>): FileLinkKind {
  if (ref.isDir) return 'dir';
  return openFileKind(fileBaseName(ref.path));
}

/** 左键点一下默认做什么：目录与二进制 → 在文件管理中显示，文本 → 编辑器，图片 → 预览。 */
export function defaultFileAction(ref: Pick<FileRef, 'side' | 'path' | 'isDir'>): FileActionId {
  if (ref.side === 'local') return 'reveal';
  const kind = fileLinkKind(ref);
  return kind === 'text' || kind === 'image' ? 'open' : 'reveal';
}

/**
 * 右键菜单 / 手机面板的条目。桌面与手机共用，所以「某类文件有哪些动作」只写这一处：
 *  - 在预览中打开：只对有预览的类型（目前是图片）；
 *  - 在编辑器中打开：只对能当文本编辑的文件；
 *  - 相对路径：二级菜单，只列路径确实位于其下的基准（见 `relativeCandidates`），一个都没有就不出现；
 *  - 本机：没有编辑器 / 终端 / 家目录这些，只有「在文件夹中显示」与复制路径。
 *
 * `unresolved`（机器不在线）时只剩复制路径——复制不碰机器。
 */
export function fileLinkActionItems(
  ref: Pick<FileRef, 'side' | 'path' | 'isDir'>,
  options: { relative?: RelativeCandidate[]; unresolved?: boolean } = {},
): FileActionItem[] {
  const items: FileActionItem[] = [];
  const kind = fileLinkKind(ref);
  const copy: FileActionItem[] = [
    {
      id: 'copyPath',
      label: ref.side === 'local' ? '复制路径' : '复制绝对路径',
      hint: ref.path,
    },
  ];
  if (options.relative && options.relative.length > 0) {
    copy.push({ id: 'copyRelative', label: '复制相对路径', children: options.relative });
  }

  if (!options.unresolved) {
    if (ref.side === 'local') {
      items.push({ id: 'reveal', label: '在文件夹中显示' });
    } else {
      items.push({ id: 'open', label: kind === 'dir' ? '在文件管理中打开' : '打开' });
      if (kind === 'text') items.push({ id: 'editor', label: '在编辑器中打开' });
      if (kind === 'image') items.push({ id: 'preview', label: '在预览中打开' });
      items.push({ id: 'reveal', label: '在文件管理中显示' });
      items.push({ id: 'cd', label: kind === 'dir' ? '在终端中进入该目录' : '在终端中进入所在目录' });
    }
    items.push({ id: 'divider', label: '' });
  }
  return [...items, ...copy];
}

// ──────────── 工具调用里的文件 ────────────

function stringArg(args: Record<string, unknown> | undefined, key: string): string | null {
  const value = args?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 参数里的路径 → 引用（远端必须是绝对路径；本机接受盘符 / `/` / UNC）。 */
function refFrom(side: FileSide, host: string | null, rawPath: string | null): FileRef | null {
  if (!rawPath) return null;
  if (side === 'remote' && !rawPath.startsWith('/')) return null;
  if (side === 'local' && !LOCAL_ABSOLUTE.test(rawPath)) return null;
  return {
    side,
    host: side === 'remote' ? host : null,
    path: trimTrailingSeparators(rawPath),
    isDir: rawPath.length > 1 && /[\\/]$/.test(rawPath) ? true : undefined,
  };
}

/**
 * 一次工具调用碰到的文件。路径与机器都由**结构化参数**给出，不依赖 markdown 约定：
 *  - `read/write/edit_file`：远端 `path`（可带 `host`）；`local_*` 同名工具：本机 `path`；
 *  - `upload_file` / `download_file`：服务器侧 `remote_path`（可带 `host`）与本机侧 `local_path`。
 *
 * 判远端 / 本机看**工具名**，不看参数（参数是模型写的）。
 */
export function toolFileRefs(
  toolName: string,
  args: Record<string, unknown> | undefined,
): FileRef[] {
  const host = stringArg(args, 'host');
  const refs: (FileRef | null)[] = [];
  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      refs.push(refFrom('remote', host, stringArg(args, 'path')));
      break;
    case 'local_read_file':
    case 'local_write_file':
    case 'local_edit_file':
      refs.push(refFrom('local', null, stringArg(args, 'path')));
      break;
    case 'upload_file':
    case 'download_file':
      refs.push(refFrom('remote', host, stringArg(args, 'remote_path')));
      refs.push(refFrom('local', null, stringArg(args, 'local_path')));
      break;
    default:
      break;
  }
  return refs.filter((r): r is FileRef => r !== null);
}

// ──────────── 机器解析 ────────────

export type MachineResolution =
  | { ok: true; sessionId: string | null; label: string }
  | { ok: false; reason: string };

export interface MachineContext {
  /** 当前对话所绑定的会话（没有 = null）。 */
  boundSessionId: string | null;
  sessions: Record<string, Pick<Session, 'id' | 'status' | 'configId' | 'createdAt'>>;
  connections: ReadonlyArray<Pick<SavedConnection, 'id' | 'name'>>;
  /** 手机：本机路径不可用。 */
  mobile?: boolean;
}

/** 与后端 `multi_host::resolve_connection` 同口径：裸名 = 同名第 0 个，`名:i` = 第 i 个。 */
export function findConnectionByHost(
  connections: ReadonlyArray<Pick<SavedConnection, 'id' | 'name'>>,
  host: string,
): Pick<SavedConnection, 'id' | 'name'> | null {
  const byId = connections.find((c) => c.id === host);
  if (byId) return byId;
  const sameName = (name: string) => connections.filter((c) => c.name === name);
  const exact = sameName(host);
  if (exact.length > 0) return exact[0];
  const m = /^(.*):(\d+)$/.exec(host);
  if (m) return sameName(m[1])[Number(m[2])] ?? null;
  return null;
}

/**
 * 把引用落到一个**在线会话**上。解析不出来给出人话原因（做成禁用链接的 tooltip）：
 * 机器不对就是不对，绝不退而求其次去别的机器上打开同一个路径。
 */
export function resolveFileMachine(ref: Pick<FileRef, 'side' | 'host'>, ctx: MachineContext): MachineResolution {
  if (ref.side === 'local') {
    return ctx.mobile
      ? { ok: false, reason: '这是运行 Marcel SSH 那台电脑上的路径，手机上无法打开' }
      : { ok: true, sessionId: null, label: '本机' };
  }

  const bound = ctx.boundSessionId ? ctx.sessions[ctx.boundSessionId] : undefined;
  const connectionName = (configId: string | undefined) =>
    ctx.connections.find((c) => c.id === configId)?.name ?? '当前服务器';

  if (!ref.host) {
    if (!bound) return { ok: false, reason: '这个对话没有关联的服务器会话，无法打开服务器上的文件' };
    if (bound.status !== 'connected') return { ok: false, reason: '服务器连接已断开，重新连接后才能打开' };
    return { ok: true, sessionId: bound.id, label: connectionName(bound.configId) };
  }

  const conn = findConnectionByHost(ctx.connections, ref.host);
  if (!conn) return { ok: false, reason: `找不到名为「${ref.host}」的服务器连接` };
  if (bound && bound.configId === conn.id && bound.status === 'connected') {
    return { ok: true, sessionId: bound.id, label: conn.name };
  }
  const live = Object.values(ctx.sessions)
    .filter((s) => s.configId === conn.id && s.status === 'connected')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!live) return { ok: false, reason: `「${conn.name}」当前没有在线的会话，先连接它再打开` };
  return { ok: true, sessionId: live.id, label: conn.name };
}

// ──────────── 「交付文件」卡片的 metadata ────────────

export interface PresentFileMeta {
  ref: FileRef;
  title: string | null;
  note: string | null;
  size: number | null;
}

const nonEmptyString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/**
 * 后端 `present_file` / `local_present_file` 的结果 metadata
 * （`{ kind: "presentFile", path, isDir, size, side, host, title, note }`）→ 卡片数据。
 * 不是这个形状（旧会话、失败的调用没有 metadata）返回 null，调用方退回通用工具卡。
 */
export function parsePresentFileMeta(meta: Record<string, unknown> | undefined | null): PresentFileMeta | null {
  if (!meta || meta.kind !== 'presentFile') return null;
  const path = nonEmptyString(meta.path);
  const side = meta.side === 'local' ? 'local' : meta.side === 'remote' ? 'remote' : null;
  if (!path || !side) return null;
  return {
    ref: {
      side,
      host: side === 'remote' ? nonEmptyString(meta.host) : null,
      path,
      isDir: meta.isDir === true,
    },
    title: nonEmptyString(meta.title),
    note: nonEmptyString(meta.note),
    size: typeof meta.size === 'number' ? meta.size : null,
  };
}
