/**
 * fileNav — 「带用户去 / 打开某个文件」的统一入口（manager，桌面 / 移动共用）。
 *
 * 它协调的东西：对话 → 会话绑定、连接列表（决定文件在哪台机器）、SFTP stat（路径还在不在）、
 * 文件管理器（桌面底栏 / 手机文件页，经 `fileNavStore` 信箱交接）、终端（`cd`）、剪贴板。
 * agent 消息里的路径链接、工具卡片的路径芯片、「交付文件」卡片都只调这里，
 * 不各写各的——所以新增一种入口不会漏掉「机器对不对」「路径存不存在」这些检查。
 *
 * 分工：纯判断（解析链接、动作清单、机器解析）在 `lib/fileLink.ts`；打开方式的决策
 * （图片预览 / 编辑器 / 拒绝）在 `lib/sftpFileOpen.ts` 的 `decideOpen`，由文件管理器
 * 领到请求后执行，这里不重复；改动类动作（重命名、删除…）仍属 `useFileActions`。
 */

import { exists, stat } from '@tauri-apps/plugin-fs';
import { collectPlatformHints, isMobilePlatform } from '@/platform';
import { currentMobileTab, requestMobileTab, type MobileTabId } from '@/mobile/tabs';
import { isBottomPanelMounted, requestBottomTab } from '@/lib/bottomPanelNav';
import { requestOpenAgentPanel } from '@/lib/agentPanelNav';
import { DEFAULT_WORKSPACE_LAYOUT, dockPanelOf } from '@/lib/workspaceLayout';
import { copyText } from '@/lib/copyText';
import { getErrorMessage } from '@/lib/errors';
import { sftpHomeDir, sftpListDir, revealLocalPath } from '@/lib/tauri';
import { sendCdToTerminal } from '@/lib/fileShellActions';
import {
  defaultFileAction,
  fileBaseName,
  fileLinkKind,
  fileParentDir,
  resolveFileMachine,
  type FileActionId,
  type FileRef,
  type MachineContext,
  type MachineResolution,
} from '@/lib/fileLink';
import { sessionConversationBindingManager } from '@/stores/sessionConversationBindingManager';
import { useSessionStore } from '@/stores/sessionStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useFileNavStore, type FileNavIntent } from '@/stores/fileNavStore';

// ──────────── 机器解析（读 store 的快照） ────────────

export function isMobileShell(): boolean {
  return isMobilePlatform(collectPlatformHints());
}

/** 当前对话所在的会话；对话没有占用任何会话时为 null。 */
export function boundSessionOf(conversationId: string | null | undefined): string | null {
  if (!conversationId) return null;
  return sessionConversationBindingManager.findOccupyingSession(conversationId)?.sessionId ?? null;
}

export function machineContextNow(conversationId: string | null | undefined): MachineContext {
  return {
    boundSessionId: boundSessionOf(conversationId),
    sessions: useSessionStore.getState().sessions,
    connections: useConnectionStore.getState().connections,
    mobile: isMobileShell(),
  };
}

export function resolveMachineNow(
  ref: Pick<FileRef, 'side' | 'host'>,
  conversationId: string | null | undefined,
): MachineResolution {
  return resolveFileMachine(ref, machineContextNow(conversationId));
}

// ──────────── stat 与家目录 ────────────

export interface PathInfo {
  /** null = 没能确认（父目录读不了等），按「可能存在」继续，让后续操作自己报错。 */
  exists: boolean | null;
  isDir: boolean;
  size: number;
}

const NOT_FOUND = /no such file|not found|does not exist|不存在|找不到|NoSuchFile/i;

/**
 * 远端路径还在不在。后端没有单独的 stat 命令，借父目录的列表确认——同一条共享 SFTP 会话，
 * 与文件管理器列目录是同一条路径；根目录恒存在。
 */
export async function statRemotePath(
  sessionId: string,
  path: string,
  hintIsDir = false,
): Promise<PathInfo> {
  if (path === '/') return { exists: true, isDir: true, size: 0 };
  try {
    const entries = await sftpListDir(sessionId, fileParentDir(path));
    const name = fileBaseName(path);
    const hit = entries.find((e) => e.name === name);
    return hit
      ? { exists: true, isDir: hit.is_dir, size: hit.size }
      : { exists: false, isDir: false, size: 0 };
  } catch (err) {
    return NOT_FOUND.test(getErrorMessage(err))
      ? { exists: false, isDir: false, size: 0 }
      : { exists: null, isDir: hintIsDir, size: 0 };
  }
}

const homeCache = new Map<string, Promise<string | null>>();

/** 远端登录用户的家目录（每个会话只问一次；失败不缓存）。 */
export function getRemoteHome(sessionId: string): Promise<string | null> {
  let pending = homeCache.get(sessionId);
  if (!pending) {
    pending = sftpHomeDir(sessionId)
      .then((home) => home || null)
      .catch(() => {
        homeCache.delete(sessionId);
        return null;
      });
    homeCache.set(sessionId, pending);
  }
  return pending;
}

