import { useCallback, useRef } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  sftpMkdir,
  sftpRemove,
  sftpRemoveViaShell,
  sftpRename,
  sftpWriteFile,
  sftpExtractArchive,
} from '@/lib/tauri';
import { getErrorMessage } from '@/lib/sftp-helpers';
import { joinRemotePath } from '@/lib/sftpFileOpen';
import { useFileClipboardStore } from '@/stores/fileClipboardStore';
import {
  pasteBlockedReason,
  pasteClipboard,
  pasteProgressText,
  renamedNotice,
} from '@/lib/filePaste';
import type { FolderUploadMode } from '@/hooks/useSftpUpload';
import { isSameOrUnder, parentDir, type FileTarget } from './fileActionModel';
import { normalizeRemotePath } from './fileTreeModel';

/**
 * 文件管理器的「改动类」动作：右侧列表与左侧目录树**共用同一份**。
 * 动作只认绝对路径（`FileTarget`），不再依赖「当前目录 + 条目名」。
 * 每个动作做完后都会刷新受影响的目录（`refreshDir`：当前目录重载列表，
 * 树里已加载的节点重载子目录），所以不论从哪里发起，两边都保持同步。
 */
export interface FileActionsDeps {
  sessionId: string;
  getCurrentPath: () => string;
  /** 刷新某个目录：是当前目录就重载列表，树里已缓存该节点就重载节点。 */
  refreshDir: (dir: string) => Promise<void>;
  /** 树里丢掉某个目录及其子孙的缓存（目录被删/改名后）。 */
  forgetDir: (dir: string) => void;
  /** 当前目录被删或被改名搬走：由面板决定去哪（删除 → 去上级；改名 → 去新路径）。 */
  onCurrentRelocated: (from: string, to: string) => void;
  setError: (message: string | null) => void;
  setLoading: (loading: boolean) => void;
  setPasteNotice: (notice: string | null) => void;
  setPasteStatus: (status: string | null) => void;
  isPasting: () => boolean;
  uploadFile: (
    localPath: string,
    fileName: string,
    targetPath: string,
    onFinished?: () => void,
  ) => void;
  uploadFolder: (
    localPath: string,
    folderName: string,
    mode: FolderUploadMode,
    onFinished?: () => void,
    destDir?: string,
  ) => void;
}

function uniqueDirs(dirs: string[]): string[] {
  return [...new Set(dirs.map((d) => normalizeRemotePath(d)))];
}

