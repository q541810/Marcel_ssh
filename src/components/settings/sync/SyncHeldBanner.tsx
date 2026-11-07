import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useSyncStore } from '@/stores/syncStore';
import { getErrorMessage } from '@/lib/errors';
import { describeHeld } from '@/lib/syncModel';
import type { SyncStatus } from '@/lib/types';
import { SyncButton, type SyncVariant } from './syncUi';

/**
 * 「本机一次删除了 N 个连接，确认同步到其它设备？」
 *
 * 一次删得太多很可能是误操作（或者本机配置出了问题），所以后端把这批删除扣下来、不上传，
 * 等用户表态：同步删除 = 放行，其它设备跟着删；撤销删除 = 从云端把这些内容恢复到本机。
 * 两个按钮的后果都写在按钮下面，别让人猜。
 */
export function SyncHeldBanner({ variant, held }: { variant: SyncVariant; held: SyncStatus['held'] }) {
  const confirmHeld = useSyncStore((s) => s.confirmHeld);
  const [working, setWorking] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (accept: boolean) => {
    setWorking(accept ? 'accept' : 'reject');
    setError(null);
    try {
      await confirmHeld(accept);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setWorking(null);
    }
  };

  const summary = describeHeld(held) ?? '本机一次删除了较多内容';
  return (
    <div
      className={`border-amber-500/25 bg-amber-500/10 ${
        variant === 'desktop' ? 'border-y px-6 py-4' : 'rounded-xl border px-3 py-3'
      }`}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-1 h-4 w-4 flex-shrink-0 text-amber-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-amber-100">{summary}，确认同步到其它设备？</p>
          <p className="mt-1 text-meta leading-relaxed text-amber-100/70">
            这么多删除通常是误操作，所以先扣下了。「同步删除」会让其它设备也删掉这些内容；
            「撤销删除」会从云端把它们恢复到这台设备。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <SyncButton
              variant={variant}
              kind="danger"
              loading={working === 'accept'}
              disabled={working !== null}
              onClick={() => void run(true)}
            >
              同步删除
            </SyncButton>
            <SyncButton
              variant={variant}
              kind="secondary"
              loading={working === 'reject'}
              disabled={working !== null}
              onClick={() => void run(false)}
            >
              撤销删除
            </SyncButton>
          </div>
          {error && (
            <p className="mt-2 text-meta text-red-300" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
