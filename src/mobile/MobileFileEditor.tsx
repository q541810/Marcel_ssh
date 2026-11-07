import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, Loader2, Redo2, Undo2 } from 'lucide-react';
import { redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import type { ViewUpdate } from '@codemirror/view';
import { sftpReadFile, sftpWriteFile, sftpGetMtime } from '@/lib/tauri';
import { formatSize, getErrorMessage } from '@/lib/sftp-helpers';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';
import { decideSaveAction, isFileMissingMessage } from './editorModel';
import { useCodeEditorView } from '@/hooks/useCodeEditorView';
import { readDocText } from '@/lib/codeEditor';
import MobileSheet from './ui/MobileSheet';
import MobileFullscreenPage from './ui/MobileFullscreenPage';

interface MobileFileEditorProps {
  open: boolean;
  sessionId: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  onClose: () => void;
  /** 关闭开始的那一刻（退出动画之前）；见 `useAnimatedClose`。 */
  onCloseStart?: () => void;
  onSaved: () => void;
}

/**
 * Full-screen touch-first text editor for the mobile shell.
 * Same CodeMirror core as the desktop editor (`lib/codeEditor`), so undo/redo,
 * syntax highlighting and line-ending handling are one implementation; the
 * mobile variant keeps the native selection handles (no drawn selection layer).
 * Same SFTP read/write/mtime-conflict contract as the desktop editor.
 */
export default function MobileFileEditor({
  open,
  sessionId,
  filePath,
  fileName,
  fileSize,
  onClose,
  onCloseStart,
  onSaved,
}: MobileFileEditorProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [canUndoNow, setCanUndoNow] = useState(false);
  const [canRedoNow, setCanRedoNow] = useState(false);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);
  const originalContentRef = useRef('');
  const mtimeRef = useRef(0);
  /** 原文是否带 UTF-8 BOM：保存时原样回传，避免静默丢掉 BOM（与桌面端一致）。 */
  const hasBomRef = useRef(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const {
    closing,
    requestClose,
    onAnimationEnd: onExitAnimationEnd,
  } = useAnimatedClose(onClose, onCloseStart);

  // 每次编辑后同步「是否有未保存修改」与撤销/重做可用性。脏判断先比长度再比全文：
  // 绝大多数按键会改变长度，不必每次都拼接整份文本（上限 2 MB）。
  const handleUpdate = useCallback((u: ViewUpdate) => {
    if (u.docChanged) {
      const original = originalContentRef.current;
      setDirty(
        u.state.doc.length !== original.length || readDocText(u.state) !== original,
      );
    }
    setCanUndoNow(undoDepth(u.state) > 0);
    setCanRedoNow(redoDepth(u.state) > 0);
  }, []);

  const {
    containerRef: editorContainerRef,
    viewRef,
    create: createEditor,
    destroy: destroyEditor,
  } = useCodeEditorView({
    fileName,
    variant: 'mobile',
    onSave: () => void saveRef.current(),
    onUpdate: handleUpdate,
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDirty(false);
    setCanUndoNow(false);
    setCanRedoNow(false);
    setSavedIndicator(false);
    setCloseConfirmOpen(false);
    setOverwriteConfirmOpen(false);

    (async () => {
      try {
        const result = await sftpReadFile(sessionId, filePath);
        if (cancelled) return;
        mtimeRef.current = result.mtime;
        hasBomRef.current = result.hasBom;
        // 脏判断的基线取编辑器视角下的原文（换行符已按文档规则处理），而不是后端原串
        const baseline = await createEditor(result.content, () => cancelled);
        if (baseline !== null) originalContentRef.current = baseline;
      } catch (err) {
        if (cancelled) return;
        setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      destroyEditor();
    };
  }, [open, sessionId, filePath, createEditor, destroyEditor]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const doSave = useCallback(async (): Promise<boolean> => {
    const view = viewRef.current;
    if (!view) return false;
    setSaving(true);
    setError(null);
    try {
      const content = readDocText(view.state);
      // bom 原样回传：后端读到 BOM 会剥掉再给编辑器，保存时必须补回去
      await sftpWriteFile(sessionId, filePath, content, hasBomRef.current);
      originalContentRef.current = content;
      // 保存期间用户可能又改了：以保存出去的那一版为基线重新比一次
      setDirty(readDocText(view.state) !== content);
      try {
        mtimeRef.current = await sftpGetMtime(sessionId, filePath);
      } catch {
        // Ignore mtime fetch error after save (same as desktop).
      }
      setSavedIndicator(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSavedIndicator(false), 2000);
      onSaved();
      return true;
    } catch (err) {
      setError(`保存失败：${getErrorMessage(err)}`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [sessionId, filePath, onSaved, viewRef]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!viewRef.current) return false;
    let remoteMtime: number | null = null;
    try {
      remoteMtime = await sftpGetMtime(sessionId, filePath);
    } catch (err) {
      const msg = getErrorMessage(err);
      if (isFileMissingMessage(msg)) {
        setError('文件已不存在，无法保存');
        return false;
      }
      // Other probe errors: proceed with the save attempt.
    }
    if (decideSaveAction(remoteMtime, mtimeRef.current) === 'conflict') {
      setOverwriteConfirmOpen(true);
      return false;
    }
    return doSave();
  }, [sessionId, filePath, doSave, viewRef]);
  saveRef.current = handleSave;

  const handleClose = useCallback(() => {
    if (dirty) {
      setCloseConfirmOpen(true);
    } else {
      requestClose();
    }
  }, [dirty, requestClose]);

  // 撤销/重做就是 CodeMirror 的命令（与桌面快捷键同一份历史），它自己会把光标滚进视野
  const handleUndo = () => {
    if (viewRef.current) undo(viewRef.current);
  };
  const handleRedo = () => {
    if (viewRef.current) redo(viewRef.current);
  };

  if (!open) return null;

  return (
    <MobileFullscreenPage
      region="mobile-file-editor"
      closing={closing}
      onExitAnimationEnd={onExitAnimationEnd}
      // Android back gesture = header back button (dirty check included).
      onBack={handleClose}
    >
      {/* Header */}
      <header
        className="flex flex-shrink-0 items-center gap-1 border-b border-edge-subtle px-1 py-2"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
      >
        <button
          type="button"
          onClick={handleClose}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-fg-secondary active:bg-state-soft"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium text-fg">
            {fileName}
            {dirty && <span className="ml-1 text-amber-400">●</span>}
          </div>
          <div className="text-caption text-fg-tertiary">
            {formatSize(fileSize)}
            {savedIndicator && (
              <span className="ml-2 text-emerald-400">已保存</span>
            )}
          </div>
        </div>
        {/* 按下时不抢焦点：编辑器正在输入时点按钮不能把软键盘收起来 */}
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={handleUndo}
          disabled={loading || !canUndoNow}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-fg-secondary active:bg-state-soft disabled:opacity-30"
          aria-label="撤销"
        >
          <Undo2 className="h-5 w-5" />
        </button>
        <button
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={handleRedo}
          disabled={loading || !canRedoNow}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-fg-secondary active:bg-state-soft disabled:opacity-30"
          aria-label="重做"
        >
          <Redo2 className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || loading || !dirty}
          className="mr-2 flex-shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-body font-medium text-white active:bg-indigo-500 disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </header>

      {error && (
        <div className="flex flex-shrink-0 items-center justify-between border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-meta text-red-300">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 flex-shrink-0 p-1 text-red-400"
            aria-label="关闭错误"
          >
            ✕
          </button>
        </div>
      )}

      {/* Body：容器始终在，加载态盖在上面（view 要挂在已存在的容器里） */}
      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-surface-sunken text-body text-fg-secondary">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载文件…
          </div>
        )}
        <div ref={editorContainerRef} className="h-full" />
      </div>

      {/* Unsaved changes sheet */}
      <MobileSheet
        open={closeConfirmOpen}
        onClose={() => setCloseConfirmOpen(false)}
        title="未保存的修改"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className="pb-1 text-body text-fg-secondary">
            文件有未保存的修改，是否在关闭前保存？
          </p>
          <button
            type="button"
            onClick={async () => {
              setCloseConfirmOpen(false);
              const ok = await handleSave();
              if (ok) requestClose();
            }}
            className="rounded-xl bg-indigo-600 px-4 py-3 text-body font-medium text-white active:bg-indigo-500"
          >
            保存并关闭
          </button>
          <button
            type="button"
            onClick={() => {
              setCloseConfirmOpen(false);
              requestClose();
            }}
            className="rounded-xl bg-surface-raised px-4 py-3 text-body text-red-300 active:bg-state-mid"
          >
            放弃修改
          </button>
          <button
            type="button"
            onClick={() => setCloseConfirmOpen(false)}
            className="rounded-xl px-4 py-3 text-body text-fg-secondary active:bg-state-soft"
          >
            继续编辑
          </button>
        </div>
      </MobileSheet>

      {/* External change conflict sheet */}
      <MobileSheet
        open={overwriteConfirmOpen}
        onClose={() => setOverwriteConfirmOpen(false)}
        title="文件已被外部修改"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className="pb-1 text-body text-fg-secondary">
            此文件在编辑期间被其他程序修改过。覆盖将丢失外部修改。
          </p>
          <button
            type="button"
            onClick={async () => {
              setOverwriteConfirmOpen(false);
              await doSave();
            }}
            className="rounded-xl bg-amber-600 px-4 py-3 text-body font-medium text-white active:bg-amber-500"
          >
            覆盖保存
          </button>
          <button
            type="button"
            onClick={() => setOverwriteConfirmOpen(false)}
            className="rounded-xl px-4 py-3 text-body text-fg-secondary active:bg-state-soft"
          >
            取消
          </button>
        </div>
      </MobileSheet>
    </MobileFullscreenPage>
  );
}
