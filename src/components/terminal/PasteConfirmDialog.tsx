import { createPortal } from 'react-dom';

interface Props {
  text: string;
  sessionId: string;
  onConfirm: (sessionId: string, text: string) => void;
  onCancel: () => void;
}

export default function PasteConfirmDialog({ text, sessionId, onConfirm, onCancel }: Props) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg mx-4 rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl">
        {/* Header with warning */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <h2 className="text-lg font-semibold text-amber-300">安全提示</h2>
          </div>
          <button
            onClick={onCancel}
            className="text-zinc-400 hover:text-zinc-200 text-xl leading-none"
            aria-label="关闭"
          >
            &times;
          </button>
        </div>

        {/* Warning message */}
        <div className="px-4 pt-3 pb-2">
          <p className="text-sm text-zinc-200 font-medium">
            您粘贴的内容中含有回车，可能会意外执行某些命令。
          </p>
        </div>

        {/* Content preview */}
        <div className="px-4 pb-3">
          <pre className="p-3 rounded-lg bg-zinc-900 text-xs text-zinc-300 overflow-auto max-h-48 whitespace-pre-wrap break-all">
            {text}
          </pre>
        </div>

        {/* Action buttons */}
        <div className="flex justify-end gap-2 px-4 pb-4 border-t border-zinc-700 pt-3">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg text-sm text-zinc-300 bg-zinc-700 hover:bg-zinc-600 transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => onConfirm(sessionId, text)}
            className="px-4 py-1.5 rounded-lg text-sm text-white bg-indigo-600 hover:bg-indigo-500 transition-colors"
          >
            确认粘贴
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
