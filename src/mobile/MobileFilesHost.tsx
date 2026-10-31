import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Loader2, MoreVertical } from 'lucide-react';
import FileEntryIcon from './FileEntryIcon';
import MobileCompressSheet from './MobileCompressSheet';
import MobileFileEditor from './MobileFileEditor';
import MobileImageViewer from './MobileImageViewer';
import MobilePathBar from './MobilePathBar';
import MobileSheet from './ui/MobileSheet';
import { useSftpDownload } from '@/hooks/useSftpDownload';
import { useFileClipboardStore } from '@/stores/fileClipboardStore';
import {
  clipboardLabel,
  pasteBlockedReason,
  pasteClipboard,
  pasteProgressText,
  renamedNotice,
} from '@/lib/filePaste';
import { useSftpUpload } from '@/hooks/useSftpUpload';
import { useTransferStore, selectActiveOf } from '@/stores/transferStore';
import { cancelTransfer } from '@/stores/transferScheduler';
import {
  MAX_EDITOR_FILE_SIZE,
  MAX_PREVIEW_IMAGE_SIZE,
  archiveStem,
  isArchiveFile,
} from '@/lib/constants';
import {
  isContentUri,
  sftpExtractArchive,
  sftpListDir,
  sftpLocalFileName,
  sftpMkdir,
  sftpRemove,
  sftpRemoveViaShell,
  sftpRename,
  sftpWriteFile,
} from '@/lib/tauri';
import type { SftpFileEntry } from '@/lib/types';
import {
  getErrorMessage,
  isDialogCancelled,
} from '@/lib/sftp-helpers';
import {
  binaryNotEditableMessage,
  fileTooLargeMessage,
  imageTooLargeMessage,
} from '@/lib/sftpFileOpen';
import { useConnectionStore } from '@/stores/connectionStore';
import { isDebugSession } from '@/lib/debugServer';
import { loadRememberedPath, rememberPath } from '@/lib/fileManagerPathMemory';
import { resolveHomeFallback } from '@/lib/sftpHomeFallback';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { withForegroundKeepAlive } from './mobileBridge';
import {
  batchDeleteProgressText,
  canOpenEntry,
  canQuickDelete,
  entrySubtitle,
  filesEmptyStateReason,
  filesListLoadingMode,
  joinRemotePath,
  latestTransferCompletion,
  latestTransferFailure,
  openFileKind,
  parentPath,
  resolveFilesSessionIds,
  shouldPersistFileManagerPath,
  soleSelectedEntry,
  sortFileEntries,
  toggleSelectionName,
  transferCompletionNotice,
  transferProgressPercent,
  TRANSFER_COMPLETION_BANNER_MS,
  TRANSFER_COMPLETION_FRESH_MS,
  latestFailureItem,
  latestCompletionItem,
  type FilesEmptyStateReason,
  type TransferCompletionInfo,
} from './filesUi';
import { registerBackHandler } from './backHandler';
import { resolveSessionDisplayName, sessionStatusLabel } from './sessionUi';

interface MobileFilesHostProps {
  /** When false, host stays mounted but hidden (tab keep-alive). */
  visible?: boolean;
}

type OpenTarget = { path: string; name: string; size: number };

const EMPTY_STATE_COPY: Record<
  Exclude<FilesEmptyStateReason, 'ready'>,
  { title: string; body: string }
> = {
  'no-session': {
    title: '未选择会话',
    body: '请先在终端页连接 SSH 服务器。',
  },
  connecting: {
    title: '正在连接…',
    body: '连接完成后可浏览远程文件。',
  },
  disconnected: {
    title: '连接已断开',
    body: '请在终端页重新连接后再浏览文件。',
  },
  error: {
    title: '连接失败',
    body: '请在终端页检查连接后重试。',
  },
};

