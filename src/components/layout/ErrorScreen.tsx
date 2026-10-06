import { useEffect, useRef, useState } from 'react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { describeError } from '@/lib/errors';

/** 与用户群的反馈约定：把错误原文交到用户手里，剩下的引导交给文案。 */
const QQ_GROUP = '1101255501';

type CopyState = 'idle' | 'copied' | 'failed';

interface ErrorScreenProps {
  error: unknown;
  /**
   * 预览模式（调试页）：传入后主按钮变为「关闭预览」，不触发真实重载。
   * 真实崩溃时不传，主按钮是「重新加载」。
   */
  onClose?: () => void;
}

/** 全屏错误兜底界面：错误原文 + 复制 + 重新加载/关闭 + 交流群反馈引导。 */
export default function ErrorScreen({ error, onClose }: ErrorScreenProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    const text = describeError(error);
    try {
      await writeText(text);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        setCopyState('failed');
        copyTimer.current = window.setTimeout(() => setCopyState('idle'), 3200);
        return;
      }
    }
    setCopyState('copied');
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 2500);
  };

  const detail = describeError(error);
  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-300">
      <div className="flex h-8 flex-shrink-0 select-none items-center justify-between border-b border-zinc-800 bg-zinc-950">
        <div className="flex items-center gap-2 px-2 text-xs text-zinc-500">
          <span className="text-red-400">错误</span>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="w-full max-w-3xl space-y-4 text-center">
          <h1 className="text-xl font-semibold">出错了</h1>
          <p className="text-sm text-zinc-500">应用遇到意外错误，请尝试重新加载</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-left text-xs leading-relaxed text-zinc-400">
            {detail}
          </pre>
          <div className="flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className={`rounded-md border px-4 py-2 text-sm transition-colors ${
                copyState === 'copied'
                  ? 'border-emerald-700/60 text-emerald-300'
                  : copyState === 'failed'
                    ? 'border-zinc-700 text-zinc-500'
                    : 'border-zinc-700 text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              {copyState === 'copied'
                ? '已复制'
                : copyState === 'failed'
                  ? '复制失败，请手动选择'
                  : '复制错误信息'}
            </button>
            <button
              type="button"
              onClick={() => (onClose ? onClose() : window.location.reload())}
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500 transition-colors"
            >
              {onClose ? '关闭预览' : '重新加载'}
            </button>
          </div>
          <p className="text-xs leading-relaxed text-zinc-500">
            反馈此问题：加入 QQ 交流群{' '}
            <span className="font-medium text-zinc-300">{QQ_GROUP}</span>
            ，把复制的错误信息发给开发者，我们会跟进处理
          </p>
        </div>
      </div>
    </div>
  );
}
