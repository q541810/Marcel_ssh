import type { RemotePlatform } from '@/lib/types';

/**
 * 只有「少数派」才值得标：Linux 是绝大多数服务器的默认，挂在每一行上等于没信息，
 * 反而盖过连接名。探测结果照常存库（面板按它选命令），只是不画。
 */
const HIDDEN_PLATFORMS: ReadonlySet<RemotePlatform> = new Set(['linux']);

/**
 * 配色：底与字走主题的中性色（浅/深色自动适配），平台只靠一个小圆点区分颜色，
 * 不再用整块描边色块——那样在浅色主题下对比刺眼，也压过连接名。
 */
const PLATFORM_META: Record<RemotePlatform, {
  label: string;
  short: string;
  dot: string;
}> = {
  windows: { label: 'Windows', short: 'Win', dot: 'bg-sky-400' },
  linux: { label: 'Linux', short: 'Linux', dot: 'bg-amber-400' },
  macos: { label: 'macOS', short: 'macOS', dot: 'bg-zinc-400' },
  unix: { label: 'Unix', short: 'Unix', dot: 'bg-zinc-400' },
};

/** Compact tag for the platform detected on a remote connection. */
export default function RemotePlatformBadge({
  platform,
  compact = false,
}: {
  platform?: RemotePlatform;
  compact?: boolean;
}) {
  if (!platform || HIDDEN_PLATFORMS.has(platform)) return null;
  const meta = PLATFORM_META[platform];
  return (
    <span
      className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-state-soft px-1.5 py-px text-caption font-medium leading-4 text-fg-secondary"
      title={`远端系统：${meta.label}`}
    >
      <span className={`h-1 w-1 rounded-full ${meta.dot}`} aria-hidden="true" />
      {compact ? meta.short : meta.label}
    </span>
  );
}