export default function MobileFilesHost({
  visible = true,
}: MobileFilesHostProps) {
  const activeSession = useSessionStore((s) => {
    const id = s.activeSessionId;
    return id && !isDebugSession(id) ? (s.sessions[id] ?? null) : null;
  });
  const connections = useConnectionStore((s) => s.connections);
  const ids = resolveFilesSessionIds(activeSession);
  const emptyReason = filesEmptyStateReason(activeSession);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const showHidden = useSettingsStore(
    (s) => s.settings.fileManagerShowHidden ?? false,
  );
  const keepAliveEnabled = useSettingsStore(
    (s) => s.settings.mobileBackgroundSettings.keepAliveEnabled,
  );
  const updateSettings = useSettingsStore((s) => s.update);

  const sessionId = ids?.sessionId ?? '';
  const bindingKey = ids ? `${ids.sessionId}:${ids.connectionKey ?? ''}` : null;

  const [currentPath, setCurrentPath] = useState('/');
  const initialPathRef = useRef<string | null>(null);
  const homeTriedRef = useRef(false);
  const [pathReady, setPathReady] = useState(false);
  const [entries, setEntries] = useState<SftpFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  // 单个条目的操作面板（行尾「⋯」打开）。操作入口不再是点一下后插到列表上方的
  // 操作条：那条一出现就把整张列表顶下去，第二下点按落到别的文件上。
  // actionEntry 在面板收起后保留，退出动画期间面板内容不能先一步消失。
  const [actionEntry, setActionEntry] = useState<SftpFileEntry | null>(null);
  const [actionOpen, setActionOpen] = useState(false);
  // 选择模式（多选）：进入时收起单项操作面板
  const [selectMode, setSelectMode] = useState(false);
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set());
  // 删除确认支持批量（对齐桌面 deleteConfirm: SftpFileEntry[]）
  const [deleteConfirm, setDeleteConfirm] = useState<SftpFileEntry[]>([]);
  // 删除/解压等长操作的进度提示条
  const [opStatus, setOpStatus] = useState<string | null>(null);
  const clipboard = useFileClipboardStore((s) => s.clipboard);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const pasteBlocked = pasteBlockedReason(clipboard, sessionId);
  const [extractEntry, setExtractEntry] = useState<SftpFileEntry | null>(null);
  const [compressEntry, setCompressEntry] = useState<SftpFileEntry | null>(
    null,
  );
  const [renameEntry, setRenameEntry] = useState<SftpFileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [previewFile, setPreviewFile] = useState<OpenTarget | null>(null);
  const [editorFile, setEditorFile] = useState<OpenTarget | null>(null);
  // 传输成功提示（短暂可见 + 可复制路径）；null = 不显示
  const [completion, setCompletion] = useState<TransferCompletionInfo | null>(
    null,
  );
  const loadSeqRef = useRef(0);
  const pathInitKeyRef = useRef<string | null>(null);

  const connectionKey = ids?.connectionKey ?? null;

  // Restore remembered path only after settings loaded (avoid wiping with default "/").
  useEffect(() => {
    if (!bindingKey || !sessionId) {
      pathInitKeyRef.current = null;
      setPathReady(false);
      return;
    }
    if (!settingsLoaded) {
      setPathReady(false);
      return;
    }
    if (pathInitKeyRef.current === bindingKey) {
      setPathReady(true);
      return;
    }
    pathInitKeyRef.current = bindingKey;
    const remembered = loadRememberedPath(
      connectionKey,
      useSettingsStore.getState().settings,
    );
    setCurrentPath(remembered);
    // 起始目录读不了就改去家目录，每次（重新）绑定会话只兜一次。
    initialPathRef.current = remembered;
    homeTriedRef.current = false;
    setPathReady(true);
    setActionOpen(false);
    setSelectMode(false);
    setMultiSelected(new Set());
    setError(null);
  }, [bindingKey, sessionId, connectionKey, settingsLoaded]);

  // Persist path memory (mirrors FileManagerPanel); only after restore + settings loaded.
  // 走 localStorage 而不是 settings.update：每切一次目录就整份落盘 + 广播设置变更
  // 太重，见 lib/fileManagerPathMemory.ts。
  useEffect(() => {
    if (
      !shouldPersistFileManagerPath({
        settingsLoaded,
        pathReady,
        connectionKey,
      }) ||
      !connectionKey
    ) {
      return;
    }
    rememberPath(connectionKey, currentPath);
  }, [settingsLoaded, pathReady, connectionKey, currentPath]);

  // 最新目录的镜像。上传/下载完成回调捕获的是**发起那一刻**的 currentPath：
  // 用户若在传输期间切走目录，那次刷新会在之后落地、把新目录的列表覆盖掉
  // （路径栏与表格对不上，后续删除/重命名还会按新目录拼路径）。三处校验：
  // 发起前、await 之后、finally —— 目录已经不是它，结果一律作废。
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!sessionId) return;
      if (path !== currentPathRef.current) return;
      const seq = ++loadSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const items = await sftpListDir(sessionId, path);
        if (seq !== loadSeqRef.current || path !== currentPathRef.current) return;
        setEntries(items);
      } catch (err) {
        if (seq !== loadSeqRef.current || path !== currentPathRef.current) return;
        if (path === initialPathRef.current && !homeTriedRef.current) {
          homeTriedRef.current = true;
          const home = await resolveHomeFallback(sessionId, path);
          if (seq !== loadSeqRef.current || path !== currentPathRef.current) return;
          if (home) {
            initialPathRef.current = home;
            setCurrentPath(home);
            return;
          }
        }
        setEntries([]);
        setError(`加载失败：${getErrorMessage(err)}`);
      } finally {
        if (seq === loadSeqRef.current && path === currentPathRef.current) setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!sessionId || !pathReady) {
      if (!sessionId) {
        setEntries([]);
        // 这里**不**清 error：掉线瞬间产生的失败提示（如「会话已断开，任务已
        // 跳过」）正要靠它显示；切到另一个会话时由下面的路径恢复分支清空。
        setActionOpen(false);
        setSelectMode(false);
        setMultiSelected(new Set());
      }
      return;
    }
    void loadDirectory(currentPath);
    setActionOpen(false);
    // 切换目录时退出选择模式（对齐桌面：路径变化清空 selected）
    setSelectMode(false);
    setMultiSelected(new Set());
  }, [sessionId, pathReady, currentPath, loadDirectory]);

  const filteredEntries = useMemo(
    () => sortFileEntries(entries, showHidden),
    [entries, showHidden],
  );

  // 选择模式里恰好选中一个条目时，把它当作单项操作目标（见 soleSelectedEntry 注释）
  const soleSelected = useMemo(
    () => soleSelectedEntry(filteredEntries, multiSelected),
    [filteredEntries, multiSelected],
  );

  const { uploadFile } = useSftpUpload(sessionId, currentPath);
  const { startDownload } = useSftpDownload(sessionId);

  // 传输中心接管进度管理；移动端保留顶部条显示当前活动传输。
  // 宿主只订阅「有无活动传输」**布尔**（身份稳定，进度 tick 不触发整页重渲染）；
  // 传输条本身抽成了 MobileTransferBars 小组件、自己订阅条目引用。

  // 移动端无传输中心面板：传输任务失败（error 终态）后顶部条消失，用户无从得知。
  // 这里订阅当前 session 最近一次失败任务，若尚未提示过（去重 ref），就地展示错误条。
  // items/order 引用在 store 变更时才替换，订阅它们不会在进度更新时触发重渲染。
  //
  // 用**当前会话的真实 id**（而非 ready 才有的 sessionId）扫描：断连时
  // sessionId 会变成 ''，而「会话已断开，任务已跳过」这类失败恰恰只在断连后产生，
  // 用 ready id 扫就永远扫不到，提示自然也就没有。
  const activeSessionKey = activeSession?.id ?? '';
  // 探测器挪进选择器：返回的是**终态条目对象**（终态后不再被更新，引用稳定），
  // 进度 tick 重跑选择器但结果引用不变，宿主不再被拖着重渲染；隐藏页直接
  // 返回 null（冻结订阅，回前台后下一次 store 变更即追上）。
  const failureItem = useTransferStore((s) =>
    visible ? latestFailureItem(s.items, s.order, activeSessionKey) : null,
  );
  const transferFailure = useMemo(
    () => failureItem && latestTransferFailure({ [failureItem.id]: failureItem }, [failureItem.id], activeSessionKey),
    [failureItem, activeSessionKey],
  );
  const surfacedFailureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!transferFailure) return;
    if (surfacedFailureRef.current === transferFailure.id) return;
    surfacedFailureRef.current = transferFailure.id;
    // statusText 已含「下载失败：原因」等前缀，直接拼文件名即可，避免重复套前缀
    setError(`${transferFailure.fileName}：${transferFailure.statusText}`);
  }, [transferFailure]);

  // 成功终态同理：条目一到 done 就从顶部活动条消失，界面既不说「已完成」，
  // 也不给文件落点。这里派生最近一次成功任务，短暂展示并给一个复制路径的出口。
  const completionItem = useTransferStore((s) =>
    visible ? latestCompletionItem(s.items, s.order, activeSessionKey) : null,
  );
  const transferCompletion = useMemo(
    () => completionItem && latestTransferCompletion({ [completionItem.id]: completionItem }, [completionItem.id], activeSessionKey),
    [completionItem, activeSessionKey],
  );
  const surfacedCompletionRef = useRef<string | null>(null);

  // 会话/绑定切换后旧 session 的提示不应再出现；重置去重标记。
  // 断连（bindingKey 变成 null）不算切换：同一条失败提示被关掉后不该因为掉线
  // 又冒出来（用户刚关掉就会以为出了新问题）。
  const surfacedBindingRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bindingKey) return;
    if (surfacedBindingRef.current === bindingKey) return;
    surfacedBindingRef.current = bindingKey;
    surfacedFailureRef.current = null;
    surfacedCompletionRef.current = null;
  }, [bindingKey]);

  useEffect(() => {
    if (!transferCompletion) return;
    if (surfacedCompletionRef.current === transferCompletion.id) return;
    // 只提示刚完成的：换会话/切标签回来时不补播历史记录
    if (Date.now() - transferCompletion.finishedAt > TRANSFER_COMPLETION_FRESH_MS)
      return;
    surfacedCompletionRef.current = transferCompletion.id;
    setCompletion(transferCompletion);
  }, [transferCompletion]);

  // 倒计时只在文件页可见时走：切走时先留着，回来再看得到
  useEffect(() => {
    if (!completion || !visible) return;
    const timer = setTimeout(
      () => setCompletion(null),
      TRANSFER_COMPLETION_BANNER_MS,
    );
    return () => clearTimeout(timer);
  }, [completion, visible]);

  // 上传 / 下载是两条独立车道（调度器本身就是 upload / download 两条 lane，
  // 桌面两端也可并行）。用一个总布尔会互相禁用，把另一条道白白堵死。
  const uploadBusy = useTransferStore((s) => selectActiveOf(s, 'upload') !== null);
  const downloadBusy = useTransferStore((s) => selectActiveOf(s, 'download') !== null);

  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path || '/');
  }, []);

  const openFile = useCallback(
    (entry: SftpFileEntry) => {
      if (entry.is_dir) return;
      if (!canOpenEntry(entry)) {
        // 设备/管道等特殊文件：给明确提示，不留一个点了没反应的按钮
        setError(`「${entry.name}」不是普通文件，无法打开，请使用下载`);
        return;
      }
      const fullPath = joinRemotePath(currentPath, entry.name);
      const kind = openFileKind(entry.name);
      if (kind === 'image') {
        if (entry.size > MAX_PREVIEW_IMAGE_SIZE) {
          setError(imageTooLargeMessage(entry.size));
          return;
        }
        setPreviewFile({ path: fullPath, name: entry.name, size: entry.size });
        return;
      }
      if (kind === 'binary') {
        // 文案与桌面 handleNavigate 对齐（含扩展名），共享 @/lib/sftpFileOpen 的构造
        setError(binaryNotEditableMessage(entry.name));
        return;
      }
      if (entry.size > MAX_EDITOR_FILE_SIZE) {
        setError(fileTooLargeMessage(entry.size));
        return;
      }
      setEditorFile({ path: fullPath, name: entry.name, size: entry.size });
    },
    [currentPath],
  );

  const handleEntryTap = useCallback(
    (entry: SftpFileEntry) => {
      // 选择模式下：点按 = 勾选/取消勾选，不导航不打开
      if (selectMode) {
        setMultiSelected((prev) => toggleSelectionName(prev, entry.name));
        return;
      }
      // 点一下就办事：目录进入、文件打开，点按本身不改变任何布局。
      // 其余操作走行尾「⋯」。
      if (entry.is_dir) {
        navigateTo(joinRemotePath(currentPath, entry.name));
        return;
      }
      openFile(entry);
    },
    [currentPath, navigateTo, openFile, selectMode],
  );

  const enterSelectMode = useCallback((initial?: SftpFileEntry) => {
    setActionOpen(false);
    setSelectMode(true);
    setMultiSelected(initial ? new Set([initial.name]) : new Set());
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setMultiSelected(new Set());
  }, []);

  const handleToggleHidden = useCallback(() => {
    void updateSettings({ fileManagerShowHidden: !showHidden });
  }, [showHidden, updateSettings]);

  // 批量复制路径（对齐桌面 handleCopyPath(entries)：多行拼接）
  const handleCopyPaths = useCallback(
    async (targets: SftpFileEntry[]) => {
      if (targets.length === 0) return;
      const paths = targets.map((e) => joinRemotePath(currentPath, e.name));
      try {
        await writeText(paths.join('\n'));
      } catch (err) {
        setError(`复制路径失败：${getErrorMessage(err)}`);
      }
    },
    [currentPath],
  );

  const handleRename = useCallback(async () => {
    if (!renameEntry || !sessionId) return;
    const next = renameValue.trim();
    if (!next || next === renameEntry.name) {
      setRenameEntry(null);
      return;
    }
    const oldPath = joinRemotePath(currentPath, renameEntry.name);
    const newPath = joinRemotePath(currentPath, next);
    try {
      await sftpRename(sessionId, oldPath, newPath);
      setRenameEntry(null);
      setRenameValue('');
      // 从选择模式发起时同样收尾，避免留下指向旧名字的勾选
      exitSelectMode();
      await loadDirectory(currentPath);
    } catch (err) {
      setError(`重命名失败：${getErrorMessage(err)}`);
    }
  }, [
    renameEntry,
    renameValue,
    sessionId,
    currentPath,
    loadDirectory,
    exitSelectMode,
  ]);

  const handleGoUp = useCallback(() => {
    if (currentPath === '/') return;
    navigateTo(parentPath(currentPath));
  }, [currentPath, navigateTo]);

  // Android back gesture: when no sheet/editor is open (those register on top),
  // swipe-back matches the path-bar "↑" — go to parent dir. At root we do not
  // register, so the press falls through to App (switch tab / finish).
  useEffect(() => {
    if (!visible || emptyReason !== 'ready' || currentPath === '/') return;
    return registerBackHandler(handleGoUp);
  }, [visible, emptyReason, currentPath, handleGoUp]);

  const handleRefresh = useCallback(() => {
    void loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  const handleUpload = useCallback(async () => {
    if (!sessionId) return;
    try {
      const filePaths = await withForegroundKeepAlive(keepAliveEnabled, () =>
        open({
          multiple: false,
          title: '选择文件',
        }),
      );
      if (!filePaths) return;
      const localPath = Array.isArray(filePaths) ? filePaths[0] : filePaths;
      // Android SAF 返回 content:// URI，最后一段是编码后的 document id 而非文件名，
      // 由后端经 ContentResolver 查询真实 DISPLAY_NAME；普通路径直接取 basename。
      const fileName = isContentUri(localPath)
        ? await sftpLocalFileName(localPath)
        : localPath.split(/[/\\]/).pop() || 'upload';
      const targetPath = joinRemotePath(currentPath, fileName);
      uploadFile(localPath, fileName, targetPath, () => {
        void loadDirectory(currentPath);
      });
    } catch (err) {
      // Android 上取消文件选择器是 reject 而非返回 null，不当作错误
      if (isDialogCancelled(err)) return;
      setError(`上传失败：${getErrorMessage(err)}`);
    }
  }, [sessionId, currentPath, uploadFile, loadDirectory, keepAliveEnabled]);

  const handleDownload = useCallback(
    async (entry: SftpFileEntry) => {
      if (entry.is_dir) return;
      const remote = joinRemotePath(currentPath, entry.name);
      try {
        await startDownload(entry, remote);
      } catch (err) {
        // Android 上取消保存对话框是 reject 而非返回 null，不当作错误
        if (isDialogCancelled(err)) return;
        setError(`下载失败：${getErrorMessage(err)}`);
      }
    },
    [currentPath, startDownload],
  );

  const handleMkdir = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name || !sessionId) return;
    const folderPath = joinRemotePath(currentPath, name);
    try {
      await sftpMkdir(sessionId, folderPath);
      setShowNewFolder(false);
      setNewFolderName('');
      await loadDirectory(currentPath);
    } catch (err) {
      // 措辞对齐桌面 handleCreateFolder（创建文件夹失败），避免双端说法漂移
      setError(`创建文件夹失败：${getErrorMessage(err)}`);
    }
  }, [newFolderName, sessionId, currentPath, loadDirectory]);

  // 新建空文件（对齐桌面 handleCreateFile：sftpWriteFile 写空内容）
  const handleMkfile = useCallback(async () => {
    const name = newFileName.trim();
    if (!name || !sessionId) return;
    const filePath = joinRemotePath(currentPath, name);
    try {
      await sftpWriteFile(sessionId, filePath, '');
      setShowNewFile(false);
      setNewFileName('');
      await loadDirectory(currentPath);
    } catch (err) {
      setError(`创建文件失败：${getErrorMessage(err)}`);
    }
  }, [newFileName, sessionId, currentPath, loadDirectory]);

  // 批量删除（对齐桌面 handleDelete/handleQuickDelete：逐个调用，收集错误后统一提示）
  const runDelete = useCallback(
    async (targets: SftpFileEntry[], quick: boolean) => {
      if (targets.length === 0 || !sessionId) return;
      setDeleteConfirm([]);
      exitSelectMode();
      const errors: string[] = [];
      try {
        for (let i = 0; i < targets.length; i++) {
          const entry = targets[i];
          setOpStatus(batchDeleteProgressText(i + 1, targets.length, quick));
          try {
            const entryPath = joinRemotePath(currentPath, entry.name);
            if (quick) {
              await sftpRemoveViaShell(sessionId, entryPath, entry.is_dir);
            } else {
              await sftpRemove(sessionId, entryPath, entry.is_dir);
            }
          } catch (err) {
            errors.push(`${entry.name}: ${getErrorMessage(err)}`);
          }
        }
        if (errors.length > 0) {
          setError(
            `部分${quick ? '快速删除' : '删除'}失败：${errors.join('；')}`,
          );
        }
        await loadDirectory(currentPath);
      } finally {
        setOpStatus(null);
      }
    },
    [sessionId, currentPath, loadDirectory, exitSelectMode],
  );

  // 复制 / 剪切：只记进共享剪贴板（对齐桌面 handleClip），不动远端
  const handleClip = useCallback(
    (targets: SftpFileEntry[], cut: boolean) => {
      if (targets.length === 0 || !sessionId) return;
      setPasteNotice(null);
      useFileClipboardStore.getState().set({
        sessionId,
        dir: currentPath,
        items: targets.map((e) => ({ name: e.name, isDir: e.is_dir })),
        cut,
      });
      exitSelectMode();
    },
    [sessionId, currentPath, exitSelectMode],
  );

  // 粘贴进 destDir（对齐桌面 handlePaste：默认当前目录，也可粘贴进某个文件夹）
  const handlePaste = useCallback(
    async (destDir: string = currentPath) => {
      const clip = useFileClipboardStore.getState().clipboard;
      if (!clip || !sessionId || pasteBlockedReason(clip, sessionId)) return;
      setPasteNotice(null);
      try {
        const result = await pasteClipboard(clip, destDir, (i, n) =>
          setOpStatus(pasteProgressText(i, n, clip.cut)),
        );
        // 剪切成功的项已搬走，剪贴板作废；失败的项留着方便重试
        if (clip.cut) {
          const failed = new Set(result.failed);
          const left = clip.items.filter((it) => failed.has(it.name));
          if (left.length === 0) useFileClipboardStore.getState().clear();
          else useFileClipboardStore.getState().set({ ...clip, items: left });
        }
        if (result.errors.length > 0) {
          setError(
            `部分${clip.cut ? '移动' : '复制'}失败：${result.errors.join('；')}`,
          );
        }
        setPasteNotice(renamedNotice(result));
        await loadDirectory(currentPath);
      } finally {
        setOpStatus(null);
      }
    },
    [sessionId, currentPath, loadDirectory],
  );

  // 解压（对齐桌面 handleExtract：两种目标模式由调用方传入）
  const handleExtract = useCallback(
    async (entry: SftpFileEntry, targetDir: string) => {
      if (!sessionId) return;
      setExtractEntry(null);
      const archivePath = joinRemotePath(currentPath, entry.name);
      setOpStatus(`正在解压「${entry.name}」…`);
      try {
        await sftpExtractArchive(sessionId, archivePath, targetDir);
        await loadDirectory(currentPath);
      } catch (err) {
        setError(`解压失败：${getErrorMessage(err)}`);
      } finally {
        setOpStatus(null);
      }
    },
    [sessionId, currentPath, loadDirectory],
  );

  // 错误横幅在两个分支（正常 / 空状态）里都要渲染。
  // 主要是为了断连态：传输失败、后端拒绝（「会话已断开，任务已跳过」）常常正是
  // 在连接掉线那一刻产生的，早退分支若把它挡在门外，setError 了也永远看不见。
  // 正常分支里它接在列表下方（edge=bottom），理由见列表后的注释。
  const errorBanner = (edge: 'top' | 'bottom') =>
    error ? (
    <div
      className={`flex flex-shrink-0 items-center justify-between border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300 ${
        edge === 'top' ? 'border-b' : 'border-t'
      }`}
    >
      <span className="min-w-0 flex-1 break-words">{error}</span>
      <button
        type="button"
        onClick={() => setError(null)}
        className="ml-2 flex-shrink-0 text-red-400"
        aria-label="关闭错误"
      >
        ✕
      </button>
    </div>
  ) : null;

  if (emptyReason !== 'ready' || !ids) {
    const copy =
      EMPTY_STATE_COPY[emptyReason === 'ready' ? 'no-session' : emptyReason];
    return (
      <div
        className="flex h-full min-h-0 flex-col bg-zinc-950"
        data-region="mobile-files"
      >
        {errorBanner('top')}
        <div
          className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
          style={{ paddingTop: 'max(1rem, env(safe-area-inset-top, 0px))' }}
        >
          <h2 className="text-lg font-semibold text-zinc-100">{copy.title}</h2>
          <p className="text-sm text-zinc-500">{copy.body}</p>
          {activeSession && (
            <p className="text-xs text-zinc-600">
              {sessionStatusLabel(activeSession.status)}
            </p>
          )}
        </div>
      </div>
    );
  }

  const hostLabel =
    resolveSessionDisplayName(activeSession, connections) || '文件';
  const listLoadingMode = filesListLoadingMode(loading, entries.length);

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-zinc-950"
      data-region="mobile-files"
    >
      <header
        className="flex flex-shrink-0 flex-col gap-2 border-b border-edge-subtle bg-zinc-950 px-3 py-2"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-zinc-100">
              {hostLabel}
            </div>
            <div className="text-[11px] text-emerald-400">已连接 · 文件</div>
          </div>
          <button
            type="button"
            onClick={handleToggleHidden}
            className={`rounded-lg px-2.5 py-1.5 text-xs active:opacity-80 ${
              showHidden
                ? 'bg-indigo-600/30 text-indigo-200'
                : 'bg-zinc-800 text-zinc-200 active:bg-state-mid'
            }`}
            aria-label={showHidden ? '隐藏点文件' : '显示点文件'}
            aria-pressed={showHidden}
            title={showHidden ? '隐藏点文件' : '显示点文件'}
          >
            {showHidden ? '隐藏.' : '显示.'}
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading}
            className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 active:bg-state-mid disabled:opacity-50"
            aria-label="刷新"
          >
            刷新
          </button>
          <button
            type="button"
            onClick={() => void handleUpload()}
            disabled={uploadBusy}
            className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white active:bg-indigo-500 disabled:opacity-50"
          >
            上传
          </button>
          <button
            type="button"
            onClick={() => setShowNewMenu(true)}
            className="rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 active:bg-state-mid"
          >
            新建
          </button>
          <button
            type="button"
            onClick={() => {
              if (selectMode) exitSelectMode();
              else enterSelectMode();
            }}
            className={`rounded-lg px-2.5 py-1.5 text-xs active:opacity-80 ${
              selectMode
                ? 'bg-indigo-600/30 text-indigo-200'
                : 'bg-zinc-800 text-zinc-200 active:bg-state-mid'
            }`}
            aria-pressed={selectMode}
          >
            {selectMode ? '完成' : '选择'}
          </button>
        </div>

        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            onClick={handleGoUp}
            disabled={currentPath === '/'}
            className="flex-shrink-0 rounded-md bg-zinc-800/80 px-2 py-1 text-xs text-zinc-300 active:bg-state-mid disabled:opacity-30"
            aria-label="上级目录"
          >
            ↑
          </button>
          <MobilePathBar currentPath={currentPath} onNavigate={navigateTo} />
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {listLoadingMode === 'empty' ? (
          <div
            className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-zinc-500"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
            <span>加载中…</span>
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-zinc-500">
            空目录
          </div>
        ) : (
          <ul className="divide-y divide-edge-subtle/80">
            {filteredEntries.map((entry) => {
              const selected = selectMode && multiSelected.has(entry.name);
              return (
                <li
                  key={`${entry.is_dir ? 'd' : 'f'}:${entry.name}`}
                  className={`flex items-center pr-1 ${
                    selected ? 'bg-indigo-500/10' : ''
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleEntryTap(entry)}
                    onContextMenu={(e) => {
                      // 长按：进入选择模式并勾选该条目；已在选择模式则切换勾选
                      e.preventDefault();
                      if (selectMode) {
                        setMultiSelected((prev) =>
                          toggleSelectionName(prev, entry.name),
                        );
                      } else {
                        enterSelectMode(entry);
                      }
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left active:bg-zinc-900"
                  >
                    {selectMode && (
                      <span
                        className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border ${
                          selected
                            ? 'border-indigo-500 bg-indigo-500 text-white'
                            : 'border-edge-strong bg-zinc-800 text-transparent'
                        }`}
                        aria-hidden
                      >
                        <svg
                          className="h-3 w-3"
                          viewBox="0 0 12 12"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M2 6l3 3 5-5" />
                        </svg>
                      </span>
                    )}
                    <FileEntryIcon entry={entry} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-zinc-100">
                        {entry.name}
                        {entry.is_dir ? '/' : ''}
                      </span>
                      <span className="block text-[11px] text-zinc-500">
                        {entrySubtitle(entry)}
                      </span>
                    </span>
                  </button>
                  {!selectMode && (
                    <button
                      type="button"
                      onClick={() => {
                        setActionEntry(entry);
                        setActionOpen(true);
                      }}
                      className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-zinc-500 active:bg-state-soft"
                      aria-label={`${entry.name} 的更多操作`}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {listLoadingMode === 'overlay' && (
          <div
            className="pointer-events-none absolute inset-0 flex items-start justify-center bg-zinc-950/40 pt-10"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="flex items-center gap-2 rounded-full border border-edge/80 bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-300 shadow-lg">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-400" />
              刷新中…
            </div>
          </div>
        )}
      </div>

      {/*
        进度、提示、选择操作条一律接在列表**下方**：它们随时会冒出来（传输完成、
        长按进选择模式），放在列表上方就会把列表整体往下顶，手指正要点的那一行
        跑掉。接在下方只是列表底边上移，屏幕上已有的行一动不动。
      */}
      {opStatus && (
        <div
          className="flex flex-shrink-0 items-center gap-2 border-t border-edge-subtle bg-zinc-900/80 px-3 py-2 text-xs text-zinc-300"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-indigo-400" />
          <span className="min-w-0 flex-1 truncate">{opStatus}</span>
        </div>
      )}

      {clipboard && !opStatus && (
        <div className="flex flex-shrink-0 items-center gap-2 border-t border-edge-subtle bg-zinc-900/80 px-3 py-2 text-xs text-zinc-300">
          <span className="min-w-0 flex-1 truncate">
            {clipboardLabel(clipboard)}
          </span>
          <button
            type="button"
            onClick={() => void handlePaste()}
            disabled={pasteBlocked != null}
            className="flex-shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs text-white active:bg-indigo-500 disabled:opacity-40"
          >
            粘贴到此处
          </button>
          <button
            type="button"
            onClick={() => useFileClipboardStore.getState().clear()}
            className="flex-shrink-0 px-1 text-zinc-500"
            aria-label="清空剪贴板"
          >
            ✕
          </button>
        </div>
      )}

      {pasteBlocked != null && clipboard && (
        <div className="flex-shrink-0 border-t border-edge-subtle bg-zinc-900/80 px-3 py-1.5 text-[11px] text-amber-300/90">
          {pasteBlocked}
        </div>
      )}

      {pasteNotice && (
        <div className="flex flex-shrink-0 items-center gap-2 border-t border-edge-subtle bg-zinc-900/80 px-3 py-2 text-xs text-amber-300">
          <span className="min-w-0 flex-1 break-all">{pasteNotice}</span>
          <button
            type="button"
            onClick={() => setPasteNotice(null)}
            className="flex-shrink-0 px-1 text-zinc-500"
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      )}

      {completion && (
        <div className="flex flex-shrink-0 items-center gap-2 border-t border-edge-subtle bg-zinc-900/80 px-3 py-2 text-xs text-zinc-300">
          <span className="min-w-0 flex-1 break-all">
            {transferCompletionNotice(completion).text}
          </span>
          <button
            type="button"
            onClick={() => {
              void writeText(transferCompletionNotice(completion).path).catch(
                (err) => setError(`复制路径失败：${getErrorMessage(err)}`),
              );
            }}
            className="flex-shrink-0 rounded-lg bg-zinc-700 px-2.5 py-1.5 text-xs text-zinc-100 active:bg-state-strong"
          >
            复制路径
          </button>
          <button
            type="button"
            onClick={() => setCompletion(null)}
            className="flex-shrink-0 px-1 text-zinc-500"
            aria-label="关闭完成提示"
          >
            ✕
          </button>
        </div>
      )}

      {errorBanner('bottom')}

      <MobileTransferBars />

      {selectMode && (
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-t border-edge-subtle bg-zinc-900/80 px-3 py-2">
          <span className="flex-shrink-0 whitespace-nowrap text-xs text-zinc-300">
            已选 {multiSelected.size} 个
          </span>
          <button
            type="button"
            onClick={() => {
              if (multiSelected.size === filteredEntries.length) {
                setMultiSelected(new Set());
              } else {
                setMultiSelected(
                  new Set(filteredEntries.map((e) => e.name)),
                );
              }
            }}
            className="rounded-lg bg-zinc-700 px-2.5 py-1.5 text-xs text-zinc-100 active:bg-state-strong"
          >
            {multiSelected.size === filteredEntries.length &&
            filteredEntries.length > 0
              ? '全不选'
              : '全选'}
          </button>
          {/* 单选一个条目时补上单项操作（对齐桌面右键菜单的压缩为 / 重命名）。 */}
          {soleSelected && (
            <>
              <button
                type="button"
                onClick={() => {
                  setRenameEntry(soleSelected);
                  setRenameValue(soleSelected.name);
                  exitSelectMode();
                }}
                className="rounded-lg bg-zinc-700 px-2.5 py-1.5 text-xs text-zinc-100 active:bg-state-strong"
              >
                重命名
              </button>
              {soleSelected.is_dir && (
                <button
                  type="button"
                  onClick={() => {
                    setCompressEntry(soleSelected);
                    exitSelectMode();
                  }}
                  className="rounded-lg bg-zinc-700 px-2.5 py-1.5 text-xs text-zinc-100 active:bg-state-strong"
                >
                  压缩
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() =>
              handleClip(
                filteredEntries.filter((e) => multiSelected.has(e.name)),
                false,
              )
            }
            disabled={multiSelected.size === 0}
            className="rounded-lg bg-zinc-700 px-2.5 py-1.5 text-xs text-zinc-100 active:bg-state-strong disabled:opacity-40"
          >
            复制
          </button>
          <button
            type="button"
            onClick={() =>
              handleClip(
                filteredEntries.filter((e) => multiSelected.has(e.name)),
                true,
              )
            }
            disabled={multiSelected.size === 0}
            className="rounded-lg bg-zinc-700 px-2.5 py-1.5 text-xs text-zinc-100 active:bg-state-strong disabled:opacity-40"
          >
            剪切
          </button>
          <button
            type="button"
            onClick={() =>
              void handleCopyPaths(
                filteredEntries.filter((e) => multiSelected.has(e.name)),
              )
            }
            disabled={multiSelected.size === 0}
            className="rounded-lg bg-zinc-700 px-2.5 py-1.5 text-xs text-zinc-100 active:bg-state-strong disabled:opacity-40"
          >
            复制路径
          </button>
          <button
            type="button"
            onClick={() =>
              setDeleteConfirm(
                filteredEntries.filter((e) => multiSelected.has(e.name)),
              )
            }
            disabled={multiSelected.size === 0 || opStatus != null}
            className="rounded-lg bg-red-900/50 px-2.5 py-1.5 text-xs text-red-300 active:bg-red-900/80 disabled:opacity-40"
          >
            删除
          </button>
          <button
            type="button"
            onClick={exitSelectMode}
            className="rounded-lg bg-zinc-700 px-2.5 py-1.5 text-xs text-zinc-400 active:bg-state-strong"
          >
            取消
          </button>
        </div>
      )}

      <MobileSheet
        open={actionOpen}
        onClose={() => setActionOpen(false)}
        title={actionEntry ? actionEntry.name : ''}
      >
        {actionEntry && (
          <div className="flex flex-col gap-2 px-4 pb-4">
            {canOpenEntry(actionEntry) &&
              openFileKind(actionEntry.name) !== 'binary' && (
                <SheetAction
                  onClick={() => {
                    setActionOpen(false);
                    openFile(actionEntry);
                  }}
                >
                  打开
                </SheetAction>
              )}
            {!actionEntry.is_dir && (
              <SheetAction
                disabled={downloadBusy}
                onClick={() => {
                  setActionOpen(false);
                  void handleDownload(actionEntry);
                }}
              >
                下载
              </SheetAction>
            )}
            {!actionEntry.is_dir && isArchiveFile(actionEntry.name) && (
              <SheetAction
                onClick={() => {
                  setActionOpen(false);
                  setExtractEntry(actionEntry);
                }}
              >
                解压
              </SheetAction>
            )}
            {actionEntry.is_dir && (
              <SheetAction
                onClick={() => {
                  setActionOpen(false);
                  setCompressEntry(actionEntry);
                }}
              >
                压缩
              </SheetAction>
            )}
            <SheetAction
              onClick={() => {
                setActionOpen(false);
                setRenameEntry(actionEntry);
                setRenameValue(actionEntry.name);
              }}
            >
              重命名
            </SheetAction>
            <SheetAction
              onClick={() => {
                setActionOpen(false);
                handleClip([actionEntry], false);
              }}
            >
              复制
            </SheetAction>
            <SheetAction
              onClick={() => {
                setActionOpen(false);
                handleClip([actionEntry], true);
              }}
            >
              剪切
            </SheetAction>
            {actionEntry.is_dir && clipboard && (
              <SheetAction
                disabled={pasteBlocked != null}
                onClick={() => {
                  setActionOpen(false);
                  void handlePaste(joinRemotePath(currentPath, actionEntry.name));
                }}
              >
                粘贴到此文件夹
              </SheetAction>
            )}
            <SheetAction
              onClick={() => {
                setActionOpen(false);
                void handleCopyPaths([actionEntry]);
              }}
            >
              复制路径
            </SheetAction>
            <SheetAction
              danger
              onClick={() => {
                setActionOpen(false);
                setDeleteConfirm([actionEntry]);
              }}
            >
              删除
            </SheetAction>
            <button
              type="button"
              onClick={() => setActionOpen(false)}
              className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-state-soft"
            >
              取消
            </button>
          </div>
        )}
      </MobileSheet>

      <MobileSheet
        open={showNewFolder}
        onClose={() => setShowNewFolder(false)}
        title="新建文件夹"
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowNewFolder(false)}
              className="flex-1 rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300 active:bg-state-mid"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleMkdir()}
              disabled={!newFolderName.trim()}
              className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-40"
            >
              创建
            </button>
          </div>
        }
      >
        <div className="px-4 pb-3">
          <input
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleMkdir();
            }}
            placeholder="文件夹名称"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-lg border border-edge bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500"
            autoFocus
          />
        </div>
      </MobileSheet>

      <MobileSheet
        open={deleteConfirm.length > 0}
        onClose={() => setDeleteConfirm([])}
        title={
          deleteConfirm.length > 1
            ? `确认删除 ${deleteConfirm.length} 个条目`
            : '确认删除'
        }
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          {deleteConfirm.length === 1 ? (
            <p className="break-all pb-1 text-sm text-zinc-400">
              删除 {deleteConfirm[0].is_dir ? '目录' : '文件'}「
              {deleteConfirm[0].name}
              」？此操作不可撤销。
            </p>
          ) : (
            <div className="max-h-40 overflow-y-auto pb-1 text-sm text-zinc-400">
              {deleteConfirm.slice(0, 10).map((e) => (
                <p key={e.name} className="break-all text-zinc-200">
                  {e.name}
                  {e.is_dir ? '/' : ''}
                </p>
              ))}
              {deleteConfirm.length > 10 && (
                <p className="text-zinc-500">
                  等 {deleteConfirm.length} 个条目…
                </p>
              )}
              <p className="pt-1">此操作不可撤销。</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => void runDelete(deleteConfirm, false)}
            className="rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white active:bg-red-500"
          >
            删除
          </button>
          {canQuickDelete(deleteConfirm) && (
            <button
              type="button"
              onClick={() => void runDelete(deleteConfirm, true)}
              className="rounded-xl bg-zinc-800 px-4 py-3 text-left active:bg-state-mid"
            >
              <span className="block text-sm font-medium text-red-400">
                快速删除
              </span>
              <span className="mt-0.5 block text-xs text-zinc-500">
                打包成一条 rm 命令执行，大目录更快
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setDeleteConfirm([])}
            className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-state-soft"
          >
            取消
          </button>
        </div>
      </MobileSheet>

      <MobileSheet
        open={showNewMenu}
        onClose={() => setShowNewMenu(false)}
        title="新建"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <button
            type="button"
            onClick={() => {
              setShowNewMenu(false);
              setNewFolderName('');
              setShowNewFolder(true);
            }}
            className="rounded-xl bg-zinc-800 px-4 py-3 text-left text-sm text-zinc-100 active:bg-state-mid"
          >
            新建文件夹
          </button>
          <button
            type="button"
            onClick={() => {
              setShowNewMenu(false);
              setNewFileName('');
              setShowNewFile(true);
            }}
            className="rounded-xl bg-zinc-800 px-4 py-3 text-left text-sm text-zinc-100 active:bg-state-mid"
          >
            新建文件
          </button>
          <button
            type="button"
            onClick={() => setShowNewMenu(false)}
            className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-state-soft"
          >
            取消
          </button>
        </div>
      </MobileSheet>

      <MobileSheet
        open={showNewFile}
        onClose={() => setShowNewFile(false)}
        title="新建文件"
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowNewFile(false)}
              className="flex-1 rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300 active:bg-state-mid"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleMkfile()}
              disabled={!newFileName.trim()}
              className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-40"
            >
              创建
            </button>
          </div>
        }
      >
        <div className="px-4 pb-3">
          <input
            type="text"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleMkfile();
            }}
            placeholder="文件名称"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-lg border border-edge bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500"
            autoFocus
          />
        </div>
      </MobileSheet>

      <MobileSheet
        open={extractEntry != null}
        onClose={() => setExtractEntry(null)}
        title="解压文件"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className="break-all pb-1 text-sm text-zinc-400">
            将「{extractEntry?.name}」解压到{' '}
            <span className="text-zinc-300">{currentPath}</span>
            ，选择解压位置：
          </p>
          <button
            type="button"
            onClick={() => {
              if (!extractEntry) return;
              const stem = archiveStem(extractEntry.name);
              void handleExtract(
                extractEntry,
                joinRemotePath(currentPath, stem),
              );
            }}
            className="rounded-xl bg-zinc-800 px-4 py-3 text-left active:bg-state-mid"
          >
            <span className="block text-sm font-medium text-zinc-100">
              解压到同名子文件夹
            </span>
            <span className="mt-0.5 block break-all text-xs text-zinc-500">
              在当前目录下创建「
              {extractEntry ? archiveStem(extractEntry.name) : ''}
              」文件夹并解压到其中
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              if (!extractEntry) return;
              void handleExtract(extractEntry, currentPath);
            }}
            className="rounded-xl bg-zinc-800 px-4 py-3 text-left active:bg-state-mid"
          >
            <span className="block text-sm font-medium text-zinc-100">
              解压到当前目录
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              直接解压到当前目录，保留压缩包内部结构
            </span>
          </button>
          <button
            type="button"
            onClick={() => setExtractEntry(null)}
            className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-state-soft"
          >
            取消
          </button>
        </div>
      </MobileSheet>

      {compressEntry && (
        <MobileCompressSheet
          open={!!compressEntry}
          sessionId={sessionId}
          remoteDir={joinRemotePath(currentPath, compressEntry.name)}
          onClose={() => setCompressEntry(null)}
          onCompressed={() => {
            void loadDirectory(currentPath);
          }}
        />
      )}

      <MobileSheet
        open={renameEntry != null}
        onClose={() => setRenameEntry(null)}
        title="重命名"
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRenameEntry(null)}
              className="flex-1 rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300 active:bg-state-mid"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleRename()}
              disabled={!renameValue.trim()}
              className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-40"
            >
              确定
            </button>
          </div>
        }
      >
        <div className="px-4 pb-3">
          <input
            type="text"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRename();
            }}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-lg border border-edge bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            autoFocus
          />
        </div>
      </MobileSheet>

      {editorFile && (
        <MobileFileEditor
          open={!!editorFile}
          sessionId={sessionId}
          filePath={editorFile.path}
          fileName={editorFile.name}
          fileSize={editorFile.size}
          onClose={() => setEditorFile(null)}
          onSaved={() => {
            void loadDirectory(currentPath);
          }}
        />
      )}

      {previewFile && (
        <MobileImageViewer
          key={`${sessionId}:${previewFile.path}`}
          open={!!previewFile}
          source={{ kind: 'sftp', sessionId, filePath: previewFile.path }}
          fileName={previewFile.name}
          fileSize={previewFile.size}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  );
}

