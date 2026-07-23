import { TriangleAlert } from 'lucide-react';
import MobileSheet from './MobileSheet';

interface MobilePasteConfirmSheetProps {
  /** Pending multi-line paste text; null closes the sheet. */
  text: string | null;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}

/**
 * Mobile counterpart of the desktop PasteConfirmDialog: multi-line clipboard
 * content may execute commands on paste, so preview + confirm before sending.
 */
export default function MobilePasteConfirmSheet({
  text,
  onConfirm,
  onCancel,
}: MobilePasteConfirmSheetProps) {
  return (
    <MobileSheet
      open={text != null}
      onClose={onCancel}
      title={
        <span className="flex items-center gap-2 text-amber-300">
          <TriangleAlert className="h-4 w-4 flex-shrink-0" />
          安全提示
        </span>
      }
      footer={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              if (text != null) onConfirm(text);
            }}
            className="rounded-xl bg-green-600 px-4 py-3 text-sm font-medium text-white active:bg-green-500"
          >
            确认粘贴
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-zinc-800"
          >
            取消
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-2 px-4 pb-3">
        <p className="text-sm font-medium text-zinc-200">
          您粘贴的内容中含有回车，可能会意外执行某些命令。
        </p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">
          {text}
        </pre>
      </div>
    </MobileSheet>
  );
}
