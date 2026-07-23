import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { sftpReadFile, sftpWriteFile, sftpGetMtime } from '@/lib/tauri';
import { formatSize, getErrorMessage } from '@/lib/sftp-helpers';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';
import { decideSaveAction, isFileMissingMessage } from './editorModel';
import MobileSheet from './ui/MobileSheet';
import { registerBackHandler } from './backHandler';

interface MobileFileEditorProps {
  open: boolean;
  sessionId: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Full-screen touch-first text editor for the mobile shell.
 * Native textarea (native selection handles + soft keyboard behavior),
 * same SFTP read/write/mtime-conflict contract as the desktop editor.
 */
export default function MobileFileEditor({
  open,
  sessionId,
  filePath,
  fileName,
  fileSize,
  onClose,
  onSaved,
}: MobileFileEditorProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [savedIndicator, setSavedIndicator] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);

  const originalContentRef = useRef('');
  const mtimeRef = useRef(0);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    closing,
    requestClose,
    onAnimationEnd: onExitAnimationEnd,
  } = useAnimatedClose(onClose);

  const dirty = content !== originalContentRef.current;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent('');
    setSavedIndicator(false);
    setCloseConfirmOpen(false);
    setOverwriteConfirmOpen(false);

    (async () => {
      try {
        const result = await sftpReadFile(sessionId, filePath);
        if (cancelled) return;
        originalContentRef.current = result.content;
        mtimeRef.current = result.mtime;
        setContent(result.content);
      } catch (err) {
        if (cancelled) return;
        setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, sessionId, filePath]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const doSave = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      await sftpWriteFile(sessionId, filePath, content);
      originalContentRef.current = content;
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
  }, [sessionId, filePath, content, onSaved]);

  const handleSave = useCallback(async (): Promise<boolean> => {
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
  }, [sessionId, filePath, doSave]);

  const handleClose = useCallback(() => {
    if (dirty) {
      setCloseConfirmOpen(true);
    } else {
      requestClose();
    }
  }, [dirty, requestClose]);

  // Android back gesture = header back button (dirty check included).
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(handleClose);
  }, [open, handleClose]);

  if (!open) return null;

  return createPortal(
    <div
      onAnimationEnd={onExitAnimationEnd}
      className={`fixed inset-0 z-50 flex flex-col bg-zinc-950 ${
        closing ? 'mobile-fullscreen-exit' : 'mobile-fullscreen-enter'
      }`}
      data-region="mobile-file-editor"
    >
      {/* Header */}
      <header
        className="flex flex-shrink-0 items-center gap-1 border-b border-zinc-800 px-1 py-2"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
      >
        <button
          type="button"
          onClick={handleClose}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-zinc-300 active:bg-zinc-800"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100">
            {fileName}
            {dirty && <span className="ml-1 text-amber-400">●</span>}
          </div>
          <div className="text-[11px] text-zinc-500">
            {formatSize(fileSize)}
            {savedIndicator && (
              <span className="ml-2 text-emerald-400">已保存</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || loading || !dirty}
          className="mr-2 flex-shrink-0 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white active:bg-green-500 disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </header>

      {error && (
        <div className="flex flex-shrink-0 items-center justify-between border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
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

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载文件…
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-full w-full resize-none bg-zinc-950 p-3 font-mono text-[13px] leading-relaxed text-zinc-100 outline-none"
            style={{
              paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))',
            }}
          />
        )}
      </div>

      {/* Unsaved changes sheet */}
      <MobileSheet
        open={closeConfirmOpen}
        onClose={() => setCloseConfirmOpen(false)}
        title="未保存的修改"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className="pb-1 text-sm text-zinc-400">
            文件有未保存的修改，是否在关闭前保存？
          </p>
          <button
            type="button"
            onClick={async () => {
              setCloseConfirmOpen(false);
              const ok = await handleSave();
              if (ok) requestClose();
            }}
            className="rounded-xl bg-green-600 px-4 py-3 text-sm font-medium text-white active:bg-green-500"
          >
            保存并关闭
          </button>
          <button
            type="button"
            onClick={() => {
              setCloseConfirmOpen(false);
              requestClose();
            }}
            className="rounded-xl bg-zinc-800 px-4 py-3 text-sm text-red-300 active:bg-zinc-700"
          >
            放弃修改
          </button>
          <button
            type="button"
            onClick={() => setCloseConfirmOpen(false)}
            className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-zinc-800"
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
          <p className="pb-1 text-sm text-zinc-400">
            此文件在编辑期间被其他程序修改过。覆盖将丢失外部修改。
          </p>
          <button
            type="button"
            onClick={async () => {
              setOverwriteConfirmOpen(false);
              await doSave();
            }}
            className="rounded-xl bg-amber-600 px-4 py-3 text-sm font-medium text-white active:bg-amber-500"
          >
            覆盖保存
          </button>
          <button
            type="button"
            onClick={() => setOverwriteConfirmOpen(false)}
            className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-zinc-800"
          >
            取消
          </button>
        </div>
      </MobileSheet>
    </div>,
    document.body,
  );
}
