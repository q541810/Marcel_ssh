import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, FolderPlus, FilePlus, Upload, FolderUp, Eye, EyeOff, RefreshCw, PanelLeft, Folder, Link2, File as FileIcon, FolderOpen } from 'lucide-react';
import { stat } from '@tauri-apps/plugin-fs';
import { useSettingsStore } from '@/stores/settingsStore';
import { sftpListDir, sftpOpenWithSystem, sftpHomeDir } from '@/lib/tauri';
import type { SftpFileEntry } from '@/lib/types';
import { resolveHomeFallback } from '@/lib/sftpHomeFallback';
import { formatSize, modeToString, getErrorMessage, isDialogCancelled, isPreviewableImage } from '@/lib/sftp-helpers';
import { decideOpen, joinRemotePath, sortFileEntries, type OpenIntent } from '@/lib/sftpFileOpen';
import { flashElement } from '@/lib/flashElement';
import { useMenuViewportFit } from '@/hooks/useMenuViewportFit';
import { cdInTerminal } from '@/lib/fileNav';
import { useFileNavStore } from '@/stores/fileNavStore';
import { loadRememberedPath, rememberPath } from '@/lib/fileManagerPathMemory';
import { isArchiveFile, archiveStem } from '@/lib/constants';
import PathBreadcrumb from './PathBreadcrumb';
import FileTreeSidebar from './FileTreeSidebar';
import {
  clampTreeWidth,
  normalizeRemotePath,
  FILE_TREE_ANIM_MS,
  FILE_TREE_DEFAULT_WIDTH,
  FILE_TREE_MAX_WIDTH,
  FILE_TREE_MIN_WIDTH,
  FILE_TREE_SHOW_THRESHOLD,
} from './fileTreeModel';
import { useSftpUpload } from '@/hooks/useSftpUpload';
import { useSftpDownload } from '@/hooks/useSftpDownload';
import { useTransferStore, type TransferItem } from '@/stores/transferStore';
import { createTransferId } from '@/stores/transferScheduler';
import { flyToTransferCenter } from '@/stores/transferFlyAnimation';
import { useFileDrop, type DropPosition } from '@/hooks/useFileDrop';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { useFileTree } from '@/hooks/useFileTree';
import FileEditorModal from './FileEditorModal';
import ImagePreviewModal from './ImagePreviewModal';
import CompressModal from './CompressModal';
import { useFileClipboardStore } from '@/stores/fileClipboardStore';
import { clipboardLabel, pasteBlockedReason } from '@/lib/filePaste';
import ContextMenu, { type ContextMenuItem } from '@/components/ui/ContextMenu';
import {
  parentDir,
  targetFromEntry,
  targetFromTreePath,
  terminalDirOf,
  type FileTarget,
} from './fileActionModel';
import { useFileActions } from './useFileActions';
import { resolveTreeDropTarget, type TreeDropTarget } from './fileTreeDrop';

interface FileManagerPanelProps {
  sessionId: string;
  connectionKey: string;
}

