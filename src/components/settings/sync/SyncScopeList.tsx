import { useCallback, useEffect, useState } from 'react';
import { KeyRound, MessageSquareText } from 'lucide-react';
import Toggle from '@/components/ui/Toggle';
import { useSyncStore } from '@/stores/syncStore';
import { getErrorMessage } from '@/lib/errors';
import { formatSize } from '@/lib/sftp-helpers';
import type { SyncStatus, TierEstimate } from '@/lib/types';
import { Callout, SyncButton, SyncDialog, type SyncVariant } from './syncUi';

/** 三档的名字与说明。顺序固定：配置 → 对话 → 机密。 */
const TIERS = [
  {
    key: 'config' as const,
    title: '普通配置',
    desc: '连接、设置、快捷命令、技能、MCP 服务、已知主机指纹',
  },
  {
    key: 'conversation' as const,
    title: '对话与记忆',
    desc: 'Agent 对话记录与长期记忆',
  },
  {
    key: 'secret' as const,
    title: '机密',
    desc: '密码、私钥、API Key',
  },
];

type TierKey = (typeof TIERS)[number]['key'];
type DialogKind = 'conversation' | 'secret' | 'secret-off';

/** 说明弹层里的估算块：估算失败只影响这块，不放行拦住用户。 */
function EstimateBox({
  title,
  loading,
  error,
  empty,
  onRetry,
  children,
}: {
  title: string;
  loading: boolean;
  error: string | null;
  empty: boolean;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-edge-subtle bg-surface/60 px-3 py-3">
      <div className="text-meta text-fg-tertiary">{title}</div>
      <div className="mt-1 text-body leading-relaxed text-fg" aria-live="polite">
        {loading ? (
          <span className="text-fg-secondary">正在统计…</span>
        ) : error ? (
          <span className="text-fg-secondary">暂时统计不出来，不影响继续。</span>
        ) : empty ? (
          <span className="text-fg-secondary">这台设备上暂时没有要上传的内容。</span>
        ) : (
          children
        )}
      </div>
      {error && !loading && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-meta">
          <span className="text-fg-secondary" role="alert">
            {error}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="text-indigo-400 hover:text-indigo-300 active:text-indigo-300"
          >
            重试
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 「打开 / 关闭某一档之前先讲清楚」的说明弹层：桌面居中 `Modal`、手机底部 `MobileSheet`
 * （都走 `SyncDialog`，与向导、停止同步同一个壳）。
 */
function TierExplainDialog({
  variant,
  kind,
  estimate,
  estimateError,
  estimating,
  busy,
  onRetry,
  onClose,
  onConfirm,
}: {
  variant: SyncVariant;
  kind: DialogKind;
  estimate: TierEstimate | null;
  estimateError: string | null;
  estimating: boolean;
  busy: boolean;
  onRetry: () => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isConversation = kind === 'conversation';
  const isSecretOff = kind === 'secret-off';

  const title = isConversation
    ? '打开「对话与记忆」同步'
    : isSecretOff
      ? '关闭「机密」同步'
      : '打开「机密」同步';
  const confirmLabel = isConversation ? '打开同步' : isSecretOff ? '仍然关闭' : '打开同步';

  return (
    <SyncDialog
      variant={variant}
      open
      onClose={onClose}
      title={title}
      dismissible={!busy}
      footer={
        <>
          <SyncButton variant={variant} kind="ghost" onClick={onClose} disabled={busy}>
            {isSecretOff ? '保持开启' : '取消'}
          </SyncButton>
          <SyncButton
            variant={variant}
            kind={isSecretOff ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </SyncButton>
        </>
      }
    >
      {isConversation && (
        <>
          <ol className="space-y-3 text-body leading-relaxed text-fg-secondary">
            {[
              '对话里可能有服务器的输出和命令结果，同步到别的设备之前请自己想清楚。',
              '内容是端到端加密的：在你自己的设备上加密之后才上传，存储服务商看不到。',
              '打开后会先把这台设备上已有的对话整份传上去，再追上其它设备的进度。',
            ].map((line, index) => (
              <li key={line} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-state-soft text-caption font-medium text-fg-secondary"
                >
                  {index + 1}
                </span>
                <span className="min-w-0">{line}</span>
              </li>
            ))}
          </ol>
          <EstimateBox
            title="当前大约要上传"
            loading={estimating}
            error={estimateError}
            empty={!!estimate && estimate.conversations === 0 && estimate.images === 0}
            onRetry={onRetry}
          >
            {estimate && (
              <>
                约 <span className="font-medium text-fg">{estimate.conversations}</span> 段对话、
                <span className="font-medium text-fg">{estimate.images}</span> 张图片，共{' '}
                {formatSize(estimate.totalBytes)}
              </>
            )}
          </EstimateBox>
        </>
      )}

      {kind === 'secret' && (
        <>
          <p className="text-body leading-relaxed text-fg-secondary">
            打开后，下面这些机密会用同一把钥匙加密后同步到你的其它设备。这里只列类别和数量，
            同步记录里也只写改的是哪个 Key，不会出现值。
          </p>
          <EstimateBox
            title="会同步哪些机密"
            loading={estimating}
            error={estimateError}
            empty={!!estimate && estimate.secretGroups.every((group) => group.count === 0)}
            onRetry={onRetry}
          >
            {estimate && (
              <ul className="space-y-2">
                {estimate.secretGroups
                  .filter((group) => group.count > 0)
                  .map((group) => (
                    <li key={group.label}>
                      <span className="font-medium text-fg">{group.label}</span>
                      <span className="text-fg-secondary"> · {group.count} 个</span>
                      {group.names.length > 0 && (
                        <span className="mt-1 block break-words text-meta text-fg-tertiary">
                          {group.names.join('、')}
                        </span>
                      )}
                    </li>
                  ))}
              </ul>
            )}
          </EstimateBox>
          <Callout tone="warn">
            持有恢复密钥或同步码的人都能解开这些机密，所以它们是同一把钥匙下的东西：
            同步码 / 恢复密钥丢了，这些机密也就跟着丢了。
          </Callout>
        </>
      )}

      {isSecretOff && (
        <>
          <p className="text-body leading-relaxed text-fg-secondary">
            关闭后，这台设备不再上传或接收新的机密。
            <span className="font-medium text-fg">已经同步到其它设备的机密不会被收回。</span>
          </p>
          <p className="text-body leading-relaxed text-fg-secondary">
            想让它从某台设备上消失，需要在那台设备上自己删掉；云端的历史密文也仍然在，
            直到你停止同步并删除云端数据。
          </p>
        </>
      )}
    </SyncDialog>
  );
}

/**
 * 同步范围：三档开关。
 *
 * - **普通配置**：一期行为，恒开、不可关；
 * - **对话与记忆 / 机密**：打开前必须先讲清楚「传什么、谁能解开、大概多大」——这两档
 *   传的是敏感数据，不该在一个开关里悄悄打开。关闭机密档也要提醒「已经出去的收不回来」。
 *
 * 估算（`sync_tier_estimate`）只用来展示，取不到不拦人：说明本身才是打开前要读的东西。
 */
export function ScopeList({ variant, status }: { variant: SyncVariant; status: SyncStatus }) {
  const setTier = useSyncStore((s) => s.setTier);
  const tierEstimate = useSyncStore((s) => s.tierEstimate);

  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [estimate, setEstimate] = useState<TierEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [busyTier, setBusyTier] = useState<TierKey | null>(null);
  const [error, setError] = useState<{ tier: TierKey; message: string } | null>(null);
  /** 关闭对话档后的轻提示（不需要强确认，只要让人知道「别处的不会被删」）。 */
  const [conversationOffNotice, setConversationOffNotice] = useState(false);

  const loadEstimate = useCallback(
    async (tier: 'conversation' | 'secret') => {
      setEstimating(true);
      setEstimateError(null);
      try {
        setEstimate(await tierEstimate(tier));
      } catch (err) {
        setEstimateError(getErrorMessage(err));
      } finally {
        setEstimating(false);
      }
    },
    [tierEstimate],
  );

  // 每次打开说明弹层都重新估一次：用户可能刚删过对话、刚加过 Key。
  useEffect(() => {
    if (dialog === 'conversation' || dialog === 'secret') {
      setEstimate(null);
      setEstimateError(null);
      void loadEstimate(dialog);
    }
  }, [dialog, loadEstimate]);

  useEffect(() => {
    if (!conversationOffNotice) return;
    const timer = setTimeout(() => setConversationOffNotice(false), 6000);
    return () => clearTimeout(timer);
  }, [conversationOffNotice]);

  const applyTier = async (tier: 'conversation' | 'secret', enabled: boolean) => {
    setBusyTier(tier);
    setError(null);
    try {
      await setTier(tier, enabled);
      setDialog(null);
      if (tier === 'conversation' && !enabled) setConversationOffNotice(true);
    } catch (err) {
      setError({ tier, message: getErrorMessage(err) });
    } finally {
      setBusyTier(null);
    }
  };

  const toggleTier = (tier: 'conversation' | 'secret', checked: boolean) => {
    setError(null);
    if (!checked) {
      // 关闭对话档不弹确认（一个轻提示足够）；关闭机密档必须先说清「已经出去的收不回来」。
      if (tier === 'secret') setDialog('secret-off');
      else void applyTier('conversation', false);
      return;
    }
    setDialog(tier);
  };

  const progress = status.streams.find((stream) => stream.tier === 'conversation')?.progress ?? null;
  const showProgress = status.tiers.conversation && progress !== null && progress.total > 0;
  const percent =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;

  return (
    <>
      <ul className="space-y-3">
        {TIERS.map((item) => {
          const checked = item.key === 'config' ? true : status.tiers[item.key];
          const busy = busyTier === item.key;
          const itemError = error?.tier === item.key ? error.message : null;
          const note =
            item.key === 'config'
              ? '始终开启'
              : busy
                ? status.tiers[item.key]
                  ? '正在关闭…'
                  : '正在打开…'
                : checked
                  ? '已开启'
                  : '未开启';
          return (
            <li key={item.key} data-tier={item.key}>
              <div className={`flex items-center justify-between gap-3 ${checked ? '' : 'opacity-70'}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-body text-fg">
                    {item.key === 'conversation' && (
                      <MessageSquareText className="h-3.5 w-3.5 flex-shrink-0 text-fg-tertiary" aria-hidden />
                    )}
                    {item.key === 'secret' && (
                      <KeyRound className="h-3.5 w-3.5 flex-shrink-0 text-fg-tertiary" aria-hidden />
                    )}
                    <span className="truncate">{item.title}</span>
                  </div>
                  <div className="text-meta leading-relaxed text-fg-tertiary">
                    {item.desc} · {note}
                  </div>
                </div>
                <Toggle
                  checked={checked}
                  disabled={item.key === 'config' || busy}
                  size="sm"
                  ariaLabel={`${item.title}同步`}
                  onChange={(next) => {
                    if (item.key === 'config') return;
                    toggleTier(item.key, next);
                  }}
                />
              </div>
              {itemError && (
                <p className="mt-2 text-meta text-red-400" role="alert">
                  {itemError}
                </p>
              )}
              {item.key === 'conversation' && conversationOffNotice && (
                <p className="mt-2 text-meta leading-relaxed text-fg-tertiary">
                  已关闭。已经同步到其它设备的对话不会被删除。
                </p>
              )}
              {item.key === 'conversation' && showProgress && progress && (
                <div className="mt-2 space-y-1" aria-live="polite">
                  <div className="flex items-center justify-between gap-2 text-meta text-indigo-300">
                    <span className="min-w-0 truncate">
                      {progress.label || '正在同步对话'} {progress.done} / {progress.total}
                    </span>
                    <span className="flex-shrink-0 tabular-nums text-fg-tertiary">{percent}%</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-state-mid">
                    <div
                      className="h-full rounded-full bg-indigo-500 transition-[width] duration-500 ease-out motion-reduce:transition-none"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {dialog && (
        <TierExplainDialog
          variant={variant}
          kind={dialog}
          estimate={estimate}
          estimateError={estimateError}
          estimating={estimating}
          busy={busyTier !== null}
          onRetry={() => {
            if (dialog === 'conversation' || dialog === 'secret') void loadEstimate(dialog);
          }}
          onClose={() => {
            if (busyTier === null) setDialog(null);
          }}
          onConfirm={() => {
            if (dialog === 'secret-off') void applyTier('secret', false);
            else if (dialog === 'conversation') void applyTier('conversation', true);
            else void applyTier('secret', true);
          }}
        />
      )}
    </>
  );
}
