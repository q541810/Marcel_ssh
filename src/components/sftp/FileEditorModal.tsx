import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { searchKeymap } from '@codemirror/search';
import { sftpReadFile, sftpWriteFile, sftpGetMtime } from '@/lib/tauri';
import { formatSize, getErrorMessage } from '@/lib/sftp-helpers';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';

import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';

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

const LANGUAGE_LOADERS: Record<string, () => Promise<Extension>> = {
  '.json': () => import('@codemirror/lang-json').then((m) => m.json()),
  '.yaml': () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  '.yml': () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  '.xml': () => import('@codemirror/lang-xml').then((m) => m.xml()),
  '.html': () => import('@codemirror/lang-html').then((m) => m.html()),
  '.htm': () => import('@codemirror/lang-html').then((m) => m.html()),
  '.css': () => import('@codemirror/lang-css').then((m) => m.css()),
  '.js': () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  '.jsx': () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  '.ts': () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  '.tsx': () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  '.py': () => import('@codemirror/lang-python').then((m) => m.python()),
  '.md': () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  '.sql': () => import('@codemirror/lang-sql').then((m) => m.sql()),
  '.sh': () => Promise.resolve(StreamLanguage.define(shell)),
  '.bash': () => Promise.resolve(StreamLanguage.define(shell)),
  '.zsh': () => Promise.resolve(StreamLanguage.define(shell)),
};

function getFileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx).toLowerCase() : '';
}

export default function FileEditorModal({
  open,
  sessionId,
  filePath,
  fileName,
  fileSize,
  onClose,
  onSaved,
}: FileEditorModalProps) {
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const originalContentRef = useRef<string>('');
  const mtimeRef = useRef<number>(0);
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

  const doSave = useCallback(async (): Promise<SaveResult> => {
    if (!viewRef.current) return 'blocked';
    setSaving(true);
    setError(null);
    try {
      const content = viewRef.current.state.doc.toString();
      await sftpWriteFile(sessionId, filePath, content);
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
  }, [sessionId, filePath, onSaved]);

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
  }, [sessionId, filePath, doSave]);

  saveRef.current = handleSave;

  const isDirty = useCallback(() => {
    if (!viewRef.current) return false;
    return viewRef.current.state.doc.toString() !== originalContentRef.current;
  }, []);

  const updateLineCount = useCallback(() => {
    if (viewRef.current) {
      setLineCount(viewRef.current.state.doc.lines);
    }
  }, []);

  const destroyEditor = useCallback(() => {
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }
  }, []);

  const createEditor = useCallback(
    async (content: string) => {
      if (!editorContainerRef.current) return;

      destroyEditor();

      const ext = getFileExtension(fileName);
      const loader = LANGUAGE_LOADERS[ext];

      const languageExtension = loader ? await loader().catch(() => []) : [];

      const updateListener = EditorView.updateListener.of(() => {
        updateLineCount();
      });

      const view = new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            drawSelection(),
            dropCursor(),
            rectangularSelection(),
            crosshairCursor(),
            highlightActiveLine(),
            keymap.of([
              ...defaultKeymap,
              ...historyKeymap,
              ...searchKeymap,
              indentWithTab,
              {
                key: 'Mod-s',
                run: () => {
                  saveRef.current();
                  return true;
                },
                preventDefault: true,
              },
            ]),
            oneDark,
            updateListener,
            languageExtension,
            EditorState.tabSize.of(2),
            EditorView.lineWrapping,
            EditorView.theme({ "&": { height: "100%" } }),
          ],
        }),
        parent: editorContainerRef.current,
      });

      viewRef.current = view;
      setLineCount(view.state.doc.lines);
    },
    [fileName, destroyEditor, updateLineCount],
  );

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
        originalContentRef.current = result.content;
        mtimeRef.current = result.mtime;
        await createEditor(result.content);
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
        className={`relative w-full max-w-5xl mx-4 h-[85vh] rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl flex flex-col overflow-hidden ${
          closing ? 'modal-panel-exit' : 'modal-panel-enter'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <svg className="w-4 h-4 text-zinc-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <h2 className="text-sm font-medium text-zinc-200 truncate">{filePath}</h2>
          </div>
          <button
            onClick={handleClose}
            className="text-zinc-400 hover:text-zinc-200 text-xl leading-none p-1"
            aria-label="关闭"
          >
            &times;
          </button>
        </div>

        {/* Info bar */}
        <div className="flex items-center gap-4 px-4 py-1.5 border-b border-zinc-700/50 bg-zinc-800/50 flex-shrink-0">
          <span className="text-xs text-zinc-500">
            大小: <span className="text-zinc-400">{formatSize(fileSize)}</span>
          </span>
          <span className="text-xs text-zinc-500">
            行数: <span className="text-zinc-400">{loading ? '-' : lineCount}</span>
          </span>
          <span className="text-xs text-zinc-500">
            编码: <span className="text-zinc-400">UTF-8</span>
          </span>
          {savedIndicator && (
            <span className="text-xs text-green-400 ml-auto">已保存</span>
          )}
        </div>

        {error && (
          <div className="flex items-center justify-between px-3 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-300 flex-shrink-0">
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
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900 z-10">
              <div className="flex items-center gap-2 text-sm text-zinc-400">
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
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-zinc-700 flex-shrink-0">
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-white bg-green-600 hover:bg-green-500 disabled:opacity-50"
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
            <div className="modal-panel-enter w-80 rounded-xl bg-zinc-800 border border-zinc-700 shadow-2xl p-4">
              <h3 className="text-sm font-semibold text-zinc-200 mb-2">未保存的修改</h3>
              <p className="text-xs text-zinc-400 mb-4">
                文件有未保存的修改，是否在关闭前保存？
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCloseWithoutSaving}
                  className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
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
                  className="px-3 py-1.5 rounded-lg text-xs text-white bg-green-600 hover:bg-green-500"
                >
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setShowCloseConfirm(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
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
            <div className="modal-panel-enter w-80 rounded-xl bg-zinc-800 border border-zinc-700 shadow-2xl p-4">
              <h3 className="text-sm font-semibold text-amber-300 mb-2">文件已被外部修改</h3>
              <p className="text-xs text-zinc-400 mb-4">
                此文件在编辑期间被其他程序修改过。覆盖将丢失外部修改。
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowOverwriteConfirm(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    setShowOverwriteConfirm(false);
                    await doSave();
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs text-white bg-amber-600 hover:bg-amber-500"
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
