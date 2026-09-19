import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTauriEvent } from '@/hooks/useTauriEvent';
import { sftpCompressArchive, sshExecLongCancel } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/sftp-helpers';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';

interface CompressModalProps {
  open: boolean;
  sessionId: string;
  /** 要压缩的远程目录绝对路径 */
  remoteDir: string;
  onClose: () => void;
  /** 压缩成功后的回调（FileManagerPanel 用来刷新文件列表） */
  onCompressed: () => void;
}

type Format = 'tar.gz' | 'zip';
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

/** 从 remoteDir 推导默认目标路径：父目录/ basename.{ext} */
function defaultTargetPath(remoteDir: string, format: Format): string {
  const trimmed = remoteDir.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  const basename = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  const parent = lastSlash >= 0 ? trimmed.slice(0, lastSlash) : '/';
  const joinedParent = parent === '' ? '/' : parent;
  return joinedParent === '/' ? `/${basename}.${format}` : `${joinedParent}/${basename}.${format}`;
}

export default function CompressModal({
  open,
  sessionId,
  remoteDir,
  onClose,
  onCompressed,
}: CompressModalProps) {
  const [format, setFormat] = useState<Format>('tar.gz');
  const [targetPath, setTargetPath] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [outputChunks, setOutputChunks] = useState<string[]>([]);
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [showOutput, setShowOutput] = useState(false);

  const taskIdRef = useRef<string | null>(null);
  // 镜像 phase，供「打开时初始化默认值」那个 effect 判断有没有在途压缩。
  // 写在 effect 里而不是渲染期：并发渲染下渲染期写 ref 会留下「从未 commit 的值」，
  // 被丢弃的渲染可能让后续读到过期的 phase。
  const phaseRef = useRef<Phase>('idle');
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 打开时初始化默认值。
  //
  // 本 effect 的依赖含 `remoteDir`：压缩途中目录一变就会重跑，此时**整段都要
  // 跳过**。只保住 taskId 是不够的 —— 那样虽然事件还能到达，但 `setPhase('idle')`
  // 会让 `isRunning` 变 false、关闭保护（`phase === 'compressing'`）失效，用户既
  // 看不到进度、又能关掉窗口，甚至再点一次「开始压缩」起第二个后端任务，而第一个
  // 任务的 id 已被覆盖、再也取消不掉。
  //
  // 当前 UI 下压缩中改不了目录（覆盖层是 fixed inset-0，挡住了面包屑/文件树/标签
  // 栏，也没有全局快捷键），所以这条守卫是把「压缩不被目录变化打断」这个不变量
  // 落在本组件内，而不是依赖远端 UI 结构继续成立。
  useEffect(() => {
    if (!open) return;
    if (phaseRef.current === 'compressing') return;
    setFormat('tar.gz');
    setTargetPath(defaultTargetPath(remoteDir, 'tar.gz'));
    setOverwrite(false);
    setPhase('idle');
    setError(null);
    setOutputChunks([]);
    setElapsedSecs(0);
    setShowOutput(false);
    taskIdRef.current = null;
    startTimeRef.current = null;
  }, [open, remoteDir]);

  // 格式切换时联动目标路径（仅当用户没改过或基于上一个默认值）
  const handleFormatChange = useCallback(
    (next: Format) => {
      setFormat(next);
      // 如果当前 targetPath 是上一个格式的默认值，就跟随更新
      const prevDefault = defaultTargetPath(remoteDir, format);
      if (targetPath === prevDefault) {
        setTargetPath(defaultTargetPath(remoteDir, next));
      }
    },
    [remoteDir, format, targetPath],
  );

  // 停止计时器（终态事件都用到）。
  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 长命令事件：**挂载期就按稳定的事件名订阅**，用 taskIdRef 过滤出本次任务。
  //
  // 原来的写法是「用户点开始 → await 4 个 listen → 再发起压缩」，两头都埋着坑：
  // 一是必须等监听就绪才能发起（否则最早的几条输出会丢），二是这 4 个 await 之间
  // 若组件卸载，cleanup 已经跑完，后拿到的 unlisten 就再也没人回收。改成挂载期
  // 订阅后，顺序问题与泄漏问题同时消失 —— 订阅早就绪，退订随组件生命周期走。
  // 别的长命令事件会被 taskId 过滤掉，行为与之前一致。
  useTauriEvent<LongOutputEvent>('ssh-long-output', (payload) => {
    if (payload.toolCallId !== taskIdRef.current) return;
    setOutputChunks((prev) => {
      const next = [...prev, payload.chunk];
      // 限制累积 200 条，避免内存炸
      return next.length > 200 ? next.slice(-200) : next;
    });
  });

  useTauriEvent<TaskEvent>('ssh-long-done', (payload) => {
    if (payload.taskId !== taskIdRef.current) return;
    setPhase('done');
    stopTimer();
    // 通知父组件刷新
    setTimeout(() => {
      onCompressed();
    }, 0);
  });

  useTauriEvent<TaskEvent>('ssh-long-error', (payload) => {
    if (payload.taskId !== taskIdRef.current) return;
    setPhase('error');
    setError(payload.message ?? '压缩失败');
    stopTimer();
  });

  useTauriEvent<TaskEvent>('ssh-long-cancelled', (payload) => {
    if (payload.taskId !== taskIdRef.current) return;
    setPhase('cancelled');
    stopTimer();
  });

  const handleStart = useCallback(async () => {
    if (!targetPath.trim()) {
      setError('请填写目标路径');
      return;
    }
    setError(null);
    setOutputChunks([]);
    setPhase('compressing');
    setElapsedSecs(0);
    setShowOutput(false);
    const taskId = `compress-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    taskIdRef.current = taskId;
    startTimeRef.current = Date.now();

    // 计时器
    timerRef.current = setInterval(() => {
      if (startTimeRef.current) {
        setElapsedSecs(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);

    try {
      await sftpCompressArchive(sessionId, remoteDir, format, targetPath.trim(), overwrite, taskId);
      // 成功：done 事件已经处理 phase，这里不重复设置
    } catch (err) {
      // 失败：error/cancelled 事件已经处理 phase，这里仅作为兜底
      // 如果 phase 还是 compressing（说明事件没到），手动设置
      setPhase((p) => {
        if (p === 'compressing') {
          setError(getErrorMessage(err));
          return 'error';
        }
        return p;
      });
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  }, [targetPath, sessionId, remoteDir, format, overwrite]);

  const handleCancel = useCallback(async () => {
    const tid = taskIdRef.current;
    if (!tid) return;
    try {
      await sshExecLongCancel(tid);
    } catch {
      // ignore
    }
  }, []);

  const {
    closing,
    requestClose,
    onAnimationEnd: onExitAnimationEnd,
  } = useAnimatedClose(onClose);

  const handleClose = useCallback(() => {
    // 压缩中不允许直接关闭，必须先取消
    if (phase === 'compressing') return;
    stopTimer();
    requestClose();
  }, [phase, stopTimer, requestClose]);

  if (!open) return null;

  const basename = remoteDir.replace(/\/+$/, '').split('/').pop() || remoteDir;
  const mins = Math.floor(elapsedSecs / 60);
  const secs = elapsedSecs % 60;
  const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  const isRunning = phase === 'compressing';
  const isFinished = phase === 'done' || phase === 'error' || phase === 'cancelled';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm ${
          closing ? 'modal-backdrop-exit' : 'modal-backdrop-enter'
        }`}
        onClick={() => !isRunning && handleClose()}
      />

      <div
        onAnimationEnd={onExitAnimationEnd}
        className={`relative w-full max-w-lg mx-4 rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl ${
          closing ? 'modal-panel-exit' : 'modal-panel-enter'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 text-zinc-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
              />
            </svg>
            <h2 className="text-sm font-medium text-zinc-200">压缩文件夹</h2>
          </div>
          {!isRunning && (
            <button
              onClick={handleClose}
              className="text-zinc-400 hover:text-zinc-200 text-xl leading-none p-1"
              aria-label="关闭"
            >
              &times;
            </button>
          )}
        </div>

        <div className="p-4 space-y-4">
          {/* 源目录 */}
          <div>
            <label className="block text-xs text-zinc-500 mb-1">源目录</label>
            <div className="px-3 py-2 rounded-lg bg-zinc-900/60 border border-zinc-700/50 text-xs text-zinc-400 font-mono break-all">
              {remoteDir}
            </div>
          </div>

          {/* 格式选择 */}
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">压缩格式</label>
            <div className="flex gap-2">
              {(['tar.gz', 'zip'] as Format[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  disabled={isRunning}
                  onClick={() => handleFormatChange(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                    format === f
                      ? 'bg-indigo-600 text-white'
                      : 'bg-zinc-700/50 text-zinc-300 hover:bg-zinc-700'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
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

          {/* 目标路径 */}
          <div>
            <label className="block text-xs text-zinc-500 mb-1">目标路径</label>
            <input
              type="text"
              value={targetPath}
              disabled={isRunning}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder="/path/to/archive.tar.gz"
              className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-xs text-zinc-100 font-mono outline-none focus:border-indigo-500 disabled:opacity-50"
            />
            <p className="mt-1 text-[10px] text-zinc-600">
              默认压缩到源目录的父目录，避免递归包含
            </p>
          </div>

          {/* 覆盖选项 */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={overwrite}
              disabled={isRunning}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-zinc-500 bg-zinc-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
            />
            <span className="text-xs text-zinc-300">覆盖已存在的目标文件</span>
          </label>

          {/* 错误提示 */}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300 max-h-32 overflow-y-auto">
              {error}
            </div>
          )}

          {/* 压缩中状态 */}
          {isRunning && (
            <div className="rounded-lg bg-zinc-900/50 border border-zinc-700/50 p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-zinc-300">
                  <svg className="w-3.5 h-3.5 animate-spin text-indigo-400" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  正在压缩「{basename}」...
                </div>
                <span className="text-zinc-500 tabular-nums">{timeStr}</span>
              </div>

              {outputChunks.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowOutput((s) => !s)}
                    className="text-[10px] text-zinc-500 hover:text-zinc-400"
                  >
                    {showOutput ? '▼ 隐藏输出' : '▶ 显示输出'}（{outputChunks.length} 行）
                  </button>
                  {showOutput && (
                    <pre className="mt-1 max-h-32 overflow-auto text-[10px] text-zinc-500 font-mono bg-zinc-950/50 rounded p-2 whitespace-pre-wrap break-all">
                      {outputChunks.join('')}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 完成状态 */}
          {phase === 'done' && (
            <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-300">
              ✓ 压缩完成：{targetPath}
            </div>
          )}
          {phase === 'cancelled' && (
            <div className="px-3 py-2 rounded-lg bg-zinc-500/10 border border-zinc-500/20 text-xs text-zinc-400">
              已取消
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-700">
          {isRunning ? (
            <button
              type="button"
              onClick={handleCancel}
              className="px-3 py-1.5 rounded-lg text-xs text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30"
            >
              取消压缩
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleClose}
                className="px-3 py-1.5 rounded-lg text-xs text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
              >
                {isFinished ? '关闭' : '取消'}
              </button>
              {!isFinished && (
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={!targetPath.trim()}
                  className="px-3 py-1.5 rounded-lg text-xs text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  开始压缩
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
