import { ArrowUpCircle } from 'lucide-react';
import { openExternalLink } from '@/lib/externalLinks';
import MobileSheet from './ui/MobileSheet';

interface MobileUpdateToastProps {
  version: string;
  url: string;
  onDismiss: () => void;
}

/** Full-screen update dialog (sheet) for the mobile shell. */
export default function MobileUpdateToast({
  version,
  url,
  onDismiss,
}: MobileUpdateToastProps) {
  const handleDownload = () => {
    openExternalLink(url);
  };

  return (
    <MobileSheet
      open
      onClose={onDismiss}
      title="发现新版本"
      maxHeightClassName="max-h-[70dvh]"
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="flex-1 rounded-xl bg-zinc-800 px-3 py-3 text-sm font-medium text-zinc-200 active:bg-zinc-700"
          >
            稍后
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="flex-1 rounded-xl bg-indigo-600 px-3 py-3 text-sm font-medium text-white active:bg-indigo-500"
          >
            去下载
          </button>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-3 px-5 py-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-500/15">
          <ArrowUpCircle className="h-8 w-8 text-indigo-400" />
        </div>
        <div>
          <p className="text-base font-semibold text-zinc-100">
            新版本 {version} 可用
          </p>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            前往 GitHub Release 下载并安装最新 APK。安装后可直接覆盖当前版本。
          </p>
        </div>
      </div>
    </MobileSheet>
  );
}
