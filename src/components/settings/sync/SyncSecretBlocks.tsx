import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import Reveal from '@/components/ui/Reveal';
import { useSyncStore } from '@/stores/syncStore';
import { getErrorMessage } from '@/lib/errors';
import { QrCode } from './QrCode';
import { buildQrMatrix } from './qrMatrix';
import { RecoveryKeyView } from './RecoveryKeyView';
import { Callout, CopyButton, SyncButton, type SyncVariant } from './syncUi';

/** 机密展示多久后自动收起：屏幕上摆着钥匙不该没有时限。 */
export const SECRET_AUTO_HIDE_MS = 120_000;

/**
 * 「按需取出的机密」：默认不取、不进 DOM；点「显示」才向后端要，「隐藏」或超时就清掉。
 * 机密只在本 hook 的局部状态里，不进任何全局 store。
 */
function useRevealedSecret(fetcher: () => Promise<string>) {
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const hide = useCallback(() => {
    setValue(null);
    setError(null);
  }, []);

  const show = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setValue(await fetcherRef.current());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (value === null) return;
    const timer = setTimeout(hide, SECRET_AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [value, hide]);

  return { value, loading, error, show, hide };
}

/**
 * 收起动画（Reveal，最长 ~400ms）期间内容要原样保留，否则面板会先空一下再塌下去；
 * 动画播完再真正丢掉机密，不让它在内存里多留。
 */
function useHeld<T>(value: T | null, delayMs = 450): T | null {
  const [held, setHeld] = useState<T | null>(value);
  useEffect(() => {
    if (value !== null) {
      setHeld(value);
      return;
    }
    const timer = setTimeout(() => setHeld(null), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return value ?? held;
}

/** 显示 / 隐藏切换按钮 + 出错提示，两个机密块共用。 */
function RevealToggle({
  variant,
  secret,
  showLabel,
}: {
  variant: SyncVariant;
  secret: ReturnType<typeof useRevealedSecret>;
  showLabel: string;
}) {
  const open = secret.value !== null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SyncButton
        variant={variant}
        kind="secondary"
        loading={secret.loading}
        onClick={() => (open ? secret.hide() : void secret.show())}
      >
        {open ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        {open ? '隐藏' : showLabel}
      </SyncButton>
      {secret.error && (
        <span className="text-meta text-red-400" role="alert">
          {secret.error}
        </span>
      )}
    </div>
  );
}

/**
 * 添加设备：显示同步码（桌面另有二维码）。
 *
 * 桌面的二维码给手机扫：手机系统相机扫出来是一段文字，复制后粘贴到手机端「加入已有同步」里即可
 * （应用内扫码以后再做）。手机端本身不生成二维码，只给同步码和复制按钮。
 */
export function AddDeviceBlock({ variant }: { variant: SyncVariant }) {
  const getSyncCode = useSyncStore((s) => s.getSyncCode);
  const secret = useRevealedSecret(getSyncCode);
  const code = useHeld(secret.value);
  // 太长的同步码塞不进二维码：就地说明，别留一块空白。
  const qrFits = variant === 'desktop' && code !== null && buildQrMatrix(code) !== null;

  return (
    <div className="space-y-3">
      <RevealToggle variant={variant} secret={secret} showLabel="显示同步码" />
      <Reveal show={secret.value !== null}>
        <div className="space-y-3 pt-1">
          <div className={variant === 'desktop' ? 'flex flex-wrap items-start gap-4' : 'space-y-3'}>
            {qrFits && code !== null && (
              <div className="flex-shrink-0">
                <QrCode text={code} size={168} label="同步码二维码" />
                <p className="mt-2 max-w-[168px] text-caption leading-snug text-fg-tertiary">
                  用手机相机扫描，把扫出的文字粘贴到手机端的「加入已有同步」。
                </p>
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-2">
              <div
                className="max-h-32 overflow-y-auto break-all rounded-lg border border-edge bg-surface/70 px-3 py-2 font-mono text-meta leading-relaxed text-fg-secondary select-all"
                data-testid="sync-code"
              >
                {code ?? ''}
              </div>
              {code !== null && <CopyButton variant={variant} text={code} label="复制同步码" />}
            </div>
          </div>
          {variant === 'desktop' && code !== null && !qrFits && (
            <p className="text-meta text-fg-tertiary">同步码较长，无法生成二维码，请复制后发到另一台设备。</p>
          )}
          <Callout tone="warn">
            同步码里带着解锁数据的钥匙，等同于钥匙本身：只在你自己的设备之间传递，别发给别人。
            {secret.value !== null && ' 两分钟后会自动收起。'}
          </Callout>
        </div>
      </Reveal>
    </div>
  );
}

/** 查看恢复密钥：同样默认收起，按需取出。 */
export function RecoveryKeyBlock({ variant }: { variant: SyncVariant }) {
  const getRecoveryKey = useSyncStore((s) => s.getRecoveryKey);
  const secret = useRevealedSecret(getRecoveryKey);
  const recoveryKey = useHeld(secret.value);
  return (
    <div className="space-y-3">
      <RevealToggle variant={variant} secret={secret} showLabel="查看恢复密钥" />
      <Reveal show={secret.value !== null}>
        <div className="space-y-3 pt-1">
          {recoveryKey !== null && <RecoveryKeyView variant={variant} recoveryKey={recoveryKey} />}
          <Callout tone="warn">
            恢复密钥等同于钥匙，请别发给别人。它是在新设备上手动加入、或同步码丢失时解开云端数据的唯一凭据。
            {secret.value !== null && ' 两分钟后会自动收起。'}
          </Callout>
        </div>
      </Reveal>
    </div>
  );
}
