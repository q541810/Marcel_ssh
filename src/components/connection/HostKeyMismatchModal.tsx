import { useEffect, useMemo, useState } from 'react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { formatAddress } from '@/lib/privacy';
import type { HostKeyMismatchData } from '@/lib/types';

interface Props {
  open: boolean;
  data: HostKeyMismatchData | null;
  onTrust: () => void;
  onCancel: () => void;
}

/**
 * Modal shown when an SSH server presents a host key that differs from the
 * stored fingerprint (TOFU mismatch). Surfaces both the stored and presented
 * algorithm + SHA-256 fingerprint so the user can verify before opting to
 * trust the new key (which overwrites the stored entry).
 */
export default function HostKeyMismatchModal({ open, data, onTrust, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const privacyMode = usePrivacyMode();

  useEffect(() => {
    if (open) setBusy(false);
  }, [open]);

  const fingerprintRows = useMemo(() => {
    if (!data) return null;
    return [
      {
        label: '已知',
        algorithm: data.storedAlgorithm,
        fingerprint: data.storedFingerprint,
        tone: 'text-fg-secondary',
      },
      {
        label: '当前',
        algorithm: data.presentedAlgorithm,
        fingerprint: data.presentedFingerprint,
        tone: 'text-amber-300',
      },
    ];
  }, [data]);

  return (
    <Modal open={open} onClose={onCancel} title="主机密钥不匹配">
      <div className="p-4 space-y-4">
        {data && (
          <>
            <p className="text-read text-fg-secondary">
              服务器 <span className="font-mono text-fg">{formatAddress(data.host, data.port, privacyMode)}</span>{' '}
              提供的主机密钥与本地记录不一致。可能是服务器重装/迁移了密钥，也可能是遭遇中间人攻击。
            </p>
            <p className="text-read text-fg-tertiary">
              请在确认安全后再信任新密钥；信任后会覆盖本地记录的指纹。
            </p>

            {fingerprintRows && (
              <div className="space-y-2">
                {fingerprintRows.map((row) => (
                  <div
                    key={row.label}
                    className="rounded-lg border border-edge bg-surface/50 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-meta font-medium text-fg-secondary">{row.label}</span>
                      <span className="text-meta text-fg-tertiary font-mono">{row.algorithm}</span>
                    </div>
                    <div className={`font-mono text-meta break-all ${row.tone}`}>
                      {row.fingerprint}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
                取消
              </Button>
              <Button
                variant="danger"
                type="button"
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  onTrust();
                }}
              >
                信任新密钥并重连
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}