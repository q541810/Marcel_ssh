import { openExternalLink } from '@/lib/externalLinks';

/** 野构 API 的推广链接（QQ 群二维码落地页）。 */
export const YEGOU_API_URL = 'https://qm.qq.com/q/ZNtXdTpZCg';

interface Props {
  className?: string;
}

/**
 * 野构 API 推荐卡片（挂在渠道列表的最底下）。
 *
 * 刻意做成**半高的卡片、内容靠右**：跟上面的渠道卡片同一个边框与圆角，
 * 但与它们等高就太像一条真渠道了，会让人误以为是可编辑的接入点。
 * 矮一半、内容右对齐，一眼看出这是「附加信息」而不是列表项。
 */
export default function YegouApiBanner({ className = '' }: Props) {
  return (
    <button
      type="button"
      onClick={() => openExternalLink(YEGOU_API_URL)}
      title="野构 API — 低价国模，0.09 倍率"
      className={`flex w-full items-center justify-end gap-2 rounded-xl border border-edge-subtle bg-zinc-900/40 px-4 py-2 text-right transition-colors hover:border-zinc-600 hover:bg-zinc-900/70 ${className}`}
    >
      <img
        src="/yegou-api-icon.png"
        alt=""
        aria-hidden="true"
        className="h-4 w-4 shrink-0 rounded-[3px] object-cover"
      />
      <span className="text-xs text-zinc-400">野构 API</span>
      <span className="text-[11px] text-zinc-600">低价国模</span>
      <span className="text-xs font-medium text-amber-500/90">0.09 倍率</span>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3.5 w-3.5 shrink-0 text-zinc-600"
      >
        <path d="M9 18l6-6-6-6" />
      </svg>
    </button>
  );
}
