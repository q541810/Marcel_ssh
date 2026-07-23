import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Loader2 } from 'lucide-react';
import MobileSheet from './ui/MobileSheet';
import { sftpCompressArchive, sshExecLongCancel } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/sftp-helpers';
import { defaultArchiveTargetPath, type ArchiveFormat } from './filesUi';

interface MobileCompressSheetProps {
  open: boolean;
  sessionId: string;
  /** 要压缩的远程目录绝对路径（对齐桌面 CompressModal：单目录契约） */
  remoteDir: string;
  onClose: () => void;
  /** 压缩成功后的回调（宿主用来刷新文件列表） */
  onCompressed: () => void;
}

type Phase = 'idle' | 'compressing' | 'done' | 'error' | 'cancelled';

interface LongOutputEvent {
  type: string;
  toolCallId: string;
  chunk: string;
}

interface TaskEvent {
  taskId: string;
  message?: string;
}

/**
 * 移动端压缩底部弹层：格式选择 + 目标路径 + 实时输出流 + 取消。
 * 事件流监听与桌面 CompressModal 一致（ssh-long-output/done/error/cancelled）。
 */
export default function MobileCompressSheet({
  open,
  sessionId,
  remoteDir,
  onClose,
  onCompressed,
}: MobileCompressSheetProps) {
  const [format, setFormat] = useState<ArchiveFormat>('tar.gz');
  const [targetPath, setTargetPath] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [outputChunks, setOutputChunks] = useState<string[]>([]);
  const [elapsedSecs, setElapsedSecs] = useState(0);

  const taskIdRef = useRef<string | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 打开时初始化默认值
  useEffect(() => {
    if (!open) return;
    setFormat('tar.gz');
    setTargetPath(defaultArchiveTargetPath(remoteDir, 'tar.gz'));
    setOverwrite(false);
    setPhase('idle');
    setError(null);
    setOutputChunks([]);
    setElapsedSecs(0);
    taskIdRef.current = null;
    startTimeRef.current = null;
  }, [open, remoteDir]);

  // 格式切换时联动目标路径（仅当用户没改过默认值）
  const handleFormatChange = useCallback(
    (next: ArchiveFormat) => {
      setFormat(next);
      const prevDefault = defaultArchiveTargetPath(remoteDir, format);
      if (targetPath === prevDefault) {
        setTargetPath(defaultArchiveTargetPath(remoteDir, next));
      }
    },
    [remoteDir, format, targetPath],
  );

  const cleanup = useCallback(() => {
    unlistenRefs.current.forEach((fn) => fn());
    unlistenRefs.current = [];
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startListening = useCallback(
    async (taskId: string) => {
      const unlistenOutput = await listen<LongOutputEvent>(
        'ssh-long-output',
        (e) => {
          if (e.payload.toolCallId !== taskId) return;
          setOutputChunks((prev) => {
            const next = [...prev, e.payload.chunk];
            // 限制累积 200 条，避免内存炸
            return next.length > 200 ? next.slice(-200) : next;
          });
        },
      );
      const unlistenDone = await listen<TaskEvent>('ssh-long-done', (e) => {
        if (e.payload.taskId !== taskId) return;
        setPhase('done');
        stopTimer();
        setTimeout(() => {
          onCompressed();
        }, 0);
      });
      const unlistenError = await listen<TaskEvent>('ssh-long-error', (e) => {
        if (e.payload.taskId !== taskId) return;
        setPhase('error');
        setError(e.payload.message ?? '压缩失败');
        stopTimer();
      });
      const unlistenCancelled = await listen<TaskEvent>(
        'ssh-long-cancelled',
        (e) => {
          if (e.payload.taskId !== taskId) return;
          setPhase('cancelled');
          stopTimer();
        },
      );
      unlistenRefs.current = [
        unlistenOutput,
        unlistenDone,
        unlistenError,
        unlistenCancelled,
      ];
    },
    [onCompressed, stopTimer],
  );

  const handleStart = useCallback(async () => {
    if (!targetPath.trim()) {
      setError('请填写目标路径');
      return;
    }
    setError(null);
    setOutputChunks([]);
    setPhase('compressing');
    setElapsedSecs(0);
    const taskId = `compress-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    taskIdRef.current = taskId;
    startTimeRef.current = Date.now();

    timerRef.current = setInterval(() => {
      if (startTimeRef.current) {
        setElapsedSecs(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);

    await startListening(taskId);

    try {
      await sftpCompressArchive(
        sessionId,
        remoteDir,
        format,
        targetPath.trim(),
        overwrite,
        taskId,
      );
      // 成功：done 事件已处理 phase
    } catch (err) {
      // 失败：error/cancelled 事件已处理 phase；事件没到则兜底
      setPhase((p) => {
        if (p === 'compressing') {
          setError(getErrorMessage(err));
          return 'error';
        }
        return p;
      });
      stopTimer();
    }
  }, [
    targetPath,
    sessionId,
    remoteDir,
    format,
    overwrite,
    startListening,
    stopTimer,
  ]);

  const handleCancel = useCallback(async () => {
    const tid = taskIdRef.current;
    if (!tid) return;
    try {
      await sshExecLongCancel(tid);
    } catch {
      // ignore
    }
  }, []);

  const handleClose = useCallback(() => {
    // 压缩中不允许直接关闭，必须先取消
    if (phase === 'compressing') return;
    cleanup();
    onClose();
  }, [phase, cleanup, onClose]);

  const mins = Math.floor(elapsedSecs / 60);
  const secs = elapsedSecs % 60;
  const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  const isRunning = phase === 'compressing';
  const isFinished =
    phase === 'done' || phase === 'error' || phase === 'cancelled';
  const basename = remoteDir.replace(/\/+$/, '').split('/').pop() || remoteDir;

  return (
    <MobileSheet
      open={open}
      onClose={handleClose}
      title="压缩文件夹"
      dismissible={!isRunning}
      footer={
        isRunning ? (
          <button
            type="button"
            onClick={() => void handleCancel()}
            className="w-full rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 active:bg-red-500/20"
          >
            取消压缩
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300 active:bg-zinc-700"
            >
              {isFinished ? '关闭' : '取消'}
            </button>
            {!isFinished && (
              <button
                type="button"
                onClick={() => void handleStart()}
                disabled={!targetPath.trim()}
                className="flex-1 rounded-xl bg-green-600 px-4 py-3 text-sm font-medium text-white active:bg-green-500 disabled:opacity-40"
              >
                开始压缩
              </button>
            )}
          </div>
        )
      }
    >
      <div className="flex flex-col gap-3 px-4 pb-3">
        <div>
          <label className="mb-1 block text-xs text-zinc-500">源目录</label>
          <div className="break-all rounded-lg border border-zinc-700/50 bg-zinc-900/60 px-3 py-2 font-mono text-xs text-zinc-400">
            {remoteDir}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-xs text-zinc-500">压缩格式</label>
          <div className="flex gap-2">
            {(['tar.gz', 'zip'] as ArchiveFormat[]).map((f) => (
              <button
                key={f}
                type="button"
                disabled={isRunning}
                onClick={() => handleFormatChange(f)}
                className={`rounded-lg px-3 py-2 text-xs ${
                  format === f
                    ? 'bg-green-600 text-white'
                    : 'bg-zinc-800 text-zinc-300 active:bg-zinc-700'
                } disabled:opacity-50`}
              >
                {f}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-zinc-600">
            {format === 'tar.gz'
              ? 'Linux 通用，gzip 压缩。Windows 用户下载后需用 7-Zip / WSL 解压'
              : 'Windows 友好，需服务器已安装 zip 命令'}
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs text-zinc-500">目标路径</label>
          <input
            type="text"
            value={targetPath}
            disabled={isRunning}
            onChange={(e) => setTargetPath(e.target.value)}
            placeholder="/path/to/archive.tar.gz"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-green-500 disabled:opacity-50"
          />
          <p className="mt-1 text-[10px] text-zinc-600">
            默认压缩到源目录的父目录，避免递归包含
          </p>
        </div>

        <label className="flex select-none items-center gap-2">
          <input
            type="checkbox"
            checked={overwrite}
            disabled={isRunning}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-500 bg-zinc-600 text-green-500"
          />
          <span className="text-xs text-zinc-300">覆盖已存在的目标文件</span>
        </label>

        {error && (
          <div className="max-h-32 overflow-y-auto rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        {isRunning && (
          <div className="flex flex-col gap-2 rounded-lg border border-zinc-700/50 bg-zinc-900/50 p-3">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-zinc-300">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-green-400" />
                正在压缩「{basename}」...
              </div>
              <span className="tabular-nums text-zinc-500">{timeStr}</span>
            </div>
            {outputChunks.length > 0 && (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950/50 p-2 font-mono text-[10px] text-zinc-500">
                {outputChunks.join('')}
              </pre>
            )}
          </div>
        )}

        {phase === 'done' && (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            ✓ 压缩完成：{targetPath}
          </div>
        )}
        {phase === 'cancelled' && (
          <div className="rounded-lg border border-zinc-500/20 bg-zinc-500/10 px-3 py-2 text-xs text-zinc-400">
            已取消
          </div>
        )}
      </div>
    </MobileSheet>
  );
}
