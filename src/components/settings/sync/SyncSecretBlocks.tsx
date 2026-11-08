import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Maximize } from 'lucide-react';
import Reveal from '@/components/ui/Reveal';
import { useSyncStore } from '@/stores/syncStore';
import { getErrorMessage } from '@/lib/errors';
import { QrZoomDialog } from './QrZoomDialog';
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
 * 添加设备：显示同步码，桌面另有「放大二维码」。
 *
 * 为什么二维码不内联画在设置行里：SFTP 的同步码要带整条服务器连接 + 主机指纹，
 * 实测 1100 字符上下、133 个模块（含静区），每格至少要 3~4 个**设备像素**才稳定可扫
 * ——那意味着至少要 133 × 3 = 399px 宽。设置行的控件列只有 280~320px，装不下；
 * 以前写死 168px 硬画进去，每格只剩 1.26 个像素（98 格占 1px、35 格占 2px），
 * 同一张码里格子宽窄不一，手机怎么对都对不上，实测 0/9 次能解出。
 *
 * 所以这里只放一个常驻的「放大二维码」按钮，点开是占满屏幕的弹层，
 * 那里空间够、每格能到 4~5 个设备像素（实测 9/9 全通过，中度镜头模糊也扛得住）。
 * 宁可少一张小图，也不给一张扫不出来的图——后者只会让用户反复试然后认为功能坏了。
 *
 * 手机端不生成二维码（用不着扫自己的屏幕），只给同步码和复制按钮。
 */
export function AddDeviceBlock({ variant }: { variant: SyncVariant }) {
  const getSyncCode = useSyncStore((s) => s.getSyncCode);
  const secret = useRevealedSecret(getSyncCode);
  const code = useHeld(secret.value);
  const [zoomOpen, setZoomOpen] = useState(false);
  // null = 同步码太长，连二维码都编不出来（放大也救不了，这时只能复制）
  const qrMatrix = code !== null ? buildQrMatrix(code) : null;
  const canShowQr = variant === 'desktop' && qrMatrix !== null;

  // 收起时把放大弹层一并关掉（机密已经不在屏幕上了，别再留一扇窗）。
  useEffect(() => {
    if (secret.value === null) setZoomOpen(false);
  }, [secret.value]);

  return (
    <div className="space-y-3">
      <RevealToggle variant={variant} secret={secret} showLabel="显示同步码" />
      <Reveal show={secret.value !== null}>
        <div className="space-y-3 pt-1">
          {canShowQr && code !== null && (
            <div className="space-y-2">
              <SyncButton
                variant={variant}
                kind="primary"
                className="w-full"
                onClick={() => setZoomOpen(true)}
              >
                <Maximize className="h-4 w-4" aria-hidden />
                放大二维码
              </SyncButton>
              <p className="text-caption leading-snug text-fg-tertiary">
                会占满整个屏幕：手机离屏幕 20~30 厘米对着扫最稳。
                手机端也可以直接用「加入已有同步」里的扫码按钮。
              </p>
            </div>
          )}
          <div className="min-w-0 space-y-2">
            <div
              className="max-h-32 overflow-y-auto break-all rounded-lg border border-edge bg-surface/70 px-3 py-2 font-mono text-meta leading-relaxed text-fg-secondary select-all"
              data-testid="sync-code"
            >
              {code ?? ''}
            </div>
            {code !== null && <CopyButton variant={variant} text={code} label="复制同步码" />}
          </div>
          {variant === 'desktop' && code !== null && !canShowQr && (
            <p className="text-meta text-fg-tertiary">同步码较长，无法生成二维码，请复制后发到另一台设备。</p>
          )}
          <Callout tone="warn">
            同步码里带着解锁数据的钥匙，等同于钥匙本身：只在你自己的设备之间传递，别发给别人。
            {secret.value !== null && ' 两分钟后会自动收起。'}
          </Callout>
        </div>
      </Reveal>
      {canShowQr && code !== null && (
        <QrZoomDialog open={zoomOpen} code={code} onClose={() => setZoomOpen(false)} />
      )}
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
