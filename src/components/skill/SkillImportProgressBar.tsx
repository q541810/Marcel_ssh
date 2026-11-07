import type { SkillImportProgress } from '@/hooks/useSkillImportProgress';

interface Props {
  progress: SkillImportProgress | null;
  onCancel: () => void;
  /** 触屏尺寸（手机端）：更高的条、满足 44px 的取消按钮 */
  touch?: boolean;
}

const fmtMB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const fmtSpeed = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB/s` : `${Math.max(1, Math.round(n / 1024))} KB/s`;

type Stage = 'connecting' | 'downloading' | 'parsing';

/**
 * GitHub 导入下载进度。桌面与手机共用，三个阶段如实区分：
 * - 连接中：还没收到任何数据 → 流动光带（不确定）
 * - 下载中：已知总量显示真实百分比；未知总量用流动光带 + 已下载字节数
 * - 解析中：字节已收齐、后端在解压解析 → 流动光带，不再停在「100%」假装卡死
 *
 * 不确定态绝不画静止色块：那会被读成「已经走了一部分」。
 */
export default function SkillImportProgressBar({ progress, onCancel, touch = false }: Props) {
  const known = !!progress && progress.total > 0;
  const stage: Stage = !progress
    ? 'connecting'
    : known && progress.received >= progress.total
      ? 'parsing'
      : 'downloading';
  const determinate = stage === 'downloading' && known;
  const ratio = determinate ? Math.min(1, progress.received / progress.total) : 0;
  const pct = Math.round(ratio * 100);

  const title =
    stage === 'connecting' ? '正在连接…' : stage === 'parsing' ? '正在解析…' : '正在下载';

  const detail = !progress
    ? '等待服务器响应'
    : [
        known ? `${fmtMB(progress.received)} / ${fmtMB(progress.total)}` : `已下载 ${fmtMB(progress.received)}`,
        stage === 'downloading' && progress.speed > 0 ? fmtSpeed(progress.speed) : null,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <div className='space-y-2 rounded-lg border border-edge-subtle bg-surface/60 p-3'>
      <div className='flex items-center justify-between gap-3'>
        <div className='flex min-w-0 items-baseline gap-2'>
          <span className='text-body font-medium text-fg' role='status' aria-live='polite'>
            {title}
          </span>
          {determinate && (
            <span className='text-body tabular-nums text-fg-secondary'>{pct}%</span>
          )}
        </div>
        <button
          type='button'
          onClick={onCancel}
          className={
            'shrink-0 rounded-md border border-edge-strong bg-fill text-meta font-medium text-fg ' +
            'transition-colors hover:bg-fill-strong active:bg-state-strong ' +
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ' +
            (touch ? 'min-h-11 px-4' : 'h-7 px-3')
          }
        >
          取消
        </button>
      </div>

      <div
        role='progressbar'
        aria-label='下载进度'
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? pct : undefined}
        aria-valuetext={determinate ? `${pct}%` : title}
        className={`relative w-full overflow-hidden rounded-full bg-surface-raised ${touch ? 'h-2.5' : 'h-2'}`}
      >
        {determinate ? (
          <div
            className='h-full w-full origin-left rounded-full bg-indigo-500 transition-transform duration-200 ease-out motion-reduce:transition-none'
            style={{ transform: `scaleX(${ratio})` }}
          />
        ) : (
          <div className='skill-progress-indeterminate h-full rounded-full bg-gradient-to-r from-indigo-500/10 via-indigo-400 to-indigo-500/10' />
        )}
      </div>

      <p className='text-meta tabular-nums text-fg-secondary'>{detail}</p>
    </div>
  );
}