export default function FileManagerPanel({ sessionId, connectionKey }: FileManagerPanelProps) {
  // 订阅收窄到真正参与渲染的两个字段：订阅整份 settings 时，字号手势的
  // preview tick、主题切换等任何设置更新都会把整张文件表重渲染一遍。
  // 只在初始化读一次的字段（旧版路径记忆、显示隐藏的初值、树宽初值）改
  // 从 getState 取，不占订阅。
  const treeUserHiddenSetting = useSettingsStore(
    (s) => s.settings.fileManagerTreeUserHidden ?? false,
  );
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const [currentPath, setCurrentPath] = useState(() =>
    loadRememberedPath(connectionKey, useSettingsStore.getState().settings),
  );
  const [history, setHistory] = useState<string[]>(['/']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [entries, setEntries] = useState<SftpFileEntry[]>([]);
  /** entries 对应的目录（列目录成功时与 entries 同批更新）：定位文件要等「这个目录的列表」到了才行。 */
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  /** agent 链接请求定位的条目，列表到位后设为焦点（持久高亮）并闪一下。 */
  const [revealTarget, setRevealTarget] = useState<{ dir: string; name: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 拖拽打包上传的**部分失败**提示。单独一份状态、不被 loadDirectory 的
   * `setError(null)` 清掉：上传完成后的刷新若把它抹了，用户就再也看不到
   * 「哪几项没传上去」，只会看到传输中心一句「上传完成」。
   */
  const [dropWarning, setDropWarning] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(
    () => useSettingsStore.getState().settings.fileManagerShowHidden ?? false,
  );
  const [menuEntry, setMenuEntry] = useState<SftpFileEntry | null>(null);
  const [menuTargets, setMenuTargets] = useState<SftpFileEntry[]>([]);
  /** 目录树右键菜单：锚点 + 被指的目录。 */
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number; target: FileTarget } | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [deleteConfirm, setDeleteConfirm] = useState<FileTarget[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /**
   * 当前焦点条目（文件管理器里「点一下选中」的那一行，单选高亮）。与上面的 `selected`（勾选、批量操作）
   * 是两回事：agent 链接「在文件管理中显示」只是把这一行标出来，不能让用户突然进入「已选 1 个」的
   * 批量模式。点列表空白处 / 点别的行 / 换目录 / 勾选任何一行时清掉。
   */
  const [focusedName, setFocusedName] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileTarget | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  /** 新建文件夹要建在哪个目录下：工具栏 = 当前目录，目录树右键 = 被点的节点。 */
  const [newFolderDir, setNewFolderDir] = useState('/');
  const [newFileName, setNewFileName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);
  const [editorFile, setEditorFile] = useState<{ path: string; name: string; size: number } | null>(null);
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string; size: number } | null>(null);
  const [pendingDropFiles, setPendingDropFiles] = useState<{ paths: string[]; destDir: string } | null>(null);
  const [pendingFolderUpload, setPendingFolderUpload] = useState<{
    localPath: string;
    folderName: string;
    destDir: string;
  } | null>(null);
  const [extractConfirm, setExtractConfirm] = useState<FileTarget | null>(null);
  const [compressEntry, setCompressEntry] = useState<FileTarget | null>(null);
  /** 远端主目录（目录树顶部的快捷项）；取不到就不显示。 */
  const [homePath, setHomePath] = useState<string | null>(null);
  /** 本机文件拖拽时悬停的目录树节点。 */
  const [treeDropHover, setTreeDropHover] = useState<TreeDropTarget>({ kind: 'outside' });
  const dropHoverPath = treeDropHover.kind === 'row' ? treeDropHover.path : null;
  const clipboard = useFileClipboardStore((s) => s.clipboard);
  const [pasteStatus, setPasteStatus] = useState<string | null>(null);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const pasteBlocked = pasteBlockedReason(clipboard, sessionId);
  const menuRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const treeRegionRef = useRef<HTMLDivElement>(null);
  const loadSeqRef = useRef(0);
  /** 当前目录的最新值：传输完成等**迟到回调**要据此判断自己捕获的路径是否还有效。 */
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const toolbarWidth = useContainerWidth(toolbarRef);
  const panelWidth = useContainerWidth(panelRef);
  const mode = toolbarWidth >= 870 ? 'full' : toolbarWidth >= 750 ? 'compact' : 'icon-only';

  const treeUserHidden = treeUserHiddenSetting;
  const treeFits = panelWidth >= FILE_TREE_SHOW_THRESHOLD;
  const showTree = treeFits && !treeUserHidden;

  const persistTreeWidth = useCallback((w: number) => {
    useSettingsStore.getState().update({ fileManagerTreeWidth: clampTreeWidth(w) });
  }, []);

  const {
    width: treeWidth,
    isResizing: isTreeResizing,
    startResize: startTreeResize,
    setWidth: setTreeWidth,
  } = useResizablePanel({
    initialWidth: clampTreeWidth(
      useSettingsStore.getState().settings.fileManagerTreeWidth ?? FILE_TREE_DEFAULT_WIDTH,
    ),
    minWidth: FILE_TREE_MIN_WIDTH,
    maxWidth: FILE_TREE_MAX_WIDTH,
    edge: 'left',
    onChange: persistTreeWidth,
  });

  useEffect(() => {
    if (!settingsLoaded) return;
    setTreeWidth(clampTreeWidth(useSettingsStore.getState().settings.fileManagerTreeWidth ?? FILE_TREE_DEFAULT_WIDTH));
  }, [settingsLoaded, setTreeWidth]);

  const {
    cache: treeCache,
    expanded: treeExpanded,
    selectedPath: treeSelectedPath,
    toggleExpand: toggleTreeExpand,
    loadNode: loadTreeNode,
    seedFromListing: seedTreeFromListing,
    expandPath: expandTreePath,
    reloadNode: reloadTreeNode,
    invalidate: invalidateTree,
  } = useFileTree({
    sessionId,
    showHidden,
    currentPath,
  });

  const toggleTreeUserHidden = useCallback(() => {
    const next = !useSettingsStore.getState().settings.fileManagerTreeUserHidden;
    useSettingsStore.getState().update({ fileManagerTreeUserHidden: next });
  }, []);

  // 起始目录（默认 `/` 或上次记住的）读不了时改去家目录，每个会话只兜一次。
  const initialPathRef = useRef(currentPath);
  const homeTriedRef = useRef<string | null>(null);

  // 主目录快捷项：首次列目录成功后才去问一次（起始目录读不了时兜底已经问过，直接复用）。
  const homeRequestedRef = useRef(false);
  const ensureHomePath = useCallback(() => {
    if (homeRequestedRef.current) return;
    homeRequestedRef.current = true;
    try {
      void sftpHomeDir(sessionId)
        .then((home) => setHomePath(home || null))
        .catch(() => {});
    } catch {
      // 取不到就不显示快捷项
    }
  }, [sessionId]);

  const loadDirectory = useCallback(async (path: string) => {
    // 迟到的请求不许套在新目录上：传输完成回调捕获的是**发起上传时**的 currentPath，
    // 传大文件夹期间用户可能已经切走。此前只有 loadSeqRef 防乱序，旧路径的刷新是最
    // 后一次请求，于是「路径栏显示新目录、列表却是旧目录内容」——之后按
    // `currentPath + name` 拼路径的删除/重命名会作用到错误的同名条目上（删错文件）。
    if (currentPathRef.current !== path) return;
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setEntries([]);
    setError(null);
    try {
      const items = await sftpListDir(sessionId, path);
      if (seq !== loadSeqRef.current || currentPathRef.current !== path) return;
      setEntries(items);
      setLoadedPath(path);
      // Seed tree: expand of this path needs no second listDir.
      seedTreeFromListing(path, items);
      ensureHomePath();
    } catch (err) {
      if (seq !== loadSeqRef.current || currentPathRef.current !== path) return;
      if (path === initialPathRef.current && homeTriedRef.current !== sessionId) {
        homeTriedRef.current = sessionId;
        const home = await resolveHomeFallback(sessionId, path);
        if (seq !== loadSeqRef.current || currentPathRef.current !== path) return;
        if (home) {
          // 替换而不是新增历史：「后退」不该退回那个读不了的起点。
          initialPathRef.current = home;
          homeRequestedRef.current = true;
          setHomePath(home);
          setHistory([home]);
          setHistoryIndex(0);
          setCurrentPath(home);
          return;
        }
      }
      setError(`加载失败：${getErrorMessage(err)}`);
    } finally {
      if (seq === loadSeqRef.current && currentPathRef.current === path) {
        setLoading(false);
      }
    }
  }, [sessionId, seedTreeFromListing, ensureHomePath]);

  useEffect(() => {
    loadDirectory(currentPath);
    setSelected(new Set());
    setFocusedName(null);
  }, [currentPath, loadDirectory]);

  // 目录记忆走 localStorage（同步、不广播），不再经 settings.update 整份落盘：
  // 每切一次目录就序列化 + fsync + 重扫插件目录 + 广播设置变更，还会让订阅整份
  // settings 的本面板再整表重渲染一次。settings 尚未载入时不写，免得把旧记忆冲成 `/`。
  useEffect(() => {
    if (!settingsLoaded) return;
    rememberPath(connectionKey, currentPath);
  }, [connectionKey, currentPath]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuEntry(null);
        setMenuTargets([]);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 行内右键菜单：整张收进窗口（旧写法在入场动画缩小的尺寸上量，末项「删除」会被切掉）
  useMenuViewportFit(menuRef, menuPos.x, menuPos.y, {
    enabled: menuEntry !== null && menuTargets.length > 0,
  });

  // 把「正在看的目录」发布出去，agent 链接的「复制相对路径」据此给出相对文件管理目录的写法。
  useEffect(() => {
    useFileNavStore.getState().setViewingDir(sessionId, currentPath);
  }, [sessionId, currentPath]);

  const filteredEntries = useMemo(
    () => sortFileEntries(entries, showHidden),
    [entries, showHidden],
  );

  const navigateTo = useCallback((path: string) => {
    setHistory((prev) => {
      const newHistory = prev.slice(0, historyIndex + 1);
      newHistory.push(path);
      return newHistory;
    });
    setHistoryIndex((prev) => prev + 1);
    setCurrentPath(path);
  }, [historyIndex]);

  const handleGoBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setCurrentPath(history[newIndex]);
    }
  }, [history, historyIndex]);

  const handleGoForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      setCurrentPath(history[newIndex]);
    }
  }, [history, historyIndex]);

  /** 按统一决策打开一个文件（双击、右键菜单、agent 链接共用）：预览 / 编辑器 / 说明为什么打不开。 */
  const openFileByPath = (fullPath: string, name: string, size: number, intent: OpenIntent = 'auto') => {
    const decision = decideOpen(name, size, intent);
    if (decision.kind === 'refuse') setError(decision.message);
    else if (decision.kind === 'preview') setPreviewFile({ path: fullPath, name, size });
    else setEditorFile({ path: fullPath, name, size });
  };

  const handleNavigate = (entry: SftpFileEntry) => {
    if (entry.is_dir) {
      navigateTo(joinRemotePath(currentPath, entry.name));
    } else if (entry.is_file) {
      openFileByPath(joinRemotePath(currentPath, entry.name), entry.name, entry.size);
    }
  };

  // agent 链接 / 工具卡发来的「带我去那个文件」：领走本会话的待办，
  // 先导航到所在目录，再打开（编辑器 / 预览）或只是定位。
  const pendingNav = useFileNavStore((s) => s.pending[sessionId]);
  useEffect(() => {
    if (!pendingNav) return;
    const req = useFileNavStore.getState().take(sessionId);
    if (!req) return;
    const name = req.path.slice(req.path.lastIndexOf('/') + 1) || '/';
    const parent = parentDir(req.path);
    if (req.path !== '/') {
      setRevealTarget({ dir: parent, name });
      if (normalizeRemotePath(currentPathRef.current) !== normalizeRemotePath(parent)) navigateTo(parent);
    }
    if (!req.isDir && req.intent !== 'reveal') {
      openFileByPath(req.path, name, req.size, req.intent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNav, sessionId]);

  useEffect(() => {
    if (!revealTarget || loadedPath === null) return;
    if (normalizeRemotePath(loadedPath) !== normalizeRemotePath(revealTarget.dir)) return;
    if (normalizeRemotePath(currentPath) !== normalizeRemotePath(revealTarget.dir)) return;
    const hit = entries.some((e) => e.name === revealTarget.name);
    setRevealTarget(null);
    if (!hit) return;
    setFocusedName(revealTarget.name);
    requestAnimationFrame(() => {
      const row = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('[data-file-name]') ?? [],
      ).find((el) => el.dataset.fileName === revealTarget.name);
      if (!row) return;
      row.scrollIntoView?.({ block: 'nearest' });
      flashElement(row);
    });
  }, [revealTarget, loadedPath, entries, currentPath]);

  const handleContextMenu = (e: React.MouseEvent, entry: SftpFileEntry) => {
    e.preventDefault();
    let targets: SftpFileEntry[];
    if (selected.has(entry.name) && selected.size > 1) {
      targets = filteredEntries.filter((en) => selected.has(en.name));
    } else {
      targets = [entry];
    }
    setMenuEntry(entry);
    setMenuTargets(targets);
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const handleDownload = async (entry: SftpFileEntry) => {
    setMenuEntry(null);
    setMenuTargets([]);
    const entryPath = joinRemotePath(currentPath, entry.name);
    try {
      await startDownload(entry, entryPath);
    } catch (err) {
      // Android 上取消保存对话框是 reject 而非返回 null（桌面是返回 null），不当作错误。
      // 此前这里没人接管 promise：保存对话框报错时只有一条未捕获 rejection，界面毫无反馈。
      if (isDialogCancelled(err)) return;
      setError(`下载失败：${getErrorMessage(err)}`);
    }
  };

  const handleOpenWithSystem = async (entry: SftpFileEntry) => {
    setMenuEntry(null);
    setMenuTargets([]);
    const entryPath = joinRemotePath(currentPath, entry.name);

    // 一个 task_id 关联「下载」与「监视回传」两张卡片；id 形如 sysopen-dl-<taskId> / sysopen-ul-<taskId>。
    // 取消任意一条即取消整个任务（见 transferScheduler.cancelTransfer）。
    const taskId = createTransferId();
    const downloadId = `sysopen-dl-${taskId}`;
    const uploadId = `sysopen-ul-${taskId}`;

    const downloadItem: TransferItem = {
      id: downloadId,
      kind: 'download',
      sessionId,
      fileName: entry.name,
      localPath: '',
      remotePath: entryPath,
      written: 0,
      total: entry.size,
      statusText: '准备下载 …',
      createdAt: Date.now(),
    };
    const uploadItem: TransferItem = {
      id: uploadId,
      kind: 'upload',
      sessionId,
      fileName: entry.name,
      localPath: '',
      remotePath: entryPath,
      written: 0,
      total: entry.size,
      statusText: '等待下载完成',
      createdAt: Date.now(),
    };

    // 两条项都直接 active：不进 pump 队列（pump 只调度需主动发起 stream 的任务），
    // 状态由后端 sftp-sysopen-state 事件驱动。
    useTransferStore.getState().addItem(downloadItem);
    useTransferStore.getState().updateItem(downloadId, { status: 'active' });
    useTransferStore.getState().addItem(uploadItem);
    useTransferStore.getState().updateItem(uploadId, { status: 'active' });
    useTransferStore.getState().setOpen(true);

    // 视觉引导：飞一个下载球到传输中心，告诉用户「文件正在下载到这里」。
    // 下载完成、系统应用打开后，后端发 opened 事件时再飞一个上传球，表示「开始监视，改动会回传到这里」。
    flyToTransferCenter('download');

    try {
      const result = await sftpOpenWithSystem(sessionId, entryPath, taskId, downloadId, uploadId);
      if (result.reused) {
        // 文件已在编辑中（旧 task 仍在监视并自动回传）：移除刚建的监视卡片避免重复，
        // 下载卡片标「已重新打开」让用户知道发生了什么，而不是看到一张空白进度卡发懵。
        useTransferStore.getState().removeItem(uploadId);
        useTransferStore.getState().updateItem(downloadId, {
          status: 'done',
          written: entry.size,
          statusText: '已重新打开（仍在编辑中）',
          finishedAt: Date.now(),
        });
      }
    } catch (err) {
      useTransferStore.getState().updateItem(downloadId, {
        status: 'error',
        statusText: `打开失败：${getErrorMessage(err)}`,
        finishedAt: Date.now(),
      });
      useTransferStore.getState().updateItem(uploadId, {
        status: 'error',
        statusText: '打开失败',
        finishedAt: Date.now(),
      });
    }
  };

  const { uploadFile, pickFolder, uploadFolder: doUploadFolder } = useSftpUpload(sessionId, currentPath);
  const { startDownload } = useSftpDownload(sessionId);

  const treeCacheRef = useRef(treeCache);
  treeCacheRef.current = treeCache;

  /**
   * 刷新某个目录：是当前目录就重载右侧列表（loadDirectory 会顺带把结果灌进树），
   * 否则树里已有该节点就重载那个节点。列表与目录树共用的动作都经这一个出口收尾。
   */
  const refreshDir = useCallback(async (dir: string) => {
    const target = normalizeRemotePath(dir);
    if (target === normalizeRemotePath(currentPathRef.current)) {
      await loadDirectory(currentPathRef.current);
    } else if (treeCacheRef.current[target]) {
      reloadTreeNode(target);
    }
  }, [loadDirectory, reloadTreeNode]);

  const actions = useFileActions({
    sessionId,
    getCurrentPath: () => currentPathRef.current,
    refreshDir,
    forgetDir: invalidateTree,
    onCurrentRelocated: (_from, to) => navigateTo(to),
    setError,
    setLoading,
    setPasteNotice,
    setPasteStatus,
    isPasting: () => pasteStatus != null,
    uploadFile,
    uploadFolder: doUploadFolder,
  });

  const closeMenu = () => {
    setMenuEntry(null);
    setMenuTargets([]);
  };

  const entriesToTargets = (list: SftpFileEntry[]) =>
    list.map((e) => targetFromEntry(currentPath, e));

  const handleUpload = async () => {
    closeMenu();
    await actions.pickAndUpload(currentPath);
  };

  const handleUploadFolder = async () => {
    closeMenu();
    try {
      const picked = await pickFolder();
      if (!picked) return;
      setPendingFolderUpload({ ...picked, destDir: currentPath });
    } catch (err) {
      setError(`选择文件夹失败：${getErrorMessage(err)}`);
    }
  };

  const runFolderUpload = (mode: 'folder' | 'flat') => {
    const picked = pendingFolderUpload;
    if (!picked) return;
    setPendingFolderUpload(null);
    actions.uploadFolderTo(picked.localPath, picked.folderName, mode, picked.destDir);
  };

  // 拖拽上传：使用 useFileDrop hook。落点：目录树的目录行 → 上传到该目录；
  // 目录树空白处 → 忽略；其余 → 当前目录。
  const handleFileDrop = useCallback(async (paths: string[], position?: DropPosition) => {
    const treeRect = treeRegionRef.current?.getBoundingClientRect() ?? null;
    const dropTarget = resolveTreeDropTarget(position, treeRect, showTree);
    setTreeDropHover({ kind: 'outside' });
    if (dropTarget.kind === 'blank') return;
    const destDir = dropTarget.kind === 'row' ? dropTarget.path : currentPathRef.current;
    if (paths.length === 1) {
      try {
        const info = await stat(paths[0]);
        if (info.isDirectory) {
          const folderName = paths[0].split(/[/\\]/).pop() || 'upload';
          setPendingFolderUpload({ localPath: paths[0], folderName, destDir });
          return;
        }
      } catch {
        // stat 失败，降级为普通上传
      }
      actions.uploadPaths(paths, destDir);
    } else {
      setPendingDropFiles({ paths, destDir });
    }
  }, [actions, showTree]);

  const handleDragHover = useCallback((position: DropPosition | null) => {
    const next: TreeDropTarget = position
      ? resolveTreeDropTarget(
          position,
          treeRegionRef.current?.getBoundingClientRect() ?? null,
          showTree,
        )
      : { kind: 'outside' };
    setTreeDropHover((prev) =>
      prev.kind === next.kind && (prev.kind !== 'row' || prev.path === (next as { path: string }).path)
        ? prev
        : next,
    );
  }, [showTree]);

  const { isDragging } = useFileDrop(handleFileDrop, true, handleDragHover);

  const handleDelete = (targets: FileTarget[]) => {
    setDeleteConfirm([]);
    closeMenu();
    setSelected(new Set());
    return actions.remove(targets, false);
  };

  const handleQuickDelete = (targets: FileTarget[]) => {
    setDeleteConfirm([]);
    closeMenu();
    setSelected(new Set());
    return actions.remove(targets, true);
  };

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    const target = renameTarget;
    setRenameTarget(null);
    closeMenu();
    await actions.rename(target, renameValue);
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    setShowNewFolder(false);
    const dir = newFolderDir;
    await actions.mkdir(dir, newFolderName);
    // 目录树上新建：让父节点展开，新文件夹立刻可见
    if (normalizeRemotePath(dir) !== normalizeRemotePath(currentPathRef.current)) expandTreePath(dir);
  };

  const openNewFolder = (dir: string) => {
    setNewFolderName('');
    setNewFolderDir(dir);
    setShowNewFolder(true);
  };

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;
    setShowNewFile(false);
    await actions.createFile(currentPath, newFileName);
  };

  const handleCopyPath = async (list: SftpFileEntry[]) => {
    closeMenu();
    await actions.copyPaths(entriesToTargets(list));
  };

  /** 复制 / 剪切：只记进剪贴板，不动远端。 */
  const handleClip = (list: SftpFileEntry[], cut: boolean) => {
    closeMenu();
    actions.clip(entriesToTargets(list), cut);
  };

  /** 粘贴进 destDir（默认当前目录；右键文件夹可粘贴到该文件夹里）。 */
  const handlePaste = async (destDir: string = currentPath) => {
    closeMenu();
    await actions.paste(destDir);
  };

  /** 在终端中打开：目录 cd 进去，文件 cd 到它所在目录。 */
  const handleOpenInTerminal = async (target: FileTarget) => {
    closeMenu();
    const message = await cdInTerminal(sessionId, terminalDirOf(target));
    if (message) setError(message);
  };

  const treeMenuItems = (target: FileTarget): ContextMenuItem[] => {
    const isRoot = target.path === '/';
    const isHomeShortcut = homePath != null && target.path === normalizeRemotePath(homePath);
    const items: ContextMenuItem[] = [
      { label: '复制路径', onClick: () => void actions.copyPaths([target]) },
      { label: '在终端中打开', onClick: () => void handleOpenInTerminal(target) },
      { label: '新建文件夹', onClick: () => openNewFolder(target.path) },
    ];
    if (clipboard) {
      items.push({
        label: '粘贴到此文件夹',
        description: pasteBlocked ?? undefined,
        onClick: () => {
          if (pasteBlocked) setError(pasteBlocked);
          else void actions.paste(target.path);
        },
      });
    }
    if (!isRoot && !isHomeShortcut) {
      items.push(
        { label: '', divider: true, onClick: () => {} },
        {
          label: '重命名',
          onClick: () => {
            setRenameTarget(target);
            setRenameValue(target.name);
          },
        },
        { label: '删除', variant: 'danger', onClick: () => setDeleteConfirm([target]) },
      );
    }
    return items;
  };

  /** 面板内快捷键：Ctrl/⌘ + C / X / V。输入框里放行，免得抢走文字编辑。 */
  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    const key = e.key.toLowerCase();
    if (key === 'c' || key === 'x') {
      const targets = filteredEntries.filter((en) => selected.has(en.name));
      if (targets.length === 0) return;
      e.preventDefault();
      handleClip(targets, key === 'x');
    } else if (key === 'v') {
      if (!clipboard || pasteBlocked) return;
      e.preventDefault();
      void handlePaste();
    }
  };

  // 鼠标侧键：3 = 后退、4 = 前进，与工具栏的前进/后退按钮同一份历史。
  // mousedown/mouseup 都要 preventDefault，否则 WebView 会把侧键当成整页后退。
  const isSideButtonInPanel = (e: React.MouseEvent) => {
    if (e.button !== 3 && e.button !== 4) return false;
    const target = e.target as HTMLElement;
    if (!e.currentTarget.contains(target)) return false;
    return !target.closest('[role="dialog"], [aria-modal="true"]');
  };

  const handlePanelMouseDown = (e: React.MouseEvent) => {
    if (isSideButtonInPanel(e)) e.preventDefault();
  };

  const handlePanelMouseUp = (e: React.MouseEvent) => {
    if (!isSideButtonInPanel(e)) return;
    e.preventDefault();
    if (e.button === 3) handleGoBack();
    else handleGoForward();
  };

  const handleExtract = async (targetDir: string) => {
    const archive = extractConfirm;
    if (!archive) return;
    setExtractConfirm(null);
    await actions.extract(archive, targetDir);
  };

  return (
    <div
      ref={panelRef}
      className="flex flex-col h-full outline-none"
      tabIndex={-1}
      onKeyDown={handlePanelKeyDown}
      onMouseDown={handlePanelMouseDown}
      onMouseUp={handlePanelMouseUp}
    >
      <div ref={toolbarRef} className="flex items-center gap-1 px-3 py-2 flex-shrink-0">
        <button
          type="button"
          onClick={handleGoBack}
          disabled={historyIndex === 0}
          className="h-6 min-w-6 inline-flex items-center justify-center gap-1.5 rounded-md px-1.5 text-body whitespace-nowrap transition-colors pressable focus-ring text-fg-secondary hover:bg-state-soft hover:text-fg disabled:text-fg-disabled disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title="后退"
        >
          <ChevronLeft size={16} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={handleGoForward}
          disabled={historyIndex === history.length - 1}
          className="h-6 min-w-6 inline-flex items-center justify-center gap-1.5 rounded-md px-1.5 text-body whitespace-nowrap transition-colors pressable focus-ring text-fg-secondary hover:bg-state-soft hover:text-fg disabled:text-fg-disabled disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title="前进"
        >
          <ChevronRight size={16} strokeWidth={1.5} />
        </button>
        <PathBreadcrumb currentPath={currentPath} onNavigate={navigateTo} />
        <button
          type="button"
          onClick={() => openNewFolder(currentPath)}
          className="h-6 min-w-6 inline-flex items-center justify-center gap-1.5 rounded-md px-1.5 text-body whitespace-nowrap transition-colors pressable focus-ring text-fg-secondary hover:bg-state-soft hover:text-fg"
          title="新建文件夹"
        >
          {mode !== 'compact' && (
            <FolderPlus size={16} strokeWidth={1.5} />
          )}
          {mode !== 'icon-only' && <span>新建文件夹</span>}
        </button>
        <button
          type="button"
          onClick={() => setShowNewFile(true)}
          className="h-6 min-w-6 inline-flex items-center justify-center gap-1.5 rounded-md px-1.5 text-body whitespace-nowrap transition-colors pressable focus-ring text-fg-secondary hover:bg-state-soft hover:text-fg"
          title="新建文件"
        >
          {mode !== 'compact' && (
            <FilePlus size={16} strokeWidth={1.5} />
          )}
          {mode !== 'icon-only' && <span>新建文件</span>}
        </button>
        <button
          type="button"
          onClick={handleUpload}
          className="h-6 min-w-6 inline-flex items-center justify-center gap-1.5 rounded-md px-1.5 text-body whitespace-nowrap transition-colors pressable focus-ring text-fg-secondary hover:bg-state-soft hover:text-fg"
          title="上传文件"
        >
          {mode !== 'compact' && (
            <Upload size={16} strokeWidth={1.5} />
          )}
          {mode !== 'icon-only' && <span>上传</span>}
        </button>
        <button
          type="button"
          onClick={handleUploadFolder}
          className="h-6 min-w-6 inline-flex items-center justify-center gap-1.5 rounded-md px-1.5 text-body whitespace-nowrap transition-colors pressable focus-ring text-fg-secondary hover:bg-state-soft hover:text-fg"
          title="上传文件夹"
        >
          {mode !== 'compact' && (
            <FolderUp size={16} strokeWidth={1.5} />
          )}
          {mode !== 'icon-only' && <span>上传文件夹</span>}
        </button>
        <button
          type="button"
          onClick={() => {
            const newVal = !showHidden;
            setShowHidden(newVal);
            useSettingsStore.getState().update({ fileManagerShowHidden: newVal });
          }}
          className={`h-6 min-w-6 inline-flex items-center justify-center gap-1.5 rounded-md px-1.5 text-body whitespace-nowrap transition-colors pressable focus-ring ${showHidden ? 'bg-state-selected text-fg' : 'text-fg-secondary hover:bg-state-soft hover:text-fg'}`}
          title="显示隐藏文件"
        >
          {mode !== 'compact' && (
            (showHidden ? <Eye size={16} strokeWidth={1.5} /> : <EyeOff size={16} strokeWidth={1.5} />)
          )}
          {mode !== 'icon-only' && <span>{showHidden ? '隐藏' : '显示'}</span>}
        </button>
        <button
          type="button"
          onClick={() => void loadDirectory(currentPath)}
          disabled={loading}
          className="h-6 min-w-6 inline-flex items-center justify-center gap-1.5 rounded-md px-1.5 text-body whitespace-nowrap transition-colors pressable focus-ring text-fg-secondary hover:bg-state-soft hover:text-fg disabled:text-fg-disabled disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title="刷新"
        >
          {mode === 'icon-only' ? (
            <RefreshCw size={16} strokeWidth={1.5} />
          ) : loading ? (
            '加载中...'
          ) : (
            '刷新'
          )}
        </button>
        {treeFits && (
          <button
            type="button"
            onClick={toggleTreeUserHidden}
            className={`h-6 min-w-6 inline-flex items-center justify-center gap-1.5 rounded-md px-1.5 text-body whitespace-nowrap transition-colors pressable focus-ring ${!treeUserHidden ? 'bg-state-selected text-fg' : 'text-fg-secondary hover:bg-state-soft hover:text-fg'}`}
            title={treeUserHidden ? '显示目录树' : '隐藏目录树'}
          >
            <PanelLeft size={16} strokeWidth={1.5} />
            {mode !== 'icon-only' && <span>目录树</span>}
          </button>
        )}
      </div>

      {showNewFolder && (
        <div className="flex items-center gap-2 border-b border-edge-subtle px-3 py-2 bg-surface-raised/50">
          {normalizeRemotePath(newFolderDir) !== normalizeRemotePath(currentPath) && (
            <span className="max-w-[40%] flex-shrink-0 truncate text-meta text-fg-tertiary" title={newFolderDir}>
              在 {newFolderDir} 下
            </span>
          )}
          <input
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder();
              if (e.key === 'Escape') setShowNewFolder(false);
            }}
            placeholder="新文件夹名称"
            className="flex-1 rounded-md bg-field border border-edge-strong px-2 py-1 text-meta text-fg outline-none focus:border-indigo-500 placeholder:text-fg-tertiary"
            autoFocus
          />
          <button
            type="button"
            onClick={handleCreateFolder}
            className="h-7 rounded-lg bg-indigo-600 px-3 text-body text-white pressable focus-ring hover:bg-indigo-500"
          >
            创建
          </button>
          <button
            type="button"
            onClick={() => setShowNewFolder(false)}
            className="h-7 rounded-lg bg-state-soft px-3 text-body text-fg-secondary hover:bg-state-mid pressable focus-ring"
          >
            取消
          </button>
        </div>
      )}
      {showNewFile && (
        <div className="flex items-center gap-2 border-b border-edge-subtle px-3 py-2 bg-surface-raised/50">
          <input
            type="text"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFile();
              if (e.key === 'Escape') setShowNewFile(false);
            }}
            placeholder="新文件名称"
            className="flex-1 rounded-md bg-field border border-edge-strong px-2 py-1 text-meta text-fg outline-none focus:border-indigo-500 placeholder:text-fg-tertiary"
            autoFocus
          />
          <button
            type="button"
            onClick={handleCreateFile}
            className="h-7 rounded-lg bg-indigo-600 px-3 text-body text-white pressable focus-ring hover:bg-indigo-500"
          >
            创建
          </button>
          <button
            type="button"
            onClick={() => setShowNewFile(false)}
            className="h-7 rounded-lg bg-state-soft px-3 text-body text-fg-secondary hover:bg-state-mid pressable focus-ring"
          >
            取消
          </button>
        </div>
      )}

      {(clipboard || pasteStatus) && (
        <div className="flex items-center gap-2 border-b border-edge-subtle bg-indigo-500/10 px-3 py-1.5 text-meta text-fg-secondary flex-shrink-0">
          <span className="min-w-0 flex-1 truncate">
            {pasteStatus ?? (clipboard ? clipboardLabel(clipboard) : '')}
          </span>
          {!pasteStatus && clipboard && (
            <>
              <button
                type="button"
                onClick={() => void handlePaste()}
                disabled={pasteBlocked != null}
                title={pasteBlocked ?? '粘贴到当前目录（Ctrl+V）'}
                className="h-7 rounded-lg bg-indigo-600 px-3 text-body text-white pressable focus-ring hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600"
              >
                粘贴到此处
              </button>
              <button
                type="button"
                onClick={() => useFileClipboardStore.getState().clear()}
                className="text-fg-tertiary hover:text-fg transition-colors"
                aria-label="清空剪贴板"
              >
                ✕
              </button>
            </>
          )}
        </div>
      )}

      {pasteNotice && (
        <div className="flex items-center justify-between px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-meta text-amber-300 flex-shrink-0">
          <span>{pasteNotice}</span>
          <button type="button" onClick={() => setPasteNotice(null)} className="ml-2 text-amber-400 hover:text-amber-200 transition-colors">✕</button>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between px-3 py-2 bg-red-500/10 border-b border-red-500/20 text-meta text-red-300 flex-shrink-0">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-200 transition-colors">✕</button>
        </div>
      )}

      {dropWarning && (
        <div className="flex items-center justify-between px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-meta text-amber-300 flex-shrink-0">
          <span>{dropWarning}</span>
          <button type="button" onClick={() => setDropWarning(null)} className="ml-2 text-amber-400 hover:text-amber-200 transition-colors">✕</button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex relative">
        <div
          ref={treeRegionRef}
          className={`flex-shrink-0 h-full overflow-hidden ${showTree ? 'border-r border-edge-subtle/80' : 'pointer-events-none'}`}
          style={{
            width: showTree ? treeWidth : 0,
            opacity: showTree ? 1 : 0,
            transition: isTreeResizing
              ? 'none'
              : `width ${FILE_TREE_ANIM_MS}ms ease, opacity ${FILE_TREE_ANIM_MS}ms ease`,
          }}
          aria-hidden={!showTree}
        >
          <div className="flex h-full" style={{ width: treeWidth }}>
            <div className="flex-1 min-w-0 h-full">
              <FileTreeSidebar
                cache={treeCache}
                expanded={treeExpanded}
                selectedPath={treeSelectedPath}
                homePath={homePath}
                contextPath={treeMenu?.target.path ?? null}
                dropHoverPath={dropHoverPath}
                onToggleExpand={toggleTreeExpand}
                onNavigate={navigateTo}
                onRetry={(path) => void loadTreeNode(path, true)}
                onContextMenu={(path, x, y) =>
                  setTreeMenu({ x, y, target: targetFromTreePath(path) })
                }
                onRename={(path) => {
                  const target = targetFromTreePath(path);
                  setRenameTarget(target);
                  setRenameValue(target.name);
                }}
                onDelete={(path) => setDeleteConfirm([targetFromTreePath(path)])}
              />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整目录树宽度"
              onMouseDown={startTreeResize}
              className={`w-1 flex-shrink-0 cursor-col-resize group relative ${
                isTreeResizing ? 'bg-indigo-500/40' : 'hover:bg-indigo-500/25'
              }`}
            >
              <div className="absolute inset-y-0 -left-1 -right-1" />
            </div>
          </div>
        </div>

        <div
          className="flex-1 min-w-0 overflow-auto relative"
          // 点列表里行以外的地方（空白、表头）= 取消焦点高亮；点行由行自己处理
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest('[data-file-name]')) setFocusedName(null);
          }}
        >
          {isDragging && treeDropHover.kind === 'outside' && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-indigo-500/10 border-2 border-dashed border-indigo-400 rounded-lg pointer-events-none">
              <div className="text-center">
                <svg className="w-10 h-10 mx-auto text-indigo-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="text-body text-indigo-300 font-medium">松手上传到当前目录</p>
              </div>
            </div>
          )}

        <table className="w-full text-body table-fixed border-separate border-spacing-0">
          <thead className="sticky top-0 z-10">
            <tr className="text-caption text-fg-tertiary bg-surface">
              <th className="h-7 text-center font-normal w-8">
                <label className="relative inline-flex items-center justify-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.size > 0 && selected.size === filteredEntries.length}
                    onChange={() => {
                      setFocusedName(null);
                      if (selected.size === filteredEntries.length) {
                        setSelected(new Set());
                      } else {
                        setSelected(new Set(filteredEntries.map((e) => e.name)));
                      }
                    }}
                    className={`appearance-none w-3.5 h-3.5 rounded-sm border cursor-pointer ${selected.size > 0 && selected.size === filteredEntries.length ? 'bg-indigo-500 border-indigo-500' : 'bg-state-strong border-edge-strong'}`}
                  />
                  {selected.size > 0 && selected.size === filteredEntries.length && (
                    <svg className="absolute w-2.5 h-2.5 text-white pointer-events-none" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M2 6l3 3 5-5" />
                    </svg>
                  )}
                </label>
              </th>
              <th className="h-7 px-3 text-left font-normal">名称</th>
              <th className="h-7 px-3 text-left font-normal w-24">大小</th>
              <th className="h-7 px-3 text-left font-normal w-28">权限</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="py-3 text-center">
                  <div className="flex flex-col gap-2 px-3" role="status">
                    {[72, 54, 64, 40, 58].map((w, i) => (
                      <div key={i} className="flex h-5 items-center gap-2">
                        <div className="h-4 w-4 rounded-sm bg-state-soft animate-pulse" />
                        <div className="h-3 rounded-sm bg-state-soft animate-pulse" style={{ width: `${w}%` }} />
                      </div>
                    ))}
                    <span className="sr-only">加载中...</span>
                  </div>
                </td>
              </tr>
            ) : (
              filteredEntries.map((entry) => {
              const entryPath = joinRemotePath(currentPath, entry.name);
              const isSelected = selected.has(entry.name);
              const isFocused = focusedName === entry.name && selected.size === 0;
              return (
                <tr
                  key={entryPath}
                  data-file-name={entry.name}
                  aria-selected={isFocused || undefined}
                  className={`h-7 transition-colors cursor-pointer ${
                    isFocused ? 'bg-state-selected' : isSelected ? 'bg-state-selected' : 'hover:bg-state-soft'
                  }`}
                  onDoubleClick={() => handleNavigate(entry)}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      setFocusedName(null);
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(entry.name)) next.delete(entry.name);
                        else next.add(entry.name);
                        return next;
                      });
                    } else {
                      // 普通点击 = 把焦点放到这一行（资源管理器的「选中」），不进入批量选择
                      setFocusedName(entry.name);
                    }
                  }}
                  onContextMenu={(e) => handleContextMenu(e, entry)}
                >
                  <td className="py-0 text-center">
                    <label className="relative inline-flex items-center justify-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {
                          setFocusedName(null);
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(entry.name)) next.delete(entry.name);
                            else next.add(entry.name);
                            return next;
                          });
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className={`appearance-none w-3.5 h-3.5 rounded-sm border cursor-pointer ${isSelected ? 'bg-indigo-500 border-indigo-500' : 'bg-state-strong border-edge-strong'}`}
                      />
                      {isSelected && (
                        <svg className="absolute w-2.5 h-2.5 text-white pointer-events-none" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M2 6l3 3 5-5" />
                        </svg>
                      )}
                    </label>
                  </td>
                  <td className="px-3 py-0 text-fg truncate">
                    <span className="flex items-center gap-2">
                      {entry.is_dir ? (
                        <Folder size={16} strokeWidth={1.5} className="text-amber-500 flex-shrink-0" />
                      ) : entry.is_symlink ? (
                        <Link2 size={16} strokeWidth={1.5} className="text-sky-500 flex-shrink-0" />
                      ) : (
                        <FileIcon size={16} strokeWidth={1.5} className="text-fg-tertiary flex-shrink-0" />
                      )}
                      <span className="truncate">{entry.name}</span>
                    </span>
                  </td>
                  <td className="px-3 py-0 text-meta text-fg-tertiary tabular-nums">{entry.is_dir ? '-' : formatSize(entry.size)}</td>
                  <td className="px-3 py-0 text-meta text-fg-tertiary font-mono tabular-nums">{modeToString(entry.mode)}</td>
                </tr>
              );
            })
            )}
          </tbody>
        </table>

        {filteredEntries.length === 0 && !loading && !error && (
          <div className="flex flex-col items-center gap-3 py-8 text-center text-body text-fg-secondary">
            <FolderOpen size={20} strokeWidth={1.5} className="text-fg-tertiary" />
            <span>{showHidden ? '空目录' : '空目录（可能包含隐藏文件）'}</span>
            <button
              type="button"
              onClick={handleUpload}
              className="h-7 rounded-lg bg-indigo-600 px-3 text-body text-white transition-colors hover:bg-indigo-500 pressable focus-ring"
            >
              上传文件到此处
            </button>
          </div>
        )}

        {selected.size > 0 && (
          <div className="sticky bottom-0 flex items-center justify-between gap-3 px-3 py-2 bg-surface-raised/95 border-t border-edge backdrop-blur-sm">
            <span className="text-meta text-fg-secondary">已选 {selected.size} 个</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleClip(filteredEntries.filter((e) => selected.has(e.name)), false)}
                className="h-7 rounded-lg bg-state-soft px-3 text-body text-fg hover:bg-state-mid transition-colors pressable focus-ring"
              >
                复制
              </button>
              <button
                type="button"
                onClick={() => handleClip(filteredEntries.filter((e) => selected.has(e.name)), true)}
                className="h-7 rounded-lg bg-state-soft px-3 text-body text-fg hover:bg-state-mid transition-colors pressable focus-ring"
              >
                剪切
              </button>
              <button
                type="button"
                onClick={() => {
                  const targets = filteredEntries.filter((e) => selected.has(e.name));
                  handleCopyPath(targets);
                }}
                className="h-7 rounded-lg bg-state-soft px-3 text-body text-fg hover:bg-state-mid transition-colors pressable focus-ring"
              >
                复制路径
              </button>
              <button
                type="button"
                onClick={() => {
                  const targets = filteredEntries.filter((e) => selected.has(e.name));
                  setDeleteConfirm(entriesToTargets(targets));
                }}
                className="h-7 rounded-lg bg-red-900/60 px-3 text-body text-red-300 pressable focus-ring hover:bg-red-900/80 transition-colors"
              >
                删除
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="h-7 rounded-lg bg-state-soft px-3 text-body text-fg-secondary hover:bg-state-mid transition-colors pressable focus-ring"
              >
                取消选择
              </button>
            </div>
          </div>
        )}
        </div>
      </div>

      {menuEntry && menuTargets.length > 0 && createPortal(
        <div
          ref={menuRef}
          className="context-menu-enter surface-glass fixed z-50 w-40 rounded-xl p-1"
          style={{ top: menuPos.y, left: menuPos.x }}
        >
          {menuTargets.length === 1 ? (
            <>
              {menuEntry.is_dir && (
                <>
                  <button
                    type="button"
                    onClick={() => { handleNavigate(menuEntry); setMenuEntry(null); setMenuTargets([]); }}
                    className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCompressEntry(targetFromEntry(currentPath, menuEntry));
                      setMenuEntry(null); setMenuTargets([]);
                    }}
                    className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
                  >
                    压缩为...
                  </button>
                </>
              )}
              {!menuEntry.is_dir && (
                <>
                  {isPreviewableImage(menuEntry.name) ? (
                    <button
                      type="button"
                      onClick={() => {
                        openFileByPath(joinRemotePath(currentPath, menuEntry.name), menuEntry.name, menuEntry.size, 'preview');
                        setMenuEntry(null); setMenuTargets([]);
                      }}
                      className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
                    >
                      预览
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        openFileByPath(joinRemotePath(currentPath, menuEntry.name), menuEntry.name, menuEntry.size, 'editor');
                        setMenuEntry(null); setMenuTargets([]);
                      }}
                      className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
                    >
                      编辑
                    </button>
                  )}
                   <button
                    type="button"
                    onClick={() => handleDownload(menuEntry)}
                    className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
                  >
                    下载
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenWithSystem(menuEntry)}
                    className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
                  >
                    用系统方式打开
                  </button>
                  {isArchiveFile(menuEntry.name) && (
                    <button
                      type="button"
                      onClick={() => {
                        setExtractConfirm(targetFromEntry(currentPath, menuEntry));
                        setMenuEntry(null); setMenuTargets([]);
                      }}
                      className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
                    >
                      解压
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  setRenameTarget(targetFromEntry(currentPath, menuEntry));
                  setRenameValue(menuEntry.name);
                  setMenuEntry(null); setMenuTargets([]);
                }}
                className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
              >
                重命名
              </button>
            </>
          ) : (
            <div className="px-2 py-1.5 text-meta text-fg-secondary">
              已选 {menuTargets.length} 个
            </div>
          )}
          <button
            type="button"
            onClick={() => handleClip(menuTargets, false)}
            className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
          >
            复制
          </button>
          <button
            type="button"
            onClick={() => handleClip(menuTargets, true)}
            className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
          >
            剪切
          </button>
          {clipboard && menuTargets.length === 1 && menuEntry.is_dir && (
            <button
              type="button"
              disabled={pasteBlocked != null}
              title={pasteBlocked ?? undefined}
              onClick={() => void handlePaste(joinRemotePath(currentPath, menuEntry.name))}
              className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft disabled:opacity-40 disabled:hover:bg-transparent"
            >
              粘贴到此文件夹
            </button>
          )}
          <button
            type="button"
            onClick={() => handleCopyPath(menuTargets)}
            className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
          >
            复制路径
          </button>
          {menuTargets.length === 1 && (
            <button
              type="button"
              onClick={() => void handleOpenInTerminal(targetFromEntry(currentPath, menuEntry))}
              className="w-full rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-state-soft"
            >
              {menuEntry.is_dir ? '在终端中打开' : '在终端中打开所在目录'}
            </button>
          )}
          <hr className="border-edge-subtle my-1" />
          <button
            type="button"
            onClick={() => {
              setDeleteConfirm(entriesToTargets(menuTargets));
              setMenuEntry(null); setMenuTargets([]);
            }}
            className="w-full rounded-md px-2 py-1.5 text-left text-body text-red-400 hover:bg-red-950/60"
          >
            删除
          </button>
        </div>,
        document.body,
      )}

      {treeMenu && (
        <ContextMenu
          x={treeMenu.x}
          y={treeMenu.y}
          items={treeMenuItems(treeMenu.target)}
          onClose={() => setTreeMenu(null)}
        />
      )}

      {renameTarget && createPortal(
        <div className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="modal-panel-enter w-80 surface-glass rounded-2xl p-4">
            <h3 className="text-title text-fg mb-3">重命名</h3>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename();
                if (e.key === 'Escape') setRenameTarget(null);
              }}
              className="w-full rounded-md bg-field border border-edge-strong hover:border-fg-tertiary px-2 py-1.5 text-meta text-fg outline-none focus:border-indigo-500 mb-3"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="px-3 py-1.5 rounded-lg text-body text-fg-secondary bg-state-soft hover:bg-state-mid"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleRename}
                className="px-3 py-1.5 rounded-lg text-body text-white bg-indigo-600 hover:bg-indigo-500"
              >
                确认
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {deleteConfirm.length > 0 && createPortal(
        <div className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="modal-panel-enter w-80 surface-glass rounded-2xl p-4">
            <h3 className="text-title text-red-300 mb-2">
              确认删除 {deleteConfirm.length > 1 ? `${deleteConfirm.length} 个文件` : ''}
            </h3>
            {deleteConfirm.length === 1 ? (
              <>
                <p className="text-meta text-fg-secondary mb-1">
                  类型: <span className="text-fg">{deleteConfirm[0].isDir ? '目录' : '文件'}</span>
                </p>
                <p className="text-meta text-fg-secondary mb-4">
                  名称: <span className="text-fg">{deleteConfirm[0].name}</span>
                </p>
              </>
            ) : (
              <div className="text-meta text-fg-secondary mb-4 max-h-40 overflow-auto">
                {deleteConfirm.slice(0, 10).map((e) => (
                  <p key={e.path} className="text-fg">{e.name}</p>
                ))}
                {deleteConfirm.length > 10 && <p className="text-fg-tertiary">等 {deleteConfirm.length} 个文件…</p>}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm([])}
                className="px-3 py-1.5 rounded-lg text-body text-fg-secondary bg-state-soft hover:bg-state-mid"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleDelete(deleteConfirm)}
                className="px-3 py-1.5 rounded-lg text-body text-white bg-red-600 hover:bg-red-500"
              >
                确认删除
              </button>
              {deleteConfirm.length === 1 && deleteConfirm[0].isDir && (
                <button
                  type="button"
                  onClick={() => handleQuickDelete(deleteConfirm)}
                  className="px-3 py-1.5 rounded-lg text-body text-white bg-red-600 hover:bg-red-500"
                >
                  快速删除（打包成rm）
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {editorFile && (
        <FileEditorModal
          open={!!editorFile}
          sessionId={sessionId}
          filePath={editorFile.path}
          fileName={editorFile.name}
          fileSize={editorFile.size}
          onClose={() => setEditorFile(null)}
          onSaved={() => {
            setEditorFile(null);
            loadDirectory(currentPath);
          }}
        />
      )}

      {previewFile && (
        <ImagePreviewModal
          key={`${sessionId}:${previewFile.path}`}
          open={!!previewFile}
          source={{ kind: 'sftp', sessionId, filePath: previewFile.path }}
          fileName={previewFile.name}
          fileSize={previewFile.size}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {compressEntry && (
        <CompressModal
          open={!!compressEntry}
          sessionId={sessionId}
          remoteDir={compressEntry.path}
          onClose={() => setCompressEntry(null)}
          onCompressed={() => {
            const dir = parentDir(compressEntry.path);
            setCompressEntry(null);
            void refreshDir(dir);
            void refreshDir(compressEntry.path);
          }}
        />
      )}

      {/* Upload mode selection dialog for multiple files */}
      {pendingDropFiles && createPortal(
        <div className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="modal-panel-enter w-96 surface-glass rounded-2xl p-4">
            <h3 className="text-title text-fg mb-2">上传多个文件</h3>
            <p className="text-meta text-fg-secondary mb-4">
              检测到 {pendingDropFiles.paths.length} 个文件，上传到 <span className="text-fg-secondary">{pendingDropFiles.destDir}</span>，选择上传方式：
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={async () => {
                  const { paths, destDir } = pendingDropFiles;
                  setPendingDropFiles(null);
                  actions.uploadPaths(paths, destDir);
                }}
                className="w-full px-3 py-2 rounded-lg text-body text-left text-fg-secondary bg-state-soft hover:bg-state-mid transition-colors"
              >
                <span className="font-medium text-fg">逐个上传</span>
                <span className="block text-fg-tertiary mt-0.5">每个文件单独上传到目标目录</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  const { paths, destDir } = pendingDropFiles;
                  setPendingDropFiles(null);
                  await actions.uploadAsZip(paths, destDir, setDropWarning);
                }}
                className="w-full px-3 py-2 rounded-lg text-body text-left text-fg-secondary bg-state-soft hover:bg-state-mid transition-colors"
              >
                <span className="font-medium text-fg">打包上传</span>
                <span className="block text-fg-tertiary mt-0.5">压缩为 zip 后上传并解压到目标目录</span>
              </button>
            </div>
            <div className="flex justify-end mt-3">
              <button
                type="button"
                onClick={() => setPendingDropFiles(null)}
                className="px-3 py-1.5 rounded-lg text-body text-fg-secondary bg-state-soft hover:bg-state-mid"
              >
                取消
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Upload mode selection dialog for folder upload */}
      {pendingFolderUpload && createPortal(
        <div className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="modal-panel-enter w-96 surface-glass rounded-2xl p-4">
            <h3 className="text-title text-fg mb-2">上传文件夹</h3>
            <p className="text-meta text-fg-secondary mb-4">
              将「{pendingFolderUpload.folderName}」上传到 <span className="text-fg-secondary">{pendingFolderUpload.destDir}</span>，选择上传方式：
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => runFolderUpload('folder')}
                className="w-full px-3 py-2 rounded-lg text-body text-left text-fg-secondary bg-state-soft hover:bg-state-mid transition-colors"
              >
                <span className="font-medium text-fg">上传到新建子文件夹</span>
                <span className="block text-fg-tertiary mt-0.5">在当前目录下创建同名文件夹，文件落到该子文件夹内</span>
              </button>
              <button
                type="button"
                onClick={() => runFolderUpload('flat')}
                className="w-full px-3 py-2 rounded-lg text-body text-left text-fg-secondary bg-state-soft hover:bg-state-mid transition-colors"
              >
                <span className="font-medium text-fg">上传到当前目录</span>
                <span className="block text-fg-tertiary mt-0.5">文件直接落到当前目录；若存在同名条目将报错中止</span>
              </button>
            </div>
            <div className="flex justify-end mt-3">
              <button
                type="button"
                onClick={() => setPendingFolderUpload(null)}
                className="px-3 py-1.5 rounded-lg text-body text-fg-secondary bg-state-soft hover:bg-state-mid"
              >
                取消
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {extractConfirm && createPortal(
        <div className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="modal-panel-enter w-96 surface-glass rounded-2xl p-4">
            <h3 className="text-title text-fg mb-2">解压文件</h3>
            <p className="text-meta text-fg-secondary mb-4">
              将「{extractConfirm.name}」解压到 <span className="text-fg-secondary">{parentDir(extractConfirm.path)}</span>，选择解压位置：
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  const stem = archiveStem(extractConfirm.name);
                  const target = joinRemotePath(parentDir(extractConfirm.path), stem);
                  handleExtract(target);
                }}
                className="w-full px-3 py-2 rounded-lg text-body text-left text-fg-secondary bg-state-soft hover:bg-state-mid transition-colors"
              >
                <span className="font-medium text-fg">解压到同名子文件夹</span>
                <span className="block text-fg-tertiary mt-0.5">在当前目录下创建「{archiveStem(extractConfirm.name)}」文件夹并解压到其中</span>
              </button>
              <button
                type="button"
                onClick={() => handleExtract(parentDir(extractConfirm.path))}
                className="w-full px-3 py-2 rounded-lg text-body text-left text-fg-secondary bg-state-soft hover:bg-state-mid transition-colors"
              >
                <span className="font-medium text-fg">解压到当前目录</span>
                <span className="block text-fg-tertiary mt-0.5">直接解压到当前目录，保留压缩包内部结构</span>
              </button>
            </div>
            <div className="flex justify-end mt-3">
              <button
                type="button"
                onClick={() => setExtractConfirm(null)}
                className="px-3 py-1.5 rounded-lg text-body text-fg-secondary bg-state-soft hover:bg-state-mid"
              >
                取消
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
