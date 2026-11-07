import { formatRecoveryKey } from '@/lib/syncModel';
import { CopyButton, type SyncVariant } from './syncUi';

/**
 * 恢复密钥的展示：4 个一组的大号等宽字，便于抄写与核对，下面一个复制按钮。
 * 复制出去的是带 `-` 分组的版本：粘贴到别处同样好认，而恢复密钥的解析本来就忽略 `-`、空白和大小写，
 * 所以无论用户把它贴回哪里、怎么分的段，都能用。
 */
export function RecoveryKeyView({ variant, recoveryKey }: { variant: SyncVariant; recoveryKey: string }) {
  const display = formatRecoveryKey(recoveryKey);
  const groups = display.split('-');
  return (
    <div className="space-y-3">
      <div
        className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-edge bg-surface/70 px-4 py-3 text-center font-mono text-title tracking-wider text-fg sm:grid-cols-4"
        aria-label="恢复密钥"
        data-testid="recovery-key"
      >
        {groups.map((group, index) => (
          <span key={`${index}-${group}`} className="select-all">
            {group}
          </span>
        ))}
      </div>
      <CopyButton variant={variant} text={display} label="复制恢复密钥" />
    </div>
  );
}
