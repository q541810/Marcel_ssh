import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, readDir, writeFile } from '@tauri-apps/plugin-fs';
import { zipSync } from 'fflate';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  sftpListDir,
  sftpUpload,
  sftpDownload,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  sftpUploadFolder,
  type SftpFileEntry,
} from '@/lib/tauri';

interface FileManagerPanelProps {
  sessionId: string;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function modeToString(mode: number): string {
  const isDir = (mode & 0o170000) === 0o040000;
  const isLink = (mode & 0o170000) === 0o120000;
  const chars = isDir ? 'd' : isLink ? 'l' : '-';
  const perms = [
    mode & 0o400 ? 'r' : '-',
    mode & 0o200 ? 'w' : '-',
    mode & 0o100 ? 'x' : '-',
    mode & 0o040 ? 'r' : '-',
    mode & 0o020 ? 'w' : '-',
    mode & 0o010 ? 'x' : '-',
    mode & 0o004 ? 'r' : '-',
    mode & 0o002 ? 'w' : '-',
    mode & 0o001 ? 'x' : '-',
  ].join('');
  return chars + perms;
}

export default function FileManagerPanel({ sessionId }: FileManagerPanelProps) {
  const storeSettings = useSettingsStore((s) => s.settings);
  const [currentPath, setCurrentPath] = useState(storeSettings.fileManagerPath || '/');
  const [history, setHistory] = useState<string[]>([storeSettings.fileManagerPath || '/']);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [entries, setEntries] = useState<SftpFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(storeSettings.fileManagerShowHidden ?? false);
  const [menuEntry, setMenuEntry] = useState<SftpFileEntry | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [deleteConfirm, setDeleteConfirm] = useState<SftpFileEntry | null>(null);
  const [renameEntry, setRenameEntry] = useState<SftpFileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [editPathValue, setEditPathValue] = useState('');
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const items = await sftpListDir(sessionId, path);
      setEntries(items);
    } catch (err) {
      setError(`加载失败：${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuEntry(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredEntries = useMemo(() => {
    return showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'));
  }, [entries, showHidden]);

  const navigateTo = useCallback((path: string) => {
    setHistory((prev) => {
      const newHistory = prev.slice(0, historyIndex + 1);
      newHistory.push(path);
      return newHistory;
    });
    setHistoryIndex((prev) => prev + 1);
    setCurrentPath(path);
    useSettingsStore.getState().update({ fileManagerPath: path });
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
    }
  };

  const handleContextMenu = (e: React.MouseEvent, entry: SftpFileEntry) => {
    e.preventDefault();
    setMenuEntry(entry);
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const handleDownload = async (entry: SftpFileEntry) => {
    setMenuEntry(null);
    try {
      const savePath = await save({
        defaultPath: entry.name,
        title: '保存文件',
      });
      if (!savePath) return;

      setLoading(true);
      const entryPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      const data = await sftpDownload(sessionId, entryPath);
      await writeFile(savePath, new Uint8Array(data));
    } catch (err) {
      setError(`下载失败：${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async () => {
    setMenuEntry(null);
    try {
      const filePaths = await open({
        multiple: false,
        title: '选择文件',
      });
      if (!filePaths) return;

      const path = Array.isArray(filePaths) ? filePaths[0] : filePaths;
      const data = await readFile(path);
      const fileName = path.split(/[/\\]/).pop() || 'upload';
      const remotePath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;

      setLoading(true);
      await sftpUpload(sessionId, remotePath, Array.from(data));
      await loadDirectory(currentPath);
    } catch (err) {
      setError(`上传失败：${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const collectFiles = async (dirPath: string, basePath: string): Promise<{ name: string; data: Uint8Array }[]> => {
    const items: { name: string; data: Uint8Array }[] = [];
    const dirEntries = await readDir(dirPath);
    for (const entry of dirEntries) {
      const fullPath = `${dirPath}/${entry.name}`;
      const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        const subItems = await collectFiles(fullPath, relativePath);
        items.push(...subItems);
      } else if (entry.isFile) {
        const data = await readFile(fullPath);
        items.push({ name: relativePath, data });
      }
    }
    return items;
  };

  const handleUploadFolder = async () => {
    setMenuEntry(null);
    try {
      const folderPath = await open({
        directory: true,
        title: '选择文件夹',
      });
      if (!folderPath) return;

      const path = Array.isArray(folderPath) ? folderPath[0] : folderPath;
      const folderName = path.split(/[/\\]/).pop() || 'upload';

      setUploadStatus('正在读取文件...');
      const files = await collectFiles(path, '');
      if (files.length === 0) {
        setUploadStatus(null);
        return;
      }

      setUploadStatus(`正在压缩 ${files.length} 个文件...`);
      const fileMap: Record<string, Uint8Array> = {};
      for (const f of files) {
        fileMap[f.name] = f.data;
      }
      const zipped = zipSync(fileMap, { level: 6 });

      const MAX_SIZE = 32 * 1024 * 1024;
      if (zipped.length > MAX_SIZE) {
        setUploadStatus(null);
        setError(`压缩包过大 (${formatSize(zipped.length)})，最大支持 32MB`);
        return;
      }

      setUploadStatus(`正在上传 ${formatSize(zipped.length)}...`);
      const remotePath = currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`;
      await sftpUploadFolder(sessionId, remotePath, Array.from(zipped));

      setUploadStatus(null);
      await loadDirectory(currentPath);
    } catch (err) {
      setUploadStatus(null);
      setError(`上传文件夹失败：${String(err)}`);
    }
  };

  const handleDelete = async (entry: SftpFileEntry) => {
    setDeleteConfirm(null);
    setMenuEntry(null);
    try {
      setLoading(true);
      const entryPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      await sftpRemove(sessionId, entryPath, entry.is_dir);
      await loadDirectory(currentPath);
    } catch (err) {
      setError(`删除失败：${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleRename = async () => {
    if (!renameEntry || !renameValue.trim()) return;
    setRenameEntry(null);
    setMenuEntry(null);
    try {
      setLoading(true);
      const oldPath = currentPath === '/' ? `/${renameEntry.name}` : `${currentPath}/${renameEntry.name}`;
      const newPath = currentPath === '/' ? `/${renameValue}` : `${currentPath}/${renameValue}`;
      await sftpRename(sessionId, oldPath, newPath);
      await loadDirectory(currentPath);
    } catch (err) {
      setError(`重命名失败：${String(err)}`);
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
      setError(`创建文件夹失败：${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyPath = async (entry: SftpFileEntry) => {
    setMenuEntry(null);
    try {
      const entryPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(entryPath);
    } catch {
      // ignore
    }
  };

  const pathParts = currentPath.split('/').filter(Boolean);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 flex-shrink-0">
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
        {editingPath ? (
          <input
            type="text"
            value={editPathValue}
            onChange={(e) => setEditPathValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const p = editPathValue.trim() || '/';
                setEditingPath(false);
                navigateTo(p);
              }
              if (e.key === 'Escape') setEditingPath(false);
            }}
            onBlur={() => {
              const p = editPathValue.trim() || '/';
              setEditingPath(false);
              if (p !== currentPath) navigateTo(p);
            }}
            className="flex-1 rounded-md bg-zinc-800 border border-zinc-700 px-2 py-0.5 text-xs text-zinc-100 outline-none focus:border-indigo-500 font-mono"
            autoFocus
          />
        ) : (
          <div
            className="flex-1 flex items-center gap-0.5 text-xs text-zinc-400 overflow-x-auto whitespace-nowrap cursor-text rounded-md px-2 py-0.5 hover:bg-zinc-800 transition-colors"
            onClick={() => {
              setEditPathValue(currentPath);
              setEditingPath(true);
            }}
            title="点击编辑路径"
          >
            <span className="text-zinc-400">/</span>
            {pathParts.map((part, i) => (
              <span key={i} className="flex items-center">
                <span className="text-zinc-600">&gt;</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigateTo('/' + pathParts.slice(0, i + 1).join('/'));
                  }}
                  className="hover:text-indigo-400 transition-colors px-1"
                >
                  {part}
                </button>
              </span>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowNewFolder(true)}
          className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
          title="新建文件夹"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleUpload}
          className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
          title="上传文件"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleUploadFolder}
          className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
          title="上传文件夹"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => {
            const newVal = !showHidden;
            setShowHidden(newVal);
            useSettingsStore.getState().update({ fileManagerShowHidden: newVal });
          }}
          className={`rounded-md px-2 py-1 text-xs transition-colors ${showHidden ? 'bg-indigo-500/20 text-indigo-400' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'}`}
          title="显示隐藏文件"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => loadDirectory(currentPath)}
          disabled={loading}
          className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
        >
          {loading ? '加载中...' : '刷新'}
        </button>
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

      {uploadStatus && (
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 bg-indigo-500/10">
          <svg className="w-3.5 h-3.5 text-indigo-400 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-xs text-indigo-300">{uploadStatus}</span>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {error && <div className="px-3 py-2 text-xs text-red-300">{error}</div>}

        <table className="w-full text-xs table-fixed">
          <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800">
            <tr className="text-zinc-500">
              <th className="px-3 py-2 text-left font-medium w-3/5">名称</th>
              <th className="px-3 py-2 text-left font-medium w-24">大小</th>
              <th className="px-3 py-2 text-left font-medium w-28">权限</th>
            </tr>
          </thead>
          <tbody>
            {filteredEntries.map((entry) => {
              const entryPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
              return (
                <tr
                  key={entryPath}
                  className="border-b border-zinc-800/50 hover:bg-zinc-800/50 transition-colors cursor-pointer"
                  onDoubleClick={() => handleNavigate(entry)}
                  onContextMenu={(e) => handleContextMenu(e, entry)}
                >
                  <td className="px-3 py-1.5 text-zinc-300 truncate">
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
                  <td className="px-3 py-1.5 text-zinc-400">{entry.is_dir ? '-' : formatSize(entry.size)}</td>
                  <td className="px-3 py-1.5 text-zinc-500 font-mono">{modeToString(entry.mode)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {filteredEntries.length === 0 && !loading && !error && (
          <div className="py-8 text-center text-sm text-zinc-500">
            {showHidden ? '空目录' : '空目录（可能包含隐藏文件）'}
          </div>
        )}
      </div>

      {menuEntry && (
        <div
          ref={menuRef}
          className="fixed z-50 w-40 rounded-lg border border-zinc-700 bg-zinc-800 p-1 shadow-lg"
          style={{ top: menuPos.y, left: menuPos.x }}
        >
          {menuEntry.is_dir && (
            <button
              type="button"
              onClick={() => handleNavigate(menuEntry)}
              className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
            >
              打开
            </button>
          )}
          {!menuEntry.is_dir && (
            <button
              type="button"
              onClick={() => handleDownload(menuEntry)}
              className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
            >
              下载
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setRenameEntry(menuEntry);
              setRenameValue(menuEntry.name);
              setMenuEntry(null);
            }}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
          >
            重命名
          </button>
          <button
            type="button"
            onClick={() => handleCopyPath(menuEntry)}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
          >
            复制路径
          </button>
          <hr className="border-zinc-700 my-1" />
          <button
            type="button"
            onClick={() => {
              setDeleteConfirm(menuEntry);
              setMenuEntry(null);
            }}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-red-400 hover:bg-red-950/60"
          >
            删除
          </button>
        </div>
      )}

      {renameEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-80 rounded-xl bg-zinc-800 border border-zinc-700 shadow-2xl p-4">
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
        </div>
      )}

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-80 rounded-xl bg-zinc-800 border border-zinc-700 shadow-2xl p-4">
            <h3 className="text-sm font-semibold text-red-300 mb-2">确认删除</h3>
            <p className="text-xs text-zinc-400 mb-1">
              类型: <span className="text-zinc-200">{deleteConfirm.is_dir ? '目录' : '文件'}</span>
            </p>
            <p className="text-xs text-zinc-400 mb-4">
              名称: <span className="text-zinc-200">{deleteConfirm.name}</span>
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