// ──────────── 项目根目录（最近的含 .git 的祖先） ────────────

const projectRootCache = new Map<string, Promise<string | null>>();
const MAX_ROOT_SEARCH_DEPTH = 16;

async function hasGitDir(side: 'remote' | 'local', sessionId: string | null, dir: string): Promise<boolean> {
  try {
    if (side === 'remote') {
      const entries = await sftpListDir(sessionId as string, dir);
      return entries.some((e) => e.name === '.git');
    }
    return await exists(`${dir.replace(/[\\/]+$/, '')}/.git`);
  } catch {
    return false;
  }
}

/**
 * 从 `startDir` 往上找最近的含 `.git` 的目录。按需调用（菜单打开时），每个起点缓存，
 * 找不到 / 出错都是 null——相对项目根目录这一项就不出现。
 */
export function findProjectRoot(
  side: 'remote' | 'local',
  sessionId: string | null,
  startDir: string,
): Promise<string | null> {
  const key = `${side}:${sessionId ?? ''}:${startDir}`;
  let pending = projectRootCache.get(key);
  if (!pending) {
    pending = (async () => {
      let dir = startDir;
      for (let i = 0; i < MAX_ROOT_SEARCH_DEPTH; i++) {
        if (await hasGitDir(side, sessionId, dir)) return dir;
        const parent = fileParentDir(dir);
        if (parent === dir) return null;
        dir = parent;
      }
      return null;
    })();
    projectRootCache.set(key, pending);
  }
  return pending;
}

// ──────────── 终端 cd（桌面 / 手机、文件管理器 / agent 链接共用） ────────────

/** 往会话终端敲 `cd`。返回错误文案（null = 成功）。全屏程序占着终端时拒绝，免得把命令敲进 vim。 */
export async function cdInTerminal(sessionId: string, dir: string): Promise<string | null> {
  // 动态引入：xterm 只在真要敲命令时才需要，别让每个会渲染路径芯片的模块都背上它
  const { terminalInstanceManager } = await import('@/components/terminal/TerminalInstanceManager');
  const terminal = terminalInstanceManager.get(sessionId)?.terminal;
  if (terminal?.buffer.active.type === 'alternate') {
    return '终端正在运行全屏程序（vim、less、tmux 等），暂不能切换目录，请先退出再试';
  }
  try {
    await sendCdToTerminal(sessionId, dir);
    terminalInstanceManager.get(sessionId)?.terminal?.focus();
    return null;
  } catch (err) {
    return `在终端中打开失败：${getErrorMessage(err)}`;
  }
}

// ──────────── 动作执行 ────────────

const notify = (text: string, tone: 'error' | 'info' = 'error') =>
  useFileNavStore.getState().notify(text, tone);

export async function copyWithNotice(text: string): Promise<void> {
  try {
    await copyText(text);
    notify('已复制到剪贴板', 'info');
  } catch (err) {
    notify(`复制失败：${getErrorMessage(err)}`);
  }
}

/**
 * 文件管理器现在够不够得着（桌面）：底栏挂着就行；没挂着时，唯一能请出来的情形是
 * 「Agent 占主区域」且右侧栏（终端停靠处）被收起——展开它终端就会挂上。独占视图（设置 / 调试）
 * 下 Agent 面板本身就不在，没人会点到这里。手机的文件页永远在。
 * 菜单据此把「在文件管理中显示」这类项藏起来，别留一个点了没反应的按钮。
 */
export function canShowFileManager(): boolean {
  if (isMobileShell() || isBottomPanelMounted()) return true;
  const layout = useSettingsStore.getState().settings.workspaceLayout;
  const dockOpen = layout?.agentOpen ?? DEFAULT_WORKSPACE_LAYOUT.agentOpen;
  return dockPanelOf(layout) === 'terminal' && !dockOpen;
}

/** 把「去文件管理器」的请求递出去，并把文件管理器亮出来。 */
function deliverToFileManager(
  sessionId: string,
  info: { path: string; isDir: boolean; size: number },
  intent: FileNavIntent,
  opts: { followUp?: boolean; returnTo?: MobileTabId | null } = {},
): void {
  const mobile = isMobileShell();
  // 手机：记下用户从哪一页来，文件页据此提供「返回」（桌面对话就在旁边，不需要）
  const origin = mobile ? currentMobileTab() : null;
  useFileNavStore.getState().push({
    sessionId,
    ...info,
    intent,
    returnTo: opts.returnTo !== undefined ? opts.returnTo : origin && origin !== 'files' ? origin : null,
  });
  // 跟进请求（确认完路径后补发的「打开它」）只更新待办，不再切面板 / 页签：
  // 用户这几百毫秒里可能已经去了别处，不该被硬拽回来。
  if (opts.followUp) return;
  useSessionStore.getState().setActiveSession(sessionId);
  if (mobile) {
    requestMobileTab('files');
    return;
  }
  // 底栏还没挂（Agent 占主区域、终端那一栏被收起）：先把那一栏请出来，终端挂上时会按
  // 记下的标签直接打开文件管理，待办也还在信箱里等着
  if (!isBottomPanelMounted()) requestOpenAgentPanel();
  requestBottomTab('file-manager');
}