function TransferBar({
  statusText,
  written,
  total,
  onCancel,
}: {
  statusText: string;
  written: number;
  total: number;
  onCancel?: () => void;
}) {
  const pct = transferProgressPercent(written, total);
  return (
    <div className="flex flex-shrink-0 flex-col gap-1 border-t border-edge-subtle bg-zinc-900/80 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
          {statusText}
        </span>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="flex-shrink-0 rounded-md bg-zinc-700/60 px-2 py-0.5 text-xs text-zinc-300"
          >
            取消
          </button>
        )}
      </div>
      {total > 0 && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-700">
          <div
            className="h-full origin-left rounded-full bg-indigo-500 transition-transform duration-200 ease-linear motion-reduce:transition-none"
            style={{ width: '100%', transform: `scaleX(${pct / 100})` }}
          />
        </div>
      )}
    </div>
  );
}

/** 条目操作面板里的一项，与本页其它面板（新建、解压）的选项同一个样子。 */
function SheetAction({
  children,
  danger = false,
  disabled = false,
  onClick,
}: {
  children: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl bg-zinc-800 px-4 py-3 text-left text-sm active:bg-state-mid disabled:opacity-40 ${
        danger ? 'text-red-400' : 'text-zinc-100'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 顶部传输条（上传/下载各一条）：自己订阅活动条目。
 *
 * 进度每个 tick 都会替换条目对象引用——订阅放在这里，进度更新只重渲染
 * 这一小块；宿主（MobileFilesHost）只订阅「有无活动传输」的布尔，整页
 * 文件列表不再随传输进度调和。抽离本身不改渲染内容与交互。
 */
function MobileTransferBars() {
  const uploadItem = useTransferStore((s) => selectActiveOf(s, 'upload'));
  const downloadItem = useTransferStore((s) => selectActiveOf(s, 'download'));
  return (
    <>
      {uploadItem && (
        <TransferBar
          statusText={uploadItem.statusText}
          written={uploadItem.written}
          total={uploadItem.total}
          onCancel={
            uploadItem.status === 'active' && uploadItem.phase !== 'extracting'
              ? () => cancelTransfer(uploadItem.id)
              : undefined
          }
        />
      )}
      {downloadItem && (
        <TransferBar
          statusText={downloadItem.statusText}
          written={downloadItem.written}
          total={downloadItem.total}
          onCancel={
            downloadItem.status === 'active'
              ? () => cancelTransfer(downloadItem.id)
              : undefined
          }
        />
      )}
    </>
  );
}