export function useFileActions(deps: FileActionsDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  /** 只有动到「当前目录」时才亮列表的加载态；动树上别的目录不该让右边列表闪一下。 */
  const touchesCurrent = (dirs: string[]) => {
    const cur = normalizeRemotePath(depsRef.current.getCurrentPath());
    return dirs.some((d) => normalizeRemotePath(d) === cur);
  };

  const copyPaths = useCallback(async (targets: FileTarget[]) => {
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(targets.map((t) => t.path).join('\n'));
    } catch {
      // ignore
    }
  }, []);

  /** 复制 / 剪切：只记进剪贴板，不动远端。 */
  const clip = useCallback((targets: FileTarget[], cut: boolean) => {
    if (targets.length === 0) return;
    const d = depsRef.current;
    d.setPasteNotice(null);
    useFileClipboardStore.getState().set({
      sessionId: d.sessionId,
      dir: parentDir(targets[0].path),
      items: targets.map((t) => ({ name: t.name, isDir: t.isDir })),
      cut,
    });
  }, []);

  /** 粘贴进 destDir。 */
  const paste = useCallback(async (destDir: string) => {
    const d = depsRef.current;
    const clipboard = useFileClipboardStore.getState().clipboard;
    if (!clipboard || pasteBlockedReason(clipboard, d.sessionId) || d.isPasting()) return;
    d.setPasteNotice(null);
    try {
      const result = await pasteClipboard(clipboard, destDir, (i, n) =>
        d.setPasteStatus(pasteProgressText(i, n, clipboard.cut)),
      );
      // 剪切成功的项已经搬走，剪贴板作废；失败的项留着，方便换个目录重试。
      if (clipboard.cut) {
        const failed = new Set(result.failed);
        const left = clipboard.items.filter((it) => failed.has(it.name));
        if (left.length === 0) useFileClipboardStore.getState().clear();
        else useFileClipboardStore.getState().set({ ...clipboard, items: left });
        // 被搬走的目录：树里旧位置的缓存作废
        for (const item of clipboard.items) {
          if (item.isDir && !failed.has(item.name)) {
            d.forgetDir(joinRemotePath(clipboard.dir, item.name));
          }
        }
      }
      if (result.errors.length > 0) {
        d.setError(`部分${clipboard.cut ? '移动' : '复制'}失败：${result.errors.join('；')}`);
      }
      d.setPasteNotice(renamedNotice(result));
      await Promise.all(
        uniqueDirs(clipboard.cut ? [destDir, clipboard.dir] : [destDir]).map((dir) =>
          d.refreshDir(dir),
        ),
      );
    } finally {
      d.setPasteStatus(null);
    }
  }, []);

  /**
   * 删除。普通删除走 SFTP 逐个 remove，快速删除打包成 shell rm（sftpRemoveViaShell）；
   * 逐条聚合错误。
   */
  const remove = useCallback(async (targets: FileTarget[], quick: boolean) => {
    const d = depsRef.current;
    const label = quick ? '快速删除' : '删除';
    const parents = uniqueDirs(targets.map((t) => parentDir(t.path)));
    const showLoading = touchesCurrent(parents);
    try {
      if (showLoading) d.setLoading(true);
      const errors: string[] = [];
      const removed: FileTarget[] = [];
      for (const target of targets) {
        try {
          if (quick) {
            await sftpRemoveViaShell(d.sessionId, target.path, target.isDir);
          } else {
            await sftpRemove(d.sessionId, target.path, target.isDir);
          }
          removed.push(target);
        } catch (err) {
          errors.push(`${target.name}: ${getErrorMessage(err)}`);
        }
      }
      if (errors.length > 0) {
        d.setError(`部分${label}失败：${errors.join('；')}`);
      }
      for (const target of removed) {
        if (!target.isDir) continue;
        d.forgetDir(target.path);
        // 正在看的目录（或它的祖先）被删：留在原地只会是一片报错，回到被删目录的上级。
        if (isSameOrUnder(d.getCurrentPath(), target.path)) {
          d.onCurrentRelocated(target.path, parentDir(target.path));
        }
      }
      await Promise.all(parents.map((dir) => d.refreshDir(dir)));
    } catch (err) {
      d.setError(`${label}失败：${getErrorMessage(err)}`);
    } finally {
      if (showLoading) d.setLoading(false);
    }
  }, []);

  const rename = useCallback(async (target: FileTarget, newName: string) => {
    const d = depsRef.current;
    const parent = parentDir(target.path);
    const showLoading = touchesCurrent([parent]);
    try {
      if (showLoading) d.setLoading(true);
      const newPath = joinRemotePath(parent, newName);
      await sftpRename(d.sessionId, target.path, newPath);
      if (target.isDir) {
        d.forgetDir(target.path);
        const cur = normalizeRemotePath(d.getCurrentPath());
        if (isSameOrUnder(cur, target.path)) {
          const from = normalizeRemotePath(target.path);
          d.onCurrentRelocated(from, normalizeRemotePath(newPath) + cur.slice(from.length));
        }
      }
      await d.refreshDir(parent);
    } catch (err) {
      d.setError(`重命名失败：${getErrorMessage(err)}`);
    } finally {
      if (showLoading) d.setLoading(false);
    }
  }, []);

  const mkdir = useCallback(async (parent: string, name: string) => {
    const d = depsRef.current;
    const showLoading = touchesCurrent([parent]);
    try {
      if (showLoading) d.setLoading(true);
      await sftpMkdir(d.sessionId, joinRemotePath(parent, name));
      await d.refreshDir(parent);
    } catch (err) {
      d.setError(`创建文件夹失败：${getErrorMessage(err)}`);
    } finally {
      if (showLoading) d.setLoading(false);
    }
  }, []);

  const createFile = useCallback(async (parent: string, name: string) => {
    const d = depsRef.current;
    const showLoading = touchesCurrent([parent]);
    try {
      if (showLoading) d.setLoading(true);
      await sftpWriteFile(d.sessionId, joinRemotePath(parent, name), '');
      await d.refreshDir(parent);
    } catch (err) {
      d.setError(`创建文件失败：${getErrorMessage(err)}`);
    } finally {
      if (showLoading) d.setLoading(false);
    }
  }, []);

  const extract = useCallback(async (archive: FileTarget, targetDir: string) => {
    const d = depsRef.current;
    const dirs = uniqueDirs([parentDir(archive.path), targetDir, parentDir(targetDir)]);
    const showLoading = touchesCurrent(dirs);
    try {
      if (showLoading) d.setLoading(true);
      await sftpExtractArchive(d.sessionId, archive.path, targetDir);
      await Promise.all(dirs.map((dir) => d.refreshDir(dir)));
    } catch (err) {
      d.setError(`解压失败：${getErrorMessage(err)}`);
    } finally {
      if (showLoading) d.setLoading(false);
    }
  }, []);

  /** 选一个本机文件上传进 destDir。 */
  const pickAndUpload = useCallback(async (destDir: string) => {
    const d = depsRef.current;
    try {
      const picked = await open({ multiple: false, title: '选择文件' });
      if (!picked) return;
      const localPath = Array.isArray(picked) ? picked[0] : picked;
      const fileName = localPath.split(/[/\\]/).pop() || 'upload';
      d.uploadFile(localPath, fileName, joinRemotePath(destDir, fileName), () => {
        void d.refreshDir(destDir);
      });
    } catch (err) {
      d.setError(`上传失败：${getErrorMessage(err)}`);
    }
  }, []);

  /** 本机文件逐个上传进 destDir（拖入 / 多选）。 */
  const uploadPaths = useCallback((paths: string[], destDir: string) => {
    const d = depsRef.current;
    for (const localPath of paths) {
      const fileName = localPath.split(/[/\\]/).pop() || 'upload';
      d.uploadFile(localPath, fileName, joinRemotePath(destDir, fileName), () => {
        void d.refreshDir(destDir);
      });
    }
  }, []);

  const uploadFolderTo = useCallback(
    (localPath: string, folderName: string, mode: FolderUploadMode, destDir: string) => {
      const d = depsRef.current;
      d.uploadFolder(
        localPath,
        folderName,
        mode,
        () => {
          void d.refreshDir(destDir);
        },
        destDir,
      );
    },
    [],
  );

  /** 多个本机文件打成 zip 上传并解压进 destDir。 */
  const uploadAsZip = useCallback(
    async (paths: string[], destDir: string, setWarning: (warning: string | null) => void) => {
      const d = depsRef.current;
      const { sftpPrepareDragUpload, sftpCleanupTempDir } = await import('@/lib/tauri');
      const { enqueueTransfer, createTransferId } = await import('@/stores/transferScheduler');

      setWarning(null);
      let tempDir: string;
      let failures: string[];
      try {
        // 1. 后端创建临时目录并复制文件；复制失败的条目在 failures 里（`路径: 原因`）
        ({ tempDir, failures } = await sftpPrepareDragUpload(paths));
      } catch (err) {
        d.setError(`打包上传失败：${getErrorMessage(err)}`);
        return;
      }

      /** failures 可能很长，横幅里最多列 3 条，其余用计数收口。 */
      const brief = (list: string[]) =>
        `${list.slice(0, 3).join('；')}${list.length > 3 ? ` 等 ${list.length} 项` : ''}`;

      if (failures.length >= paths.length) {
        // 一条都没复制进去：没有可上传的内容，中止并说清原因（顺手清掉空临时目录）
        void sftpCleanupTempDir(tempDir).catch(() => {});
        d.setError(`打包上传失败：${paths.length} 项全部复制失败（${brief(failures)}）`);
        return;
      }

      if (failures.length > 0) {
        // 部分失败仍继续上传，但必须显眼告知缺了哪些条目 —— 否则界面只显示
        // 「上传完成」，用户会以为全传上去了。用常驻（需手动关闭）的提示承载。
        setWarning(
          `以下 ${failures.length}/${paths.length} 项复制失败，未包含在本次上传中：${brief(failures)}`,
        );
      }

      // 2. 入队打包上传（解压到目标目录），完成后清理临时目录并刷新
      const preparedDir = tempDir;
      enqueueTransfer(
        {
          id: createTransferId(),
          kind: 'folder-upload',
          sessionId: d.sessionId,
          fileName: `拖拽上传 (${paths.length - failures.length} 项)`,
          localPath: preparedDir,
          remotePath: destDir,
          flat: true,
          written: 0,
          total: 0,
          statusText: '排队中',
          createdAt: Date.now(),
        },
        () => {
          void sftpCleanupTempDir(preparedDir).catch(() => {});
          void d.refreshDir(destDir);
        },
      );
    },
    [],
  );

  return {
    copyPaths,
    clip,
    paste,
    remove,
    rename,
    mkdir,
    createFile,
    extract,
    pickAndUpload,
    uploadPaths,
    uploadFolderTo,
    uploadAsZip,
  };
}

export type FileActions = ReturnType<typeof useFileActions>;