/** 最近一次「去文件管理器」的点击序号：后台确认完才补发的后续，只在它仍是最新一次时才算数。 */
let navToken = 0;

async function runLocal(action: FileActionId, ref: FileRef): Promise<void> {
  try {
    await stat(ref.path);
  } catch {
    notify(`这个路径在本机上不存在：${ref.path}`);
    return;
  }
  try {
    await revealLocalPath(ref.path);
  } catch (err) {
    notify(`在文件夹中显示失败：${getErrorMessage(err)}`);
  }
}

/**
 * 对一个文件引用执行动作。失败 / 不能做都以提示的形式告诉用户，**不抛错**——调用方是点击处理器。
 *
 * 顺序固定：复制绝对路径不碰机器 → 解析机器（不在线就说原因）→ stat（不存在就说
 * 「这个路径在 X 上不存在」）→ 执行。绝不在机器没解析出来时落到别的机器上。
 */
export async function runFileAction(
  action: FileActionId,
  ref: FileRef,
  scope: { conversationId?: string | null } = {},
): Promise<void> {
  if (action === 'copyPath') {
    await copyWithNotice(ref.path);
    return;
  }
  const machine = resolveMachineNow(ref, scope.conversationId);
  if (!machine.ok) {
    notify(machine.reason);
    return;
  }
  const needsFileManager = ref.side === 'remote' && action !== 'cd';
  if (needsFileManager && !canShowFileManager()) {
    notify('现在没有可用的文件管理，先回到终端视图再试');
    return;
  }
  if (ref.side === 'local') {
    await runLocal(action, ref);
    return;
  }

  const sessionId = machine.sessionId as string;

  // 进终端目录：要先知道它是不是目录（文件就进它的父目录），没有界面可先跳，仍先确认。
  if (action === 'cd') {
    const info = await statRemotePath(sessionId, ref.path, ref.isDir);
    if (info.exists === false) {
      notify(`这个路径在 ${machine.label} 上不存在：${ref.path}`);
      return;
    }
    const dir = info.isDir ? ref.path : fileParentDir(ref.path);
    useSessionStore.getState().setActiveSession(sessionId);
    const error = await cdInTerminal(sessionId, dir);
    if (error) notify(error);
    else if (isMobileShell()) requestMobileTab('terminal');
    return;
  }

  // 其余动作都要去文件管理器：**先跳**。点下去的那一刻就切过去、开始进目录，用户立刻看到界面在动；
  // 「路径在不在 / 是不是目录 / 多大」在后台并行确认（文件管理器自己也在列同一个父目录，
  // 两条请求并行而不是串行），不再有「点了没反应」的停顿。
  const token = ++navToken;
  const mobile = isMobileShell();
  const origin = mobile ? currentMobileTab() : null;
  const returnTo = origin && origin !== 'files' ? origin : null;
  deliverToFileManager(sessionId, { path: ref.path, isDir: ref.isDir ?? false, size: 0 }, 'reveal');

  const info = await statRemotePath(sessionId, ref.path, ref.isDir);
  if (info.exists === false) {
    notify(`这个路径在 ${machine.label} 上不存在：${ref.path}`);
    return;
  }
  // 只是定位，或确认下来是目录：已经带用户到了，没有后续
  if (action === 'reveal' || info.isDir) return;
  // 确认的这段时间里用户又点了别的链接：这次的后续作废，不抢走新的那次
  if (token !== navToken) return;
  // 默认打开：打不开的类型（二进制）停在定位；文本 / 图片直接打开
  const intent: FileNavIntent | null =
    action === 'open'
      ? defaultFileAction({ side: 'remote', path: ref.path, isDir: false }) === 'open'
        ? 'auto'
        : null
      : action === 'editor' || action === 'preview'
        ? action
        : null;
  if (!intent) return;
  deliverToFileManager(sessionId, { path: ref.path, isDir: false, size: info.size }, intent, {
    followUp: true,
    returnTo,
  });
}

/** 左键点击链接 / 芯片：做默认动作。 */
export function runDefaultFileAction(
  ref: FileRef,
  scope: { conversationId?: string | null } = {},
): Promise<void> {
  const kind = fileLinkKind(ref);
  const action: FileActionId = kind === 'dir' ? 'reveal' : defaultFileAction(ref);
  return runFileAction(action, ref, scope);
}
