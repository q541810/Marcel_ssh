import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import SegmentedControl from '@/components/ui/SegmentedControl';
import MobileSheet from '@/mobile/ui/MobileSheet';
import { MobileChoiceGroup } from '@/mobile/ui/MobileChoiceGroup';
import { SettingItem } from '@/components/settings/helpers';
import { MobileSettingRow } from '@/mobile/settings/MobileSettingRow';
import { copyText } from '@/lib/copyText';
import { getErrorMessage } from '@/lib/errors';
import type { SyncTone } from '@/lib/syncModel';

/**
 * 同步界面的双端共用小件。桌面与手机用同一份内容组件，只在这里按 `variant`
 * 切换「壳」：行容器（SettingItem / MobileSettingRow）、按钮尺寸、弹层（Modal / MobileSheet）。
 */
export type SyncVariant = 'desktop' | 'mobile';

export const SYNC_SECTION_ID = 'settings-sync';

/** 一行设置：桌面是左标签右控件（可被设置页搜索到），手机是整宽卡片。 */
export function SyncRow({
  variant,
  id,
  label,
  description,
  keywords,
  trailing,
  children,
}: {
  variant: SyncVariant;
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  /** 手机端：标题行右侧的控件（开关、状态）。桌面端并入 children 顶部。 */
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  if (variant === 'desktop') {
    return (
      <SettingItem id={id} label={label} description={description} keywords={keywords} sectionId={SYNC_SECTION_ID}>
        {trailing}
        {children}
      </SettingItem>
    );
  }
  return (
    <MobileSettingRow label={label} description={description} trailing={trailing}>
      {children ? <div className="mt-3">{children}</div> : null}
    </MobileSettingRow>
  );
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';

const MOBILE_BUTTON: Record<ButtonKind, string> = {
  primary: 'bg-indigo-600 text-white active:bg-indigo-500',
  secondary: 'bg-zinc-700 text-fg active:bg-state-strong',
  danger: 'bg-red-600 text-white active:bg-red-500',
  ghost: 'bg-transparent text-indigo-300 active:bg-state-soft',
};

/** 桌面用项目通用的 `Button`；手机用触屏尺寸（至少 44px 高）的同色按钮。 */
export function SyncButton({
  variant,
  kind = 'secondary',
  loading = false,
  className = '',
  children,
  disabled,
  ...rest
}: {
  variant: SyncVariant;
  kind?: ButtonKind;
  loading?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & { className?: string }) {
  if (variant === 'desktop') {
    return (
      <Button variant={kind} loading={loading} disabled={disabled} className={className} {...rest}>
        {children}
      </Button>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2 text-body font-medium transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50 ${MOBILE_BUTTON[kind]} ${className}`}
      {...rest}
    >
      {loading ? (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      ) : null}
      {children}
    </button>
  );
}

const DOT_COLOR: Record<SyncTone, string> = {
  off: 'bg-zinc-600',
  ok: 'bg-emerald-500',
  busy: 'bg-indigo-400 motion-safe:animate-pulse',
  warn: 'bg-amber-400',
  error: 'bg-red-500',
};

/** 状态点。纯装饰：状态含义由旁边的文字承担。 */
export function StatusDot({ tone, className = '' }: { tone: SyncTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${DOT_COLOR[tone]} ${className}`}
    />
  );
}

/**
 * 复制按钮：点下去立刻变成「已复制 ✓」，1.8 秒后恢复；复制失败就地说明（手机 WebView 偶尔拒绝剪贴板）。
 */
export function CopyButton({
  variant,
  text,
  label = '复制',
  kind = 'secondary',
}: {
  variant: SyncVariant;
  text: string;
  label?: string;
  kind?: ButtonKind;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [failMessage, setFailMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const onCopy = async () => {
    clearTimeout(timer.current);
    try {
      await copyText(text);
      setState('copied');
    } catch (err) {
      setFailMessage(getErrorMessage(err));
      setState('failed');
    }
    timer.current = setTimeout(() => setState('idle'), 1800);
  };

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <SyncButton variant={variant} kind={kind} onClick={() => void onCopy()}>
        {state === 'copied' ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
        {state === 'copied' ? '已复制' : label}
      </SyncButton>
      {state === 'failed' && (
        <span className="text-meta text-red-400" role="alert">
          复制失败：{failMessage}，请手动选中后复制
        </span>
      )}
    </span>
  );
}

/**
 * 同步用到的弹层壳：桌面是居中 `Modal`，手机是底部 `MobileSheet`（自带 Android 返回键注册）。
 * `dismissible=false` 时点遮罩 / Esc / 返回键都不会关——用于"必须看完再走"的一步（保存恢复密钥）。
 */
export function SyncDialog({
  variant,
  open,
  onClose,
  title,
  dismissible = true,
  footer,
  children,
}: {
  variant: SyncVariant;
  open: boolean;
  onClose: () => void;
  title: string;
  dismissible?: boolean;
  footer?: ReactNode;
  children: ReactNode;
}) {
  if (variant === 'desktop') {
    return (
      <Modal open={open} onClose={onClose} title={title} size="md" dismissible={dismissible}>
        <div className="space-y-4 p-4">{children}</div>
        {footer ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-edge px-4 py-3">{footer}</div>
        ) : null}
      </Modal>
    );
  }
  return (
    <MobileSheet
      open={open}
      onClose={onClose}
      title={title}
      dismissible={dismissible}
      footer={footer ? <div className="flex flex-wrap justify-end gap-2">{footer}</div> : undefined}
    >
      <div className="space-y-4 px-4 pb-4 pt-1">{children}</div>
    </MobileSheet>
  );
}

/** 对话 / 面板里的提示块：tone 决定底色；用于「同步码等同于钥匙」这类需要被看见的话。 */
export function Callout({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error';
  children: ReactNode;
}) {
  const styles = {
    info: 'border-edge bg-surface-raised/60 text-fg-secondary',
    warn: 'border-amber-500/25 bg-amber-500/10 text-amber-100/90',
    error: 'border-red-500/30 bg-red-500/10 text-red-200',
  } as const;
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={`rounded-xl border px-3 py-3 text-meta leading-relaxed ${styles[tone]}`}
    >
      {children}
    </div>
  );
}

/** 互斥二选一：桌面是分段控件，手机是整块可点的选项组。 */
export function SyncChoice<T extends string>({
  variant,
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
}: {
  variant: SyncVariant;
  options: readonly { value: T; label: string; desc?: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  if (variant === 'desktop') {
    return (
      <SegmentedControl
        options={options.map((o) => ({ value: o.value, label: o.label }))}
        value={value}
        onChange={onChange}
        ariaLabel={ariaLabel}
        disabled={disabled}
      />
    );
  }
  return (
    <div className={disabled ? 'pointer-events-none opacity-60' : undefined}>
      <MobileChoiceGroup options={options} value={value} onChange={onChange} ariaLabel={ariaLabel} columns={2} />
    </div>
  );
}

/** 带说明的复选框；整行都能点（手机上不必瞄准 16px 的小方块）。 */
export function SyncCheckbox({
  variant,
  checked,
  onChange,
  tone = 'default',
  disabled,
  children,
}: {
  variant: SyncVariant;
  checked: boolean;
  onChange: (checked: boolean) => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 text-body text-fg-secondary ${
        variant === 'mobile' ? 'min-h-11 py-2' : ''
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className={`mt-1 flex-shrink-0 ${variant === 'mobile' ? 'h-5 w-5' : 'h-4 w-4'} ${
          tone === 'danger' ? 'accent-red-500' : 'accent-indigo-500'
        }`}
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/**
 * 整宽内容块（设备列表、同步记录、状态横幅）：不适合"左标签右控件"的两栏行，
 * 桌面在卡片里占一整行，手机是独立的圆角卡片。
 */
export function SyncBlock({
  variant,
  title,
  description,
  action,
  children,
}: {
  variant: SyncVariant;
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const wrapper =
    variant === 'desktop' ? 'px-6 py-4' : 'rounded-xl border border-edge-subtle bg-surface px-3 py-3';
  return (
    <div className={wrapper}>
      {(title || action) && (
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <div className="text-body font-medium text-fg">{title}</div>}
            {description && <div className="mt-1 text-meta leading-relaxed text-fg-tertiary">{description}</div>}
          </div>
          {action ? <div className="flex-shrink-0">{action}</div> : null}
        </div>
      )}
      {children}
    </div>
  );
}
