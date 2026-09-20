/** Shared sticky-follow zone: distance from bottom <= this is "still pinned". */
export const NEAR_BOTTOM_THRESHOLD_PX = 80;

/**
 * 内嵌滚动区（思考区 / 工具输出 / 压缩摘要）的贴底判定区。
 * 这些盒子只有几行高（120px ~ 40vh），用宿主列表的 80px 会把"明显已经上翻"
 * 也算成贴底，用户刚往上拖一点就又被拽回去。
 */
export const INNER_FOLLOW_THRESHOLD_PX = 24;

/** Distance from bottom <= threshold counts as sticky-follow zone. */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  thresholdPx = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}

/** Stream / dynamic updates should pin to bottom only if sticky zone or user just sent. */
export function shouldAutoScroll(
  isNearBottom: boolean,
  userJustSent: boolean,
): boolean {
  return isNearBottom || userJustSent;
}

/** FAB when user left bottom and there is something to jump to. */
export function shouldShowScrollToBottomFab(
  isNearBottom: boolean,
  hasMessages: boolean,
): boolean {
  return !isNearBottom && hasMessages;
}
