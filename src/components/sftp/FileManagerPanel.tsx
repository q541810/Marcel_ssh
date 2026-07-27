import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import { stat } from '@tauri-apps/plugin-fs';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  sftpListDir,
  sftpMkdir,
  sftpRemove,
  sftpRemoveViaShell,
  sftpRename,
  sftpWriteFile,
  sftpExtractArchive,
  sftpOpenWithSystem,
} from '@/lib/tauri';
import type { SftpFileEntry } from '@/lib/types';
import { formatSize, modeToString, getErrorMessage, isPreviewableImage } from '@/lib/sftp-helpers';
import { MAX_EDITOR_FILE_SIZE, MAX_PREVIEW_IMAGE_SIZE, BINARY_EXTENSIONS, isArchiveFile, archiveStem } from '@/lib/constants';
import PathBreadcrumb from './PathBreadcrumb';
import FileTreeSidebar from './FileTreeSidebar';
import {
  clampTreeWidth,
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
import { useFileDrop, type DropPosition } from '@/hooks/useFileDrop';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { useFileTree } from '@/hooks/useFileTree';
import FileEditorModal from './FileEditorModal';
import ImagePreviewModal from './ImagePreviewModal';
import CompressModal from './CompressModal';

interface FileManagerPanelProps {
  sessionId: string;
  connectionKey: string;
}

export default function FileManagerPanel({ sessionId, connectionKey }: FileManagerPanelProps) {
  const storeSettings = useSettingsStore((s) => s.settings);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const [currentPath, setCurrentPath] = useState(
    storeSettings.fileManagerPaths?.[connectionKey] ?? storeSettings.fileManagerPath ?? '/',
  );
  const [history, setHistory] = useState<string[]>(['/']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [entries, setEntries] = useState<SftpFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(storeSettings.fileManagerShowHidden ?? false);
  const [menuEntry, setMenuEntry] = useState<SftpFileEntry | null>(null);
  const [menuTargets, setMenuTargets] = useState<SftpFileEntry[]>([]);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [deleteConfirm, setDeleteConfirm] = useState<SftpFileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renameEntry, setRenameEntry] = useState<SftpFileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);
  const [editorFile, setEditorFile] = useState<{ path: string; name: string; size: number } | null>(null);
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string; size: number } | null>(null);
  const [pendingDropFiles, setPendingDropFiles] = useState<string[] | null>(null);
  const [pendingFolderUpload, setPendingFolderUpload] = useState<{ localPath: string; folderName: string } | null>(null);
  const [extractConfirm, setExtractConfirm] = useState<SftpFileEntry | null>(null);
  const [compressEntry, setCompressEntry] = useState<SftpFileEntry | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const treeRegionRef = useRef<HTMLDivElement>(null);
  const loadSeqRef = useRef(0);
  const toolbarWidth = useContainerWidth(toolbarRef);
  const panelWidth = useContainerWidth(panelRef);
  const mode = toolbarWidth >= 870 ? 'full' : toolbarWidth >= 750 ? 'compact' : 'icon-only';

  const treeUserHidden = storeSettings.fileManagerTreeUserHidden ?? false;
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
    initialWidth: clampTreeWidth(storeSettings.fileManagerTreeWidth ?? FILE_TREE_DEFAULT_WIDTH),
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
  } = useFileTree({
    sessionId,
    showHidden,
    currentPath,
  });

  const toggleTreeUserHidden = useCallback(() => {
    const next = !useSettingsStore.getState().settings.fileManagerTreeUserHidden;
    useSettingsStore.getState().update({ fileManagerTreeUserHidden: next });
  }, []);

  const loadDirectory = useCallback(async (path: string) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setEntries([]);
    setError(null);
    try {
      const items = await sftpListDir(sessionId, path);
      if (seq !== loadSeqRef.current) return;
      setEntries(items);
      // Seed tree: expand of this path needs no second listDir.
      seedTreeFromListing(path, items);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setError(`加载失败：${getErrorMessage(err)}`);
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [sessionId, seedTreeFromListing]);

  useEffect(() => {
    loadDirectory(currentPath);
    setSelected(new Set());
  }, [currentPath, loadDirectory]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.getState().update({
      fileManagerPath: currentPath,
      fileManagerPaths: {
        ...(settings.fileManagerPaths ?? {}),
        [connectionKey]: currentPath,
      },
    });
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

  // 菜单展开后测实际尺寸，超出窗口边界时反向调整
  useEffect(() => {
    if (!menuEntry || menuTargets.length === 0) return;
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const overflowY = rect.bottom - window.innerHeight;
    const overflowX = rect.right - window.innerWidth;
    if (overflowY > 0 || overflowX > 0) {
      setMenuPos((prev) => ({
        x: overflowX > 0 ? Math.max(0, prev.x - overflowX) : prev.x,
        y: overflowY > 0 ? Math.max(0, prev.y - overflowY) : prev.y,
      }));
    }
  }, [menuEntry, menuTargets]);

  const filteredEntries = useMemo(() => {
    const result = showHidden ? [...entries] : entries.filter((e) => !e.name.startsWith('.'));
    result.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
    return result;
  }, [entries, showHidden]);

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

  const handleNavigate = (entry: SftpFileEntry) => {
    if (entry.is_dir) {
      const path = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      navigateTo(path);
    } else if (entry.is_file) {
      const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      // 图片：走预览（先于 BINARY_EXTENSIONS 判断，因为图片扩展名也在 BINARY_EXTENSIONS 里）
      if (isPreviewableImage(entry.name)) {
        if (entry.size > MAX_PREVIEW_IMAGE_SIZE) {
          setError(`图片过大 (${formatSize(entry.size)})，预览上限为 ${formatSize(MAX_PREVIEW_IMAGE_SIZE)}，请使用下载功能`);
          return;
        }
        setPreviewFile({ path: fullPath, name: entry.name, size: entry.size });
        return;
      }
      const ext = entry.name.lastIndexOf('.') >= 0 ? entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase() : '';
      if (BINARY_EXTENSIONS.has(ext)) {
        setError(`无法编辑二进制文件 (${ext})，请使用下载功能`);
        return;
      }
      if (entry.size > MAX_EDITOR_FILE_SIZE) {
        setError(`文件过大 (${formatSize(entry.size)})，编辑器限制为 ${formatSize(MAX_EDITOR_FILE_SIZE)}，请使用下载功能`);
        return;
      }
      setEditorFile({ path: fullPath, name: entry.name, size: entry.size });
    }
  };

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

  const handleDownload = (entry: SftpFileEntry) => {
    setMenuEntry(null);
    setMenuTargets([]);
    const entryPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
    startDownload(entry, entryPath);
  };

  const handleOpenWithSystem = async (entry: SftpFileEntry) => {
    setMenuEntry(null);
    setMenuTargets([]);
    const entryPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
    const downloadId = createTransferId();
    const uploadId = `sysopen-${createTransferId()}`;

    const downloadItem: TransferItem = {
      id: downloadId,
      kind: 'download',
      sessionId,
      fileName: entry.name,
      localPath: '',
      remotePath: entryPath,
      written: 0,
      total: entry.size,
      statusText: `正在下载 ${entry.name} ...`,
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
      statusText: '监视中...',
      createdAt: Date.now(),
    };

    useTransferStore.getState().addItem(downloadItem);
    useTransferStore.getState().updateItem(downloadId, { status: 'active' });
    useTransferStore.getState().addItem(uploadItem);
    useTransferStore.getState().updateItem(uploadId, { status: 'active' });
    useTransferStore.getState().setOpen(true);

    try {
      await sftpOpenWithSystem(sessionId, entryPath, downloadId, uploadId);
    } catch (err) {
      useTransferStore.getState().updateItem(downloadId, {
        status: 'error',
        statusText: `下载失败：${getErrorMessage(err)}`,
        finishedAt: Date.now(),
      });
      useTransferStore.getState().updateItem(uploadId, {
        status: 'error',
        statusText: '下载失败',
        finishedAt: Date.now(),
      });
    }
  };

  const handleUpload = async () => {
    setMenuEntry(null);
    setMenuTargets([]);
    try {
      const filePaths = await open({
        multiple: false,
        title: '选择文件',
      });
      if (!filePaths) return;

      const localPath = Array.isArray(filePaths) ? filePaths[0] : filePaths;
      const fileName = localPath.split(/[/\\]/).pop() || 'upload';
      const targetPath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;

      uploadFile(localPath, fileName, targetPath, () => {
        void loadDirectory(currentPath);
      });
    } catch (err) {
      setError(`上传失败：${getErrorMessage(err)}`);
    }
  };

  const { uploadFile, pickFolder, uploadFolder: doUploadFolder } = useSftpUpload(sessionId, currentPath);
  const { startDownload } = useSftpDownload(sessionId);

  const handleUploadFolder = async () => {
    setMenuEntry(null);
    setMenuTargets([]);
    try {
      const picked = await pickFolder();
      if (!picked) return;
      setPendingFolderUpload(picked);
    } catch (err) {
      setError(`选择文件夹失败：${getErrorMessage(err)}`);
    }
  };

  const runFolderUpload = (mode: 'folder' | 'flat') => {
    const picked = pendingFolderUpload;
    if (!picked) return;
    setPendingFolderUpload(null);
    doUploadFolder(picked.localPath, picked.folderName, mode, () => {
      void loadDirectory(currentPath);
    });
  };

  const handleDropUpload = useCallback((paths: string[]) => {
    for (const localPath of paths) {
      const fileName = localPath.split(/[/\\]/).pop() || 'upload';
      const targetPath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;
      uploadFile(localPath, fileName, targetPath, () => {
        void loadDirectory(currentPath);
      });
    }
  }, [currentPath, uploadFile, loadDirectory]);

  const handleDropUploadAsZip = useCallback(async (paths: string[]) => {
    const { sftpPrepareDragUpload, sftpCleanupTempDir } = await import('@/lib/tauri');
    const { enqueueTransfer, createTransferId } = await import('@/stores/transferScheduler');

    let tempDir: string | null = null;
    try {
      // 1. 后端创建临时目录并复制文件
      tempDir = await sftpPrepareDragUpload(paths);
    } catch (err) {
      setError(`打包上传失败：${getErrorMessage(err)}`);
      return;
    }

    // 2. 入队打包上传（解压到当前目录），完成后清理临时目录并刷新
    const preparedDir = tempDir;
    enqueueTransfer(
      {
        id: createTransferId(),
        kind: 'folder-upload',
        sessionId,
        fileName: `拖拽上传 (${paths.length} 项)`,
        localPath: preparedDir,
        remotePath: currentPath,
        flat: true,
        written: 0,
        total: 0,
        statusText: '排队中',
        createdAt: Date.now(),
      },
      () => {
        void sftpCleanupTempDir(preparedDir).catch(() => {});
        void loadDirectory(currentPath);
      },
    );
  }, [sessionId, currentPath, loadDirectory]);

  // 拖拽上传：使用 useFileDrop hook；树区域不接 drop
  const handleFileDrop = useCallback(async (paths: string[], position?: DropPosition) => {
    if (position && treeRegionRef.current && showTree) {
      const rect = treeRegionRef.current.getBoundingClientRect();
      if (
        position.x >= rect.left &&
        position.x <= rect.right &&
        position.y >= rect.top &&
        position.y <= rect.bottom
      ) {
        return;
      }
    }
    if (paths.length === 1) {
      try {
        const info = await stat(paths[0]);
        if (info.isDirectory) {
          const folderName = paths[0].split(/[/\\]/).pop() || 'upload';
          setPendingFolderUpload({ localPath: paths[0], folderName });
          return;
        }
      } catch {
        // stat 失败，降级为普通上传
      }
      handleDropUpload(paths);
    } else {
      setPendingDropFiles(paths);
    }
  }, [handleDropUpload, showTree]);

  const { isDragging } = useFileDrop(handleFileDrop, true);

  const handleDelete = async (entries: SftpFileEntry[]) => {
    setDeleteConfirm([]);
    setMenuEntry(null);
    setMenuTargets([]);
    setSelected(new Set());
    try {
      setLoading(true);
      const errors: string[] = [];
      for (const entry of entries) {
        try {
          const entryPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
          await sftpRemove(sessionId, entryPath, entry.is_dir);
        } catch (err) {
          errors.push(`${entry.name}: ${getErrorMessage(err)}`);
        }
      }
      if (errors.length > 0) {
        setError(`部分删除失败：${errors.join('；')}`);
      }
      await loadDirectory(currentPath);
    } catch (err) {
      setError(`删除失败：${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleQuickDelete = async (entries: SftpFileEntry[]) => {
    setDeleteConfirm([]);
    setMenuEntry(null);
    setMenuTargets([]);
    setSelected(new Set());
    try {
      setLoading(true);
      const errors: string[] = [];
      for (const entry of entries) {
        try {
          const entryPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
          await sftpRemoveViaShell(sessionId, entryPath, entry.is_dir);
        } catch (err) {
          errors.push(`${entry.name}: ${getErrorMessage(err)}`);
        }
      }
      if (errors.length > 0) {
        setError(`部分快速删除失败：${errors.join('；')}`);
      }
      await loadDirectory(currentPath);
    } catch (err) {
      setError(`快速删除失败：${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleRename = async () => {
    if (!renameEntry || !renameValue.trim()) return;
    setRenameEntry(null);
    setMenuEntry(null);
    setMenuTargets([]);
    try {
      setLoading(true);
      const oldPath = currentPath === '/' ? `/${renameEntry.name}` : `${currentPath}/${renameEntry.name}`;
      const newPath = currentPath === '/' ? `/${renameValue}` : `${currentPath}/${renameValue}`;
      await sftpRename(sessionId, oldPath, newPath);
      await loadDirectory(currentPath);
    } catch (err) {
      setError(`重命名失败：${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    setShowNewFolder(false);
    try {
      setLoading(true);
      const folderPath = currentPath === '/' ? `/${newFolderName}` : `${currentPath}/${newFolderName}`;
      await sftpMkdir(sessionId, folderPath);
      await loadDirectory(currentPath);
    } catch (err) {
      setError(`创建文件夹失败：${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;
    setShowNewFile(false);
    try {
      setLoading(true);
      const filePath = currentPath === '/' ? `/${newFileName}` : `${currentPath}/${newFileName}`;
      await sftpWriteFile(sessionId, filePath, '');
      await loadDirectory(currentPath);
    } catch (err) {
      setError(`创建文件失败：${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyPath = async (entries: SftpFileEntry[]) => {
    setMenuEntry(null);
    setMenuTargets([]);
    try {
      const paths = entries.map((e) =>
        currentPath === '/' ? `/${e.name}` : `${currentPath}/${e.name}`,
      );
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(paths.join('\n'));
    } catch {
      // ignore
    }
  };

  const handleExtract = async (targetDir: string) => {
    const entry = extractConfirm;
    if (!entry) return;
    setExtractConfirm(null);
    const archivePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
    try {
      setLoading(true);
      await sftpExtractArchive(sessionId, archivePath, targetDir);
      await loadDirectory(currentPath);
    } catch (err) {
      setError(`解压失败：${getErrorMessage(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={panelRef} className="flex flex-col h-full">
      <div ref={toolbarRef} className="flex items-center gap-1.5 border-b border-zinc-800 px-3 py-2 flex-shrink-0">
        <button
          type="button"
          onClick={handleGoBack}
          disabled={historyIndex === 0}
          className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
          title="后退"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleGoForward}
          disabled={historyIndex === history.length - 1}
          className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
          title="前进"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <PathBreadcrumb currentPath={currentPath} onNavigate={navigateTo} />
        <button
          type="button"
          onClick={() => setShowNewFolder(true)}
          className="flex items-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 whitespace-nowrap"
          title="新建文件夹"
        >
          {mode !== 'compact' && (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            </svg>
          )}
          {mode !== 'icon-only' && <span>新建文件夹</span>}
        </button>
        <button
          type="button"
          onClick={() => setShowNewFile(true)}
          className="flex items-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 whitespace-nowrap"
          title="新建文件"
        >
          {mode !== 'compact' && (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          )}
          {mode !== 'icon-only' && <span>新建文件</span>}
        </button>
        <button
          type="button"
          onClick={handleUpload}
          className="flex items-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 whitespace-nowrap"
          title="上传文件"
        >
          {mode !== 'compact' && (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          )}
          {mode !== 'icon-only' && <span>上传</span>}
        </button>
        <button
          type="button"
          onClick={handleUploadFolder}
          className="flex items-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 whitespace-nowrap"
          title="上传文件夹"
        >
          {mode !== 'compact' && (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
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
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors whitespace-nowrap ${showHidden ? 'bg-indigo-500/20 text-indigo-400' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'}`}
          title="显示隐藏文件"
        >
          {mode !== 'compact' && (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
          {mode !== 'icon-only' && <span>{showHidden ? '隐藏' : '显示'}</span>}
        </button>
        <button
          type="button"
          onClick={() => void loadDirectory(currentPath)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 whitespace-nowrap"
          title="刷新"
        >
          {mode === 'icon-only' ? (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
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
            className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors whitespace-nowrap ${
              !treeUserHidden
                ? 'bg-indigo-500/20 text-indigo-400'
                : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
            }`}
            title={treeUserHidden ? '显示目录树' : '隐藏目录树'}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h6v6H4V6zm10 0h6v4h-6V6zM4 14h6v4H4v-4zm10 2h6v4h-6v-4z" />
            </svg>
            {mode !== 'icon-only' && <span>目录树</span>}
          </button>
        )}
      </div>

      {showNewFolder && (
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 bg-zinc-800/50">
          <input
            type="text"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder();
              if (e.key === 'Escape') setShowNewFolder(false);
            }}
            placeholder="新文件夹名称"
            className="flex-1 rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-indigo-500 placeholder:text-zinc-500"
            autoFocus
          />
          <button
            type="button"
            onClick={handleCreateFolder}
            className="rounded-md bg-indigo-600 px-2 py-1 text-xs text-white hover:bg-indigo-500"
          >
            创建
          </button>
          <button
            type="button"
            onClick={() => setShowNewFolder(false)}
            className="rounded-md bg-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-600"
          >
            取消
          </button>
        </div>
      )}
      {showNewFile && (
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 bg-zinc-800/50">
          <input
            type="text"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFile();
              if (e.key === 'Escape') setShowNewFile(false);
            }}
            placeholder="新文件名称"
            className="flex-1 rounded-md bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-indigo-500 placeholder:text-zinc-500"
            autoFocus
          />
          <button
            type="button"
            onClick={handleCreateFile}
            className="rounded-md bg-indigo-600 px-2 py-1 text-xs text-white hover:bg-indigo-500"
          >
            创建
          </button>
          <button
            type="button"
            onClick={() => setShowNewFile(false)}
            className="rounded-md bg-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-600"
          >
            取消
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between px-3 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-300 flex-shrink-0">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-200 transition-colors">✕</button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex relative">
        <div
          ref={treeRegionRef}
          className={`flex-shrink-0 h-full overflow-hidden ${showTree ? 'border-r border-zinc-800/80' : 'pointer-events-none'}`}
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
                onToggleExpand={toggleTreeExpand}
                onNavigate={navigateTo}
                onRetry={(path) => void loadTreeNode(path, true)}
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

        <div className="flex-1 min-w-0 overflow-auto relative">
          {isDragging && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-indigo-500/10 border-2 border-dashed border-indigo-400 rounded-lg pointer-events-none">
              <div className="text-center">
                <svg className="w-10 h-10 mx-auto text-indigo-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="text-sm text-indigo-300 font-medium">松手上传到当前目录</p>
              </div>
            </div>
          )}

        <table className="w-full text-xs table-fixed border-separate border-spacing-0">
          <thead className="sticky top-0 z-10">
            <tr className="text-zinc-500 bg-zinc-900">
              <th className="py-2 text-center font-medium w-8 border-b border-zinc-800">
                <label className="relative inline-flex items-center justify-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.size > 0 && selected.size === filteredEntries.length}
                    onChange={() => {
                      if (selected.size === filteredEntries.length) {
                        setSelected(new Set());
                      } else {
                        setSelected(new Set(filteredEntries.map((e) => e.name)));
                      }
                    }}
                    className={`appearance-none w-3.5 h-3.5 rounded-[3px] border cursor-pointer ${selected.size > 0 && selected.size === filteredEntries.length ? 'bg-indigo-500 border-indigo-500' : 'bg-zinc-600 border-zinc-500'}`}
                  />
                  {selected.size > 0 && selected.size === filteredEntries.length && (
                    <svg className="absolute w-2.5 h-2.5 text-white pointer-events-none" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M2 6l3 3 5-5" />
                    </svg>
                  )}
                </label>
              </th>
              <th className="px-3 py-2 text-left font-medium border-b border-zinc-800">名称</th>
              <th className="px-3 py-2 text-left font-medium w-24 border-b border-zinc-800">大小</th>
              <th className="px-3 py-2 text-left font-medium w-28 border-b border-zinc-800">权限</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="py-8 text-center">
                  <div className="flex items-center justify-center gap-2 text-xs text-zinc-400">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span>加载中...</span>
                  </div>
                </td>
              </tr>
            ) : (
              filteredEntries.map((entry) => {
              const entryPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
              const isSelected = selected.has(entry.name);
              return (
                <tr
                  key={entryPath}
                  className={`hover:bg-zinc-800/50 transition-colors cursor-pointer ${isSelected ? 'bg-indigo-500/10' : ''}`}
                  onDoubleClick={() => handleNavigate(entry)}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(entry.name)) next.delete(entry.name);
                        else next.add(entry.name);
                        return next;
                      });
                    }
                  }}
                  onContextMenu={(e) => handleContextMenu(e, entry)}
                >
                  <td className="py-1.5 text-center border-b border-zinc-800/50">
                    <label className="relative inline-flex items-center justify-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(entry.name)) next.delete(entry.name);
                            else next.add(entry.name);
                            return next;
                          });
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className={`appearance-none w-3.5 h-3.5 rounded-[3px] border cursor-pointer ${isSelected ? 'bg-indigo-500 border-indigo-500' : 'bg-zinc-600 border-zinc-500'}`}
                      />
                      {isSelected && (
                        <svg className="absolute w-2.5 h-2.5 text-white pointer-events-none" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M2 6l3 3 5-5" />
                        </svg>
                      )}
                    </label>
                  </td>
                  <td className="px-3 py-1.5 text-zinc-300 truncate border-b border-zinc-800/50">
                    <span className="flex items-center gap-2">
                      {entry.is_dir ? (
                        <svg className="w-4 h-4 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                        </svg>
                      ) : entry.is_symlink ? (
                        <svg className="w-4 h-4 text-cyan-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 text-zinc-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      )}
                      <span className="truncate">{entry.name}</span>
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-zinc-400 border-b border-zinc-800/50">{entry.is_dir ? '-' : formatSize(entry.size)}</td>
                  <td className="px-3 py-1.5 text-zinc-500 font-mono border-b border-zinc-800/50">{modeToString(entry.mode)}</td>
                </tr>
              );
            })
            )}
          </tbody>
        </table>

        {filteredEntries.length === 0 && !loading && !error && (
          <div className="py-8 text-center text-sm text-zinc-500">
            {showHidden ? '空目录' : '空目录（可能包含隐藏文件）'}
          </div>
        )}

        {selected.size > 0 && (
          <div className="sticky bottom-0 flex items-center justify-between gap-3 px-3 py-2 bg-zinc-800/95 border-t border-zinc-700 backdrop-blur-sm">
            <span className="text-xs text-zinc-300">已选 {selected.size} 个</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const targets = filteredEntries.filter((e) => selected.has(e.name));
                  handleCopyPath(targets);
                }}
                className="rounded-md bg-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-600 transition-colors"
              >
                复制路径
              </button>
              <button
                type="button"
                onClick={() => {
                  const targets = filteredEntries.filter((e) => selected.has(e.name));
                  setDeleteConfirm(targets);
                }}
                className="rounded-md bg-red-900/60 px-2.5 py-1 text-xs text-red-300 hover:bg-red-900/80 transition-colors"
              >
                删除
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="rounded-md bg-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-600 transition-colors"
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
          className="context-menu-enter fixed z-50 w-40 rounded-lg border border-zinc-700 bg-zinc-800 p-1 shadow-lg"
          style={{ top: menuPos.y, left: menuPos.x }}
        >
          {menuTargets.length === 1 ? (
            <>
              {menuEntry.is_dir && (
                <>
                  <button
                    type="button"
                    onClick={() => { handleNavigate(menuEntry); setMenuEntry(null); setMenuTargets([]); }}
                    className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCompressEntry(menuEntry);
                      setMenuEntry(null); setMenuTargets([]);
                    }}
                    className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
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
                        if (menuEntry.size > MAX_PREVIEW_IMAGE_SIZE) {
                          setError(`图片过大 (${formatSize(menuEntry.size)})，预览上限为 ${formatSize(MAX_PREVIEW_IMAGE_SIZE)}，请使用下载功能`);
                          setMenuEntry(null); setMenuTargets([]);
                          return;
                        }
                        const fullPath = currentPath === '/' ? `/${menuEntry.name}` : `${currentPath}/${menuEntry.name}`;
                        setPreviewFile({ path: fullPath, name: menuEntry.name, size: menuEntry.size });
                        setMenuEntry(null); setMenuTargets([]);
                      }}
                      className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
                    >
                      预览
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        const ext = menuEntry.name.lastIndexOf('.') >= 0 ? menuEntry.name.slice(menuEntry.name.lastIndexOf('.')).toLowerCase() : '';
                        if (BINARY_EXTENSIONS.has(ext)) {
                          setError(`无法编辑二进制文件 (${ext})，请使用下载功能`);
                          setMenuEntry(null); setMenuTargets([]);
                          return;
                        }
                        if (menuEntry.size > MAX_EDITOR_FILE_SIZE) {
                          setError(`文件过大 (${formatSize(menuEntry.size)})，编辑器限制为 ${formatSize(MAX_EDITOR_FILE_SIZE)}，请使用下载功能`);
                          setMenuEntry(null); setMenuTargets([]);
                          return;
                        }
                        const fullPath = currentPath === '/' ? `/${menuEntry.name}` : `${currentPath}/${menuEntry.name}`;
                        setEditorFile({ path: fullPath, name: menuEntry.name, size: menuEntry.size });
                        setMenuEntry(null); setMenuTargets([]);
                      }}
                      className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
                    >
                      编辑
                    </button>
                  )}
                   <button
                    type="button"
                    onClick={() => handleDownload(menuEntry)}
                    className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
                  >
                    下载
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenWithSystem(menuEntry)}
                    className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
                  >
                    用系统方式打开
                  </button>
                  {isArchiveFile(menuEntry.name) && (
                    <button
                      type="button"
                      onClick={() => {
                        setExtractConfirm(menuEntry);
                        setMenuEntry(null); setMenuTargets([]);
                      }}
                      className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
                    >
                      解压
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  setRenameEntry(menuEntry);
                  setRenameValue(menuEntry.name);
                  setMenuEntry(null); setMenuTargets([]);
                }}
                className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
              >
                重命名
              </button>
            </>
          ) : (
            <div className="px-2 py-1.5 text-xs text-zinc-400">
              已选 {menuTargets.length} 个
            </div>
          )}
          <button
            type="button"
            onClick={() => handleCopyPath(menuTargets)}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
          >
            复制路径
          </button>
          <hr className="border-zinc-700 my-1" />
          <button
            type="button"
            onClick={() => {
              setDeleteConfirm(menuTargets);
              setMenuEntry(null); setMenuTargets([]);
            }}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-red-400 hover:bg-red-950/60"
          >
            删除
          </button>
        </div>,
        document.body,
      )}

      {renameEntry && createPortal(
        <div className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="modal-panel-enter w-80 rounded-xl bg-zinc-800 border border-zinc-700 shadow-2xl p-4">
            <h3 className="text-sm font-semibold text-zinc-200 mb-3">重命名</h3>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename();
                if (e.key === 'Escape') setRenameEntry(null);
              }}
              className="w-full rounded-md bg-zinc-900 border border-zinc-700 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500 mb-3"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameEntry(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleRename}
                className="px-3 py-1.5 rounded-lg text-xs text-white bg-indigo-600 hover:bg-indigo-500"
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
          <div className="modal-panel-enter w-80 rounded-xl bg-zinc-800 border border-zinc-700 shadow-2xl p-4">
            <h3 className="text-sm font-semibold text-red-300 mb-2">
              确认删除 {deleteConfirm.length > 1 ? `${deleteConfirm.length} 个文件` : ''}
            </h3>
            {deleteConfirm.length === 1 ? (
              <>
                <p className="text-xs text-zinc-400 mb-1">
                  类型: <span className="text-zinc-200">{deleteConfirm[0].is_dir ? '目录' : '文件'}</span>
                </p>
                <p className="text-xs text-zinc-400 mb-4">
                  名称: <span className="text-zinc-200">{deleteConfirm[0].name}</span>
                </p>
              </>
            ) : (
              <div className="text-xs text-zinc-400 mb-4 max-h-40 overflow-auto">
                {deleteConfirm.slice(0, 10).map((e) => (
                  <p key={e.name} className="text-zinc-200">{e.name}</p>
                ))}
                {deleteConfirm.length > 10 && <p className="text-zinc-500">等 {deleteConfirm.length} 个文件…</p>}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm([])}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleDelete(deleteConfirm)}
                className="px-3 py-1.5 rounded-lg text-xs text-white bg-red-600 hover:bg-red-500"
              >
                确认删除
              </button>
              {deleteConfirm.length === 1 && deleteConfirm[0].is_dir && (
                <button
                  type="button"
                  onClick={() => handleQuickDelete(deleteConfirm)}
                  className="px-3 py-1.5 rounded-lg text-xs text-white bg-red-600 hover:bg-red-500"
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
          open={!!previewFile}
          sessionId={sessionId}
          filePath={previewFile.path}
          fileName={previewFile.name}
          fileSize={previewFile.size}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {compressEntry && (
        <CompressModal
          open={!!compressEntry}
          sessionId={sessionId}
          remoteDir={
            currentPath === '/'
              ? `/${compressEntry.name}`
              : `${currentPath}/${compressEntry.name}`
          }
          onClose={() => setCompressEntry(null)}
          onCompressed={() => {
            setCompressEntry(null);
            loadDirectory(currentPath);
          }}
        />
      )}

      {/* Upload mode selection dialog for multiple files */}
      {pendingDropFiles && createPortal(
        <div className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="modal-panel-enter w-96 rounded-xl bg-zinc-800 border border-zinc-700 shadow-2xl p-4">
            <h3 className="text-sm font-semibold text-zinc-200 mb-2">上传多个文件</h3>
            <p className="text-xs text-zinc-400 mb-4">
              检测到 {pendingDropFiles.length} 个文件，选择上传方式：
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={async () => {
                  const paths = pendingDropFiles;
                  setPendingDropFiles(null);
                  await handleDropUpload(paths);
                }}
                className="w-full px-3 py-2 rounded-lg text-xs text-left text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
              >
                <span className="font-medium text-zinc-100">逐个上传</span>
                <span className="block text-zinc-500 mt-0.5">每个文件单独上传到当前目录</span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  const paths = pendingDropFiles;
                  setPendingDropFiles(null);
                  await handleDropUploadAsZip(paths);
                }}
                className="w-full px-3 py-2 rounded-lg text-xs text-left text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
              >
                <span className="font-medium text-zinc-100">打包上传</span>
                <span className="block text-zinc-500 mt-0.5">压缩为 zip 后上传并解压到当前目录</span>
              </button>
            </div>
            <div className="flex justify-end mt-3">
              <button
                type="button"
                onClick={() => setPendingDropFiles(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
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
          <div className="modal-panel-enter w-96 rounded-xl bg-zinc-800 border border-zinc-700 shadow-2xl p-4">
            <h3 className="text-sm font-semibold text-zinc-200 mb-2">上传文件夹</h3>
            <p className="text-xs text-zinc-400 mb-4">
              将「{pendingFolderUpload.folderName}」上传到 <span className="text-zinc-300">{currentPath}</span>，选择上传方式：
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => runFolderUpload('folder')}
                className="w-full px-3 py-2 rounded-lg text-xs text-left text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
              >
                <span className="font-medium text-zinc-100">上传到新建子文件夹</span>
                <span className="block text-zinc-500 mt-0.5">在当前目录下创建同名文件夹，文件落到该子文件夹内</span>
              </button>
              <button
                type="button"
                onClick={() => runFolderUpload('flat')}
                className="w-full px-3 py-2 rounded-lg text-xs text-left text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
              >
                <span className="font-medium text-zinc-100">上传到当前目录</span>
                <span className="block text-zinc-500 mt-0.5">文件直接落到当前目录；若存在同名条目将报错中止</span>
              </button>
            </div>
            <div className="flex justify-end mt-3">
              <button
                type="button"
                onClick={() => setPendingFolderUpload(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
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
          <div className="modal-panel-enter w-96 rounded-xl bg-zinc-800 border border-zinc-700 shadow-2xl p-4">
            <h3 className="text-sm font-semibold text-zinc-200 mb-2">解压文件</h3>
            <p className="text-xs text-zinc-400 mb-4">
              将「{extractConfirm.name}」解压到 <span className="text-zinc-300">{currentPath}</span>，选择解压位置：
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  const stem = archiveStem(extractConfirm.name);
                  const target = currentPath === '/' ? `/${stem}` : `${currentPath}/${stem}`;
                  handleExtract(target);
                }}
                className="w-full px-3 py-2 rounded-lg text-xs text-left text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
              >
                <span className="font-medium text-zinc-100">解压到同名子文件夹</span>
                <span className="block text-zinc-500 mt-0.5">在当前目录下创建「{archiveStem(extractConfirm.name)}」文件夹并解压到其中</span>
              </button>
              <button
                type="button"
                onClick={() => handleExtract(currentPath)}
                className="w-full px-3 py-2 rounded-lg text-xs text-left text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
              >
                <span className="font-medium text-zinc-100">解压到当前目录</span>
                <span className="block text-zinc-500 mt-0.5">直接解压到当前目录，保留压缩包内部结构</span>
              </button>
            </div>
            <div className="flex justify-end mt-3">
              <button
                type="button"
                onClick={() => setExtractConfirm(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
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
