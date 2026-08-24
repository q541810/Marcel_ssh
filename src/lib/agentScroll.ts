/** Distance from bottom <= threshold counts as sticky-follow zone. */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  thresholdPx = 80,
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
