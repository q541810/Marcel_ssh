import type { ConversationUsage } from '@/lib/types';
import {
  COMPACT_THRESHOLD_RATIO,
  breakdownTotal,
  contextMeterView,
  formatCompactTokens,
  formatExactTokens,
  formatPercent,
  usageTotals,
} from '@/lib/tokenUsage';

/** 三段构成的颜色与标签（与 `meter.breakdown` 的字段同名，直接按键取用）。 */
const SEGMENTS = [
  { key: 'system', label: '系统', color: 'bg-indigo-400' },
  { key: 'tools', label: '工具', color: 'bg-sky-400' },
  { key: 'messages', label: '消息', color: 'bg-emerald-400' },
] as const;

/**
 * 用量明细（桌面弹层与手机底部面板共用同一份字段表）。
 *
 * 排版是有意为之，别改回「一张平铺的表」：
 * - **一个大数占位做锚点**（上下文占用百分比）——打开它是为了看这个，
 *   其余都是它的注脚；没配窗口时退而显示已用 token 数，不让主位空着。
 * - **口径写在段标题右侧的小字里**（最近一次请求 / 含子 agent），不靠用户猜；
 *   占用环只算本会话自己（子 agent 有自己的窗口），累计才是含子 agent。
 * - 明细只留三行（输入 / 输出 / 合计），「缓存读取 / 未缓存 / 命中率 / 推理」
 *   降成各自的说明行 —— 它们解释的是上一行，不是并列的第四五六行。
 * - 数字统一 k/M 缩写：`1,240,000` 那种七位数并排三行读不出大小关系。
 *
 * 降级都在这里显式表达：没有数据 → `—`（不是 0）；窗口未配置 → 说明一句，
 * 已用值照常给；估算是本地算的 → 数字前加 `~`。
 */
