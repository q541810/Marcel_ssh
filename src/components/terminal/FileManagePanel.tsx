import { useState, useEffect, useCallback, useRef } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, writeFile } from '@tauri-apps/plugin-fs';
import { sshExec } from '@/lib/tauri';

interface FileManagePanelProps {
  sessionId: string;
}

interface FileItem {
  name: string;
  isDir: boolean;
  size: string;
  modified: string;
  permissions: string;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  item: FileItem | null;
}

interface RenameModalState {
  visible: boolean;
  oldName: string;
  newName: string;
  isDir: boolean;
}

interface NewFolderModalState {
  visible: boolean;
  name: string;
}

interface ClipboardState {
  sourcePath: string;
  name: string;
  isDir: boolean;
  mode: 'copy' | 'cut';
}

function parseLsOutput(output: string): FileItem[] {
  const lines = output.split('\n').filter((line) => line.trim() && !line.startsWith('total'));
  return lines.map((line) => {
    const parts = line.split(/\s+/);
    if (parts.length < 9) {
      return { name: line.trim(), isDir: false, size: '', modified: '', permissions: '' };
    }
    const permissions = parts[0];
    const isDir = permissions.startsWith('d');
    const size = parts[4];
    const modified = `${parts[5]} ${parts[6]} ${parts[7]}`;
    const name = parts.slice(8).join(' ');
    return { name, isDir, size, modified, permissions };
  }).filter((item) => item.name !== '.' && item.name !== '..');
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

export default function FileManagePanel({ sessionId }: FileManagePanelProps) {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    item: null,
  });
  const [renameModal, setRenameModal] = useState<RenameModalState>({
    visible: false,
    oldName: '',
    newName: '',
    isDir: false,
  });
  const [newFolderModal, setNewFolderModal] = useState<NewFolderModalState>({
    visible: false,
    name: '',
  });
  const [uploading, setUploading] = useState(false);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const pwdResult = await sshExec(sessionId, 'pwd');
      const basePath = pwdResult.trim();
      const targetPath = path || basePath;
      const lsResult = await sshExec(sessionId, `ls -la "${targetPath}" 2>&1 || echo "ERROR"`);
      if (lsResult.includes('ERROR') || lsResult.includes('No such file or directory')) {
        setError('无法访问该目录');
        setFiles([]);
      } else {
        setFiles(parseLsOutput(lsResult));
        setCurrentPath(targetPath);
        setPathInput(targetPath);
      }
    } catch (err) {
      setError(`加载失败: ${String(err)}`);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadDirectory('');
  }, [loadDirectory]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu({ visible: false, x: 0, y: 0, item: null });
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const handleNavigate = (item: FileItem) => {
    if (item.isDir) {
      const newPath = currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`;
      loadDirectory(newPath);
    }
  };

  const handleGoUp = () => {
    if (currentPath === '/' || !currentPath) return;
    const parentPath = currentPath.split('/').slice(0, -1).join('/') || '/';
    loadDirectory(parentPath);
  };

  const handleGoToPath = () => {
    if (pathInput.trim()) {
      loadDirectory(pathInput.trim());
    }
  };

  const handleRefresh = () => {
    loadDirectory(currentPath);
  };

  const handleGoHome = () => {
    loadDirectory('');
  };

  const handleContextMenu = (e: React.MouseEvent, item: FileItem) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, item });
  };

  const handleDelete = async () => {
    const item = contextMenu.item;
    if (!item) return;
    setContextMenu({ visible: false, x: 0, y: 0, item: null });

    const fullPath = currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`;
    const confirmMsg = item.isDir
      ? `确定要删除目录「${item.name}」及其所有内容吗？此操作不可撤销。`
      : `确定要删除文件「${item.name}」吗？此操作不可撤销。`;

    if (!window.confirm(confirmMsg)) return;

    try {
      const cmd = item.isDir ? `rm -rf "${fullPath}"` : `rm -f "${fullPath}"`;
      await sshExec(sessionId, cmd);
      setMessage(`已删除: ${item.name}`);
      loadDirectory(currentPath);
    } catch (err) {
      setError(`删除失败: ${String(err)}`);
    }
  };

  const handleCopy = () => {
    const item = contextMenu.item;
    if (!item) return;
    setContextMenu({ visible: false, x: 0, y: 0, item: null });

    const fullPath = currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`;
    setClipboard({ sourcePath: fullPath, name: item.name, isDir: item.isDir, mode: 'copy' });
    setMessage(`已复制到剪贴板: ${item.name}`);
  };

  const handleCut = () => {
    const item = contextMenu.item;
    if (!item) return;
    setContextMenu({ visible: false, x: 0, y: 0, item: null });

    const fullPath = currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`;
    setClipboard({ sourcePath: fullPath, name: item.name, isDir: item.isDir, mode: 'cut' });
    setMessage(`已剪切到剪贴板: ${item.name}`);
  };

  const handlePaste = async () => {
    if (!clipboard) return;

    const destPath = currentPath === '/' ? `/${clipboard.name}` : `${currentPath}/${clipboard.name}`;

    if (clipboard.sourcePath === destPath) {
      setError('源路径和目标路径相同');
      return;
    }

    try {
      const cmd = clipboard.isDir
        ? clipboard.mode === 'cut'
          ? `mv "${clipboard.sourcePath}" "${destPath}"`
          : `cp -r "${clipboard.sourcePath}" "${destPath}"`
        : clipboard.mode === 'cut'
          ? `mv "${clipboard.sourcePath}" "${destPath}"`
          : `cp "${clipboard.sourcePath}" "${destPath}"`;

      await sshExec(sessionId, cmd);
      setMessage(`已${clipboard.mode === 'cut' ? '移动' : '粘贴'}: ${clipboard.name}`);
      if (clipboard.mode === 'cut') {
        setClipboard(null);
      }
      loadDirectory(currentPath);
    } catch (err) {
      setError(`${clipboard.mode === 'cut' ? '移动' : '粘贴'}失败: ${String(err)}`);
    }
  };

  const handleRenameOpen = () => {
    const item = contextMenu.item;
    if (!item) return;
    setContextMenu({ visible: false, x: 0, y: 0, item: null });
    setRenameModal({ visible: true, oldName: item.name, newName: item.name, isDir: item.isDir });
  };

  const handleRenameSubmit = async () => {
    if (!renameModal.newName.trim() || renameModal.newName === renameModal.oldName) {
      setRenameModal({ visible: false, oldName: '', newName: '', isDir: false });
      return;
    }

    const oldPath = currentPath === '/' ? `/${renameModal.oldName}` : `${currentPath}/${renameModal.oldName}`;
    const newPath = currentPath === '/' ? `/${renameModal.newName}` : `${currentPath}/${renameModal.newName}`;

    try {
      await sshExec(sessionId, `mv "${oldPath}" "${newPath}"`);
      setMessage(`已重命名: ${renameModal.oldName} -> ${renameModal.newName}`);
      setRenameModal({ visible: false, oldName: '', newName: '', isDir: false });
      loadDirectory(currentPath);
    } catch (err) {
      setError(`重命名失败: ${String(err)}`);
    }
  };

  const handleDownload = async () => {
    const item = contextMenu.item;
    if (!item || item.isDir) return;
    setContextMenu({ visible: false, x: 0, y: 0, item: null });

    const remotePath = currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`;

    const savePath = await save({
      defaultPath: item.name,
      title: '保存文件',
    });
    if (!savePath) return;

    setMessage(`正在下载: ${item.name}...`);

    try {
      const b64Result = await sshExec(sessionId, `base64 -w0 "${remotePath}" 2>/dev/null || base64 "${remotePath}"`);
      const b64Trimmed = b64Result.trim();
      if (!b64Trimmed) {
        setError('下载失败: 文件为空或无法读取');
        return;
      }
      const binaryStr = atob(b64Trimmed);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      await writeFile(savePath, bytes);
      setMessage(`已下载: ${item.name} -> ${savePath.split(/[/\\]/).pop()}`);
    } catch (err) {
      setError(`下载失败: ${String(err)}`);
    }
  };

  const handleUpload = async () => {
    try {
      const selected = await open({
        multiple: true,
        title: '选择要上传的文件',
      });
      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      setUploading(true);
      setMessage(`正在上传 ${paths.length} 个文件...`);

      for (const localPath of paths) {
        const fileName = localPath.split(/[/\\]/).pop() || 'upload';
        const remotePath = currentPath === '/' ? `/${fileName}` : `${currentPath}/${fileName}`;

        const fileData = await readFile(localPath);
        const b64 = arrayBufferToBase64(fileData.buffer as ArrayBuffer);

        const chunkSize = 60000;
        const chunks: string[] = [];
        for (let i = 0; i < b64.length; i += chunkSize) {
          chunks.push(b64.slice(i, i + chunkSize));
        }

        await sshExec(sessionId, `echo -n "" > "${remotePath}.b64"`);
        for (const chunk of chunks) {
          await sshExec(sessionId, `echo -n '${chunk}' >> "${remotePath}.b64"`);
        }
        await sshExec(sessionId, `base64 -d "${remotePath}.b64" > "${remotePath}" && rm -f "${remotePath}.b64"`);

        setMessage(`已上传: ${fileName}`);
      }

      loadDirectory(currentPath);
    } catch (err) {
      setError(`上传失败: ${String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const handleNewFolder = () => {
    setNewFolderModal({ visible: true, name: '' });
  };

  const handleNewFolderSubmit = async () => {
    if (!newFolderModal.name.trim()) {
      setNewFolderModal({ visible: false, name: '' });
      return;
    }

    const dirPath = currentPath === '/' ? `/${newFolderModal.name.trim()}` : `${currentPath}/${newFolderModal.name.trim()}`;
    try {
      await sshExec(sessionId, `mkdir -p "${dirPath}"`);
      setMessage(`已创建目录: ${newFolderModal.name.trim()}`);
      setNewFolderModal({ visible: false, name: '' });
      loadDirectory(currentPath);
    } catch (err) {
      setError(`创建目录失败: ${String(err)}`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <button
          type="button"
          onClick={handleGoHome}
          className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          title="主目录"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleGoUp}
          disabled={currentPath === '/' || !currentPath}
          className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
          title="上级目录"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          title="刷新"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
        <div className="h-4 w-px bg-zinc-700" />
        <button
          type="button"
          onClick={handleNewFolder}
          className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          title="新建目录"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleUpload}
          disabled={uploading}
          className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
          title="上传文件"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handlePaste}
          disabled={!clipboard}
          className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed"
          title={clipboard ? `粘贴: ${clipboard.name} (${clipboard.mode === 'cut' ? '剪切' : '复制'})` : '粘贴（无内容）'}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
        </button>
        <div className="flex-1 flex items-center gap-1">
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleGoToPath();
              }
            }}
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-indigo-500"
            placeholder="输入路径..."
          />
          <button
            type="button"
            onClick={handleGoToPath}
            className="rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
          >
            转到
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3" onContextMenu={(e) => e.preventDefault()}>
        {error && (
          <div className="mb-2 rounded-lg bg-red-950/60 px-3 py-2 text-xs text-red-200">{error}</div>
        )}
        {message && (
          <div className="mb-2 rounded-lg bg-indigo-950/60 px-3 py-2 text-xs text-indigo-200">{message}</div>
        )}

        {loading ? (
          <div className="py-6 text-center text-sm text-zinc-500">加载中...</div>
        ) : uploading ? (
          <div className="py-6 text-center text-sm text-zinc-500">上传中...</div>
        ) : files.length === 0 ? (
          <div className="py-6 text-center text-sm text-zinc-500">空目录</div>
        ) : (
          <div className="flex flex-col gap-1">
            {files.map((item, index) => (
              <div
                key={`${item.name}-${index}`}
                className={`group flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2 transition-all duration-200 ${
                  item.isDir
                    ? 'hover:border-zinc-600 hover:bg-zinc-900 hover:shadow-md cursor-pointer'
                    : 'hover:border-zinc-700 hover:bg-zinc-900/50'
                }`}
                onClick={() => handleNavigate(item)}
                onContextMenu={(e) => handleContextMenu(e, item)}
              >
                <div className="flex-shrink-0">
                  {item.isDir ? (
                    <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm truncate ${item.isDir ? 'text-zinc-100 group-hover:text-zinc-50' : 'text-zinc-400'}`}>
                    {item.name}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {item.permissions} {item.size} {item.modified}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex-shrink-0 border-t border-zinc-800 px-3 py-1.5 text-xs text-zinc-500">
        当前路径: {currentPath || '/'} &middot; {files.length} 项
        {clipboard && (
          <span className="ml-3 text-indigo-400">
            剪贴板: {clipboard.mode === 'cut' ? '剪切' : '复制'} {clipboard.name}
          </span>
        )}
      </div>

      {contextMenu.visible && contextMenu.item && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-40 rounded-lg border border-zinc-700 bg-zinc-800 p-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.item.isDir && (
            <button
              type="button"
              onClick={() => {
                handleNavigate(contextMenu.item!);
                setContextMenu({ visible: false, x: 0, y: 0, item: null });
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
              </svg>
              打开
            </button>
          )}
          {!contextMenu.item.isDir && (
            <button
              type="button"
              onClick={handleDownload}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              下载
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            复制
          </button>
          <button
            type="button"
            onClick={handleCut}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
            </svg>
            剪切
          </button>
          <button
            type="button"
            onClick={handleRenameOpen}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            重命名
          </button>
          <div className="my-1 h-px bg-zinc-700" />
          <button
            type="button"
            onClick={handleDelete}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-red-400 hover:bg-red-950/60"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            删除
          </button>
        </div>
      )}

      {renameModal.visible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setRenameModal({ visible: false, oldName: '', newName: '', isDir: false })} />
          <div className="relative w-full max-w-sm mx-4 rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl">
            <div className="px-4 py-3 border-b border-zinc-700">
              <h2 className="text-sm font-semibold text-zinc-200">重命名</h2>
            </div>
            <div className="px-4 py-3">
              <label className="mb-1 block text-xs text-zinc-400">
                {renameModal.isDir ? '目录名称' : '文件名称'}
              </label>
              <input
                value={renameModal.newName}
                onChange={(e) => setRenameModal({ ...renameModal, newName: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameSubmit();
                  if (e.key === 'Escape') setRenameModal({ visible: false, oldName: '', newName: '', isDir: false });
                }}
                autoFocus
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
              />
            </div>
            <div className="flex justify-end gap-2 px-4 pb-4">
              <button
                type="button"
                onClick={() => setRenameModal({ visible: false, oldName: '', newName: '', isDir: false })}
                className="rounded-md px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleRenameSubmit}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {newFolderModal.visible && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setNewFolderModal({ visible: false, name: '' })} />
          <div className="relative w-full max-w-sm mx-4 rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl">
            <div className="px-4 py-3 border-b border-zinc-700">
              <h2 className="text-sm font-semibold text-zinc-200">新建目录</h2>
            </div>
            <div className="px-4 py-3">
              <label className="mb-1 block text-xs text-zinc-400">目录名称</label>
              <input
                value={newFolderModal.name}
                onChange={(e) => setNewFolderModal({ ...newFolderModal, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleNewFolderSubmit();
                  if (e.key === 'Escape') setNewFolderModal({ visible: false, name: '' });
                }}
                autoFocus
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
              />
            </div>
            <div className="flex justify-end gap-2 px-4 pb-4">
              <button
                type="button"
                onClick={() => setNewFolderModal({ visible: false, name: '' })}
                className="rounded-md px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleNewFolderSubmit}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}