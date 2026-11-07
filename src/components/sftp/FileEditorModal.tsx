import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from '@codemirror/view';
import { sftpReadFile, sftpWriteFile, sftpGetMtime } from '@/lib/tauri';
import { formatSize, getErrorMessage } from '@/lib/sftp-helpers';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';
import { useCodeEditorView } from '@/hooks/useCodeEditorView';
import { readDocText } from '@/lib/codeEditor';

interface FileEditorModalProps {
  open: boolean;
  sessionId: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  onClose: () => void;
  onSaved: () => void;
}

type SaveResult = 'saved' | 'blocked' | 'failed';

export default function FileEditorModal({
  open,
  sessionId,
  filePath,
  fileName,
  fileSize,
  onClose,
  onSaved,
}: FileEditorModalProps) {
  const originalContentRef = useRef<string>('');
  const mtimeRef = useRef<number>(0);
  /** 原文是否带 UTF-8 BOM：保存时原样回传，避免静默丢掉 BOM。 */
  const hasBomRef = useRef(false);
  const saveRef = useRef<() => Promise<SaveResult>>(async () => 'blocked');

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);
  const [lineCount, setLineCount] = useState(0);
  const {
    closing,
    requestClose,
    onAnimationEnd: onExitAnimationEnd,
  } = useAnimatedClose(onClose);

  const updateLineCount = useCallback((view: EditorView) => {
    setLineCount(view.state.doc.lines);
  }, []);
  const {
    containerRef: editorContainerRef,
    viewRef,
    create: createEditor,
    destroy: destroyEditor,
  } = useCodeEditorView({
    fileName,
    variant: 'desktop',
    onSave: () => void saveRef.current(),
    onUpdate: (u) => updateLineCount(u.view),
  });

  const doSave = useCallback(async (): Promise<SaveResult> => {
    if (!viewRef.current) return 'blocked';
    setSaving(true);
    setError(null);
    try {
      const content = readDocText(viewRef.current.state);
      // bom 原样回传：后端读到 BOM 会剥掉再给编辑器，保存时必须补回去
      await sftpWriteFile(sessionId, filePath, content, hasBomRef.current);
      originalContentRef.current = content;
      // Update mtime after successful save
      try {
        const newMtime = await sftpGetMtime(sessionId, filePath);
        mtimeRef.current = newMtime;
      } catch {
        // Ignore mtime fetch error after save
      }
      setSavedIndicator(true);
      setTimeout(() => setSavedIndicator(false), 2000);
      onSaved();
      return 'saved';
    } catch (err) {
      setError(`保存失败：${getErrorMessage(err)}`);
      return 'failed';
    } finally {
      setSaving(false);
    }
  }, [sessionId, filePath, onSaved, viewRef]);

  const handleSave = useCallback(async (): Promise<SaveResult> => {
    if (!viewRef.current) return 'blocked';
    try {
      const currentMtime = await sftpGetMtime(sessionId, filePath);
      if (currentMtime !== mtimeRef.current) {
        setShowOverwriteConfirm(true);
        return 'blocked';
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      if (msg.includes('No such file') || msg.includes('不存在') || msg.includes('not found')) {
        setError('文件已不存在，无法保存');
        return 'failed';
      }
      // Other errors: proceed with save attempt
    }
    return doSave();
  }, [sessionId, filePath, doSave, viewRef]);

  saveRef.current = handleSave;

  const isDirty = useCallback(() => {
    if (!viewRef.current) return false;
    return readDocText(viewRef.current.state) !== originalContentRef.current;
  }, [viewRef]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      setShowCloseConfirm(false);
      setShowOverwriteConfirm(false);
      setSavedIndicator(false);

      try {
        const result = await sftpReadFile(sessionId, filePath);
        if (cancelled) return;
        mtimeRef.current = result.mtime;
        hasBomRef.current = result.hasBom;
        // 脏判断的基线取编辑器视角下的原文（换行符已按文档规则处理），而不是后端原串
        const baseline = await createEditor(result.content, () => cancelled);
        if (baseline !== null) {
          originalContentRef.current = baseline;
          if (viewRef.current) setLineCount(viewRef.current.state.doc.lines);
        }
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
  }, [open, sessionId, filePath, createEditor, destroyEditor, viewRef]);

  const handleClose = useCallback(() => {
    if (isDirty()) {
      setShowCloseConfirm(true);
    } else {
      requestClose();
    }
  }, [isDirty, requestClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        handleClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, handleClose]);

  const handleCloseWithoutSaving = useCallback(() => {
    setShowCloseConfirm(false);
    requestClose();
  }, [requestClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm ${
          closing ? 'modal-backdrop-exit' : 'modal-backdrop-enter'
        }`}
        onClick={handleClose}
      />

      <div
        onAnimationEnd={onExitAnimationEnd}
        className={`relative w-full max-w-5xl mx-4 h-[85vh] rounded-2xl bg-surface-raised border border-edge shadow-2xl flex flex-col overflow-hidden ${
          closing ? 'modal-panel-exit' : 'modal-panel-enter'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <svg className="w-4 h-4 text-fg-secondary flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <h2 className="text-read font-medium text-fg truncate">{filePath}</h2>
          </div>
          <button
            onClick={handleClose}
            className="text-fg-secondary hover:text-fg text-xl leading-none p-1"
            aria-label="关闭"
          >
            &times;
          </button>
        </div>

        {/* Info bar */}
        <div className="flex items-center gap-4 px-4 py-1.5 border-b border-edge/50 bg-surface-raised/50 flex-shrink-0">
          <span className="text-meta text-fg-tertiary">
            大小: <span className="text-fg-secondary">{formatSize(fileSize)}</span>
          </span>
          <span className="text-meta text-fg-tertiary">
            行数: <span className="text-fg-secondary">{loading ? '-' : lineCount}</span>
          </span>
          <span className="text-meta text-fg-tertiary">
            编码: <span className="text-fg-secondary">UTF-8</span>
          </span>
          {savedIndicator && (
            <span className="text-meta text-green-400 ml-auto">已保存</span>
          )}
        </div>

        {error && (
          <div className="flex items-center justify-between px-3 py-2 bg-red-500/10 border-b border-red-500/20 text-meta text-red-300 flex-shrink-0">
            <span>{error}</span>
            <div className="flex gap-2">
              <button onClick={handleSave} disabled={saving} className="text-red-400 hover:text-red-200">重试</button>
              <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200">✕</button>
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 min-h-0 flex flex-col relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-surface z-10">
              <div className="flex items-center gap-2 text-read text-fg-secondary">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                正在加载文件...
              </div>
            </div>
          )}

          <div ref={editorContainerRef} className="flex-1 min-h-0" />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-edge flex-shrink-0">
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 rounded-lg text-meta text-fg-secondary bg-zinc-700 hover:bg-state-strong"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-meta text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? (
              <>
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                保存中...
              </>
            ) : (
              <>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                </svg>
                保存 (Ctrl+S)
              </>
            )}
          </button>
        </div>

        {/* Close confirmation dialog */}
        {showCloseConfirm && (
          <div className="modal-backdrop-enter absolute inset-0 z-20 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="modal-panel-enter w-80 rounded-xl bg-surface-raised border border-edge shadow-2xl p-4">
              <h3 className="text-read font-semibold text-fg mb-2">未保存的修改</h3>
              <p className="text-meta text-fg-secondary mb-4">
                文件有未保存的修改，是否在关闭前保存？
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCloseWithoutSaving}
                  className="px-3 py-1.5 rounded-lg text-meta text-fg-secondary bg-zinc-700 hover:bg-state-strong"
                >
                  放弃
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setShowCloseConfirm(false);
                    const result = await handleSave();
                    if (result === 'saved') requestClose();
                  }}
                  className="px-3 py-1.5 rounded-lg text-meta text-white bg-indigo-600 hover:bg-indigo-500"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setShowCloseConfirm(false)}
                  className="px-3 py-1.5 rounded-lg text-meta text-fg-secondary bg-zinc-700 hover:bg-state-strong"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Overwrite confirmation dialog */}
        {showOverwriteConfirm && (
          <div className="modal-backdrop-enter absolute inset-0 z-20 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="modal-panel-enter w-80 rounded-xl bg-surface-raised border border-edge shadow-2xl p-4">
              <h3 className="text-read font-semibold text-amber-300 mb-2">文件已被外部修改</h3>
              <p className="text-meta text-fg-secondary mb-4">
                此文件在编辑期间被其他程序修改过。覆盖将丢失外部修改。
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowOverwriteConfirm(false)}
                  className="px-3 py-1.5 rounded-lg text-meta text-fg-secondary bg-zinc-700 hover:bg-state-strong"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setShowOverwriteConfirm(false);
                    await doSave();
                  }}
                  className="px-3 py-1.5 rounded-lg text-meta text-white bg-amber-600 hover:bg-amber-500"
                >
                  覆盖保存
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