export function TokenUsagePanel({
  usage,
  windowTokens,
}: {
  usage: ConversationUsage | undefined;
  /** 生效窗口 tokens；0 = 未配置。 */
  windowTokens: number;
}) {
  const meter = contextMeterView(usage, windowTokens);
  const totals = usageTotals(usage);
  const breakdownSum = breakdownTotal(meter.breakdown);
  const segments = SEGMENTS.filter((s) => (meter.breakdown?.[s.key] ?? 0) > 0).map((s) => ({
    ...s,
    tokens: meter.breakdown?.[s.key] ?? 0,
  }));
  const overThreshold =
    meter.percent != null && meter.percent >= COMPACT_THRESHOLD_RATIO * 100;
  // 主位数字：有窗口看百分比，没窗口退而看已用 token 数（总得让主位说点什么）。
  // 两种模式各自只讲一次那个数 —— 主位已经写着 token 数时，右侧不再重复一遍。
  const byPercent = meter.percent != null;
  const headline = byPercent
    ? `${formatPercent(meter.percent!)}%`
    : meter.usedTokens != null
      ? formatCompactTokens(meter.usedTokens)
      : '—';

  // 一点数据都没有（老会话 / 刚建还没跑过）：不做「大号 —」那套骨架 ——
  // 一个空括号式的占位比一句话更难读，也没有能对比的东西。
  if (meter.usedTokens == null && !totals) {
    return (
      <p className="text-[0.92em] leading-snug text-zinc-500" data-testid="token-usage-panel">
        还没有用量记录，下一个回合开始就会记下来。
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="token-usage-panel">
      {/* ── 上下文占用（本会话自己） ── */}
      <section className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[0.85em] font-medium text-zinc-400">上下文占用</span>
          <span
            className={`text-[0.85em] ${meter.windowTokens === 0 ? 'text-amber-300/90' : 'text-zinc-500'}`}
          >
            {meter.windowTokens === 0 ? '最近一次请求 · 未配置窗口' : '最近一次请求'}
          </span>
        </div>

        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`text-[1.75em] font-semibold leading-none tabular-nums ${
              overThreshold ? 'text-amber-300' : 'text-zinc-100'
            }`}
          >
            {headline}
            {!byPercent && meter.usedTokens != null && (
              <span className="ml-1 text-[0.5em] font-normal text-zinc-500">tokens</span>
            )}
          </span>
          {byPercent && (
            <span
              className="text-[0.92em] tabular-nums text-zinc-400"
              title={
                meter.usedTokens != null && meter.windowTokens > 0
                  ? `${formatExactTokens(meter.usedTokens)} / ${formatExactTokens(meter.windowTokens)}`
                  : undefined
              }
            >
              {meter.usedTokens != null ? (
                <>
                  {meter.estimated ? '~' : ''}
                  {formatCompactTokens(meter.usedTokens)} / {formatCompactTokens(meter.windowTokens)}
                </>
              ) : (
                '—'
              )}
            </span>
          )}
        </div>

        {meter.breakdown && meter.windowTokens > 0 && (
          <div className="relative h-1.5 flex w-full overflow-hidden rounded-full bg-zinc-700">
            {/* 整条长度 = provider 报的占用比例；内部按估算比例切分（分母是估算
                总量，不是窗口）——长度可信、切分是估算，界线画清 */}
            <div
              className="flex h-full overflow-hidden rounded-full"
              style={{ width: `${meter.percent ?? 0}%` }}
            >
              {segments.map((s) => (
                <div
                  key={s.key}
                  className={s.color}
                  style={{ width: `${(s.tokens / (breakdownSum || 1)) * 100}%` }}
                />
              ))}
            </div>
            {/* 压缩阈值刻度：越过它下一次请求就可能触发上下文压缩（会往对话里
                插一张卡片），提前标出来比事后解释便宜。 */}
            <span
              className="absolute inset-y-0 w-px bg-zinc-300/70"
              style={{ left: `${COMPACT_THRESHOLD_RATIO * 100}%` }}
              aria-hidden
              data-testid="compact-threshold-tick"
            />
          </div>
        )}

        {segments.length > 0 && (
          // 三列等宽（不是一行流式串）：段数固定为三，给它三列就永远不会换行
          // 折出「消息」独占一行那种参差；值放标签下面，列内对齐读数更快。
          <dl className="grid grid-cols-3 gap-x-2">
            {segments.map((s) => (
              <div key={s.key} className="min-w-0">
                <dt className="flex items-center gap-1.5 text-[0.85em] text-zinc-400">
                  <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${s.color}`} aria-hidden />
                  <span className="truncate">{s.label}</span>
                </dt>
                <dd className="mt-0.5 text-[0.85em] tabular-nums text-zinc-300">
                  ~{formatCompactTokens(s.tokens)}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {meter.windowTokens === 0 && (
          <p className="text-[0.85em] leading-snug text-zinc-500">
            在设置里给模型填上窗口，这里就会按占比显示；到
            {Math.round(COMPACT_THRESHOLD_RATIO * 100)}% 会自动压缩上下文。
          </p>
        )}
      </section>

      <div className="border-t border-zinc-700/70" />

      {/* ── 本会话累计 ── */}
      <section className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[0.85em] font-medium text-zinc-400">本会话累计</span>
          <span className="text-[0.85em] text-zinc-500">含子 agent</span>
        </div>

        {!totals ? (
          // 走到这里 = 有过请求但渠道没报用量（一点数据都没有的情况上面已经返回）
          <p className="text-[0.85em] leading-snug text-zinc-500">
            这个渠道没有返回用量（只有上面的上下文占用，而且是估算的）。
          </p>
        ) : (
          <dl className="space-y-1">
            <UsageRow
              label="输入"
              value={totals.promptTokens}
              caption={cacheCaption(totals)}
            />
            <UsageRow
              label="输出"
              value={totals.completionTokens}
              caption={
                totals.reasoningTokens != null
                  ? `推理 ${formatCompactTokens(totals.reasoningTokens)}`
                  : null
              }
            />
            <div className="flex items-baseline justify-between gap-2 border-t border-zinc-700/70 pt-1">
              <span className="text-[0.92em] text-zinc-400">合计</span>
              <span
                className="text-[1em] font-semibold text-zinc-100 tabular-nums"
                title={formatExactTokens(totals.totalTokens)}
              >
                {formatCompactTokens(totals.totalTokens)}
              </span>
            </div>
          </dl>
        )}
      </section>
    </div>
  );
}

/** 输入行下面的缓存说明；渠道没报缓存 → 不给（不是给 0）。 */
function cacheCaption(totals: NonNullable<ReturnType<typeof usageTotals>>): string | null {
  if (totals.cachedReadTokens == null) return null;
  const parts = [`缓存 ${formatCompactTokens(totals.cachedReadTokens)}`];
  if (totals.uncachedInputTokens != null) {
    parts.push(`未缓存 ${formatCompactTokens(totals.uncachedInputTokens)}`);
  }
  if (totals.cacheHitPercent != null) {
    parts.push(`命中 ${formatPercent(totals.cacheHitPercent)}%`);
  }
  return parts.join(' · ');
}

function UsageRow({
  label,
  value,
  caption,
}: {
  label: string;
  /** 精确 token 数：显示成 k/M 缩写，悬停给全精度（缩写读得出大小关系，
   *  但「到底多少」这种问题不该只能靠心算） */
  value: number;
  /** 解释上一行的小字（缓存 / 推理），不是并列的第四行。 */
  caption: string | null;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[0.92em] text-zinc-400">{label}</span>
        <span
          className="text-[1em] text-zinc-100 tabular-nums"
          title={formatExactTokens(value)}
        >
          {formatCompactTokens(value)}
        </span>
      </div>
      {caption && <div className="mt-0.5 text-[0.85em] text-zinc-500">{caption}</div>}
    </div>
  );
}
