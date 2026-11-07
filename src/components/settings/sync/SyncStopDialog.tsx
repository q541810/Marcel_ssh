import { useEffect, useState } from 'react';
import { useSyncStore } from '@/stores/syncStore';
import { getErrorMessage } from '@/lib/errors';
import { Callout, SyncButton, SyncCheckbox, SyncDialog, type SyncVariant } from './syncUi';

/**
 * 停止同步的二次确认。
 *
 * 默认只是"这台设备不再同步"：本机配置原样保留，其它设备和云端数据都不受影响，随时能再加入。
 * 勾选"同时删除云端数据"才会动云端——那会让**所有**设备失去这个同步位置，所以单独列成一个
 * 带警示的选项，默认不勾。
 */
export function SyncStopDialog({
  variant,
  open,
  onClose,
}: {
  variant: SyncVariant;
  open: boolean;
  onClose: () => void;
}) {
  const disable = useSyncStore((s) => s.disable);
  const [wipeRemote, setWipeRemote] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setWipeRemote(false);
      setError(null);
    }
  }, [open]);

  const confirm = async () => {
    setWorking(true);
    setError(null);
    try {
      await disable(wipeRemote);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <SyncDialog
      variant={variant}
      open={open}
      onClose={onClose}
      title="停止同步"
      dismissible={!working}
      footer={
        <>
          <SyncButton variant={variant} kind="ghost" onClick={onClose} disabled={working}>
            取消
          </SyncButton>
          <SyncButton variant={variant} kind="danger" onClick={() => void confirm()} loading={working}>
            停止同步
          </SyncButton>
        </>
      }
    >
      <p className="text-body leading-relaxed text-fg-secondary">
        停止后，这台设备不再上传或接收改动。这台设备上现有的连接、设置等都会原样保留，其它设备也不受影响；
        以后想继续，随时可以重新开启或加入。
      </p>
      <SyncCheckbox variant={variant} checked={wipeRemote} onChange={setWipeRemote} tone="danger" disabled={working}>
        同时删除云端的同步数据
        <span className="mt-1 block text-meta text-fg-tertiary">
          删除后，其它设备也无法再通过这个位置同步。只在你打算彻底不用同步时勾选。
        </span>
      </SyncCheckbox>
      {wipeRemote && (
        <Callout tone="warn">云端的加密数据会被永久删除，无法恢复。本机和其它设备上已有的配置不会被删。</Callout>
      )}
      {error && <Callout tone="error">{error}</Callout>}
    </SyncDialog>
  );
}
