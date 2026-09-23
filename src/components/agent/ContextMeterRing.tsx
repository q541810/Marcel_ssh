import { COMPACT_THRESHOLD_RATIO } from '@/lib/tokenUsage';

/**
 * 上下文占用环（桌面标题栏与手机输入框行共用）。
 *
 * 形态取自 DSH 的 ContextMeter：一圈细弧表达「上下文有多满」，比一个数字
 * 更快读懂，也不占地方。**未配置窗口时不画弧**（只留一圈轨道）——画个
 * 假比例比不画更糟。
 *
 * 越过压缩阈值（窗口 × 0.8）后弧变琥珀色：那之后下一次请求就可能触发压缩，
 * 用户该知道（压缩会在对话里插一张卡片）。阈值刻度线画在明细的分段条上
 * （见 `TokenUsagePanel`）——18px 的环上画刻度根本看不清，等于没画。
 */
export function ContextMeterRing({
  percent,
  size = 18,
  className = '',
}: {
  /** 0–100；`null` = 算不出来（没配窗口 / 还没跑过请求）。 */
  percent: number | null;
  size?: number;
  className?: string;
}) {
  const stroke = 2;
  const radius = size / 2 - stroke / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = percent == null ? 0 : (Math.min(100, Math.max(0, percent)) / 100) * circumference;
  const overThreshold = percent != null && percent >= COMPACT_THRESHOLD_RATIO * 100;
  const cx = size / 2;
  const cy = size / 2;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      aria-hidden
      className={className}
    >
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className="stroke-zinc-700"
      />
      {percent != null && (
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference}`}
          transform={`rotate(-90 ${cx} ${cy})`}
          className={overThreshold ? 'stroke-amber-400' : 'stroke-indigo-400'}
        />
      )}
    </svg>
  );
}
