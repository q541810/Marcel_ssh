import { describe, it, expect } from 'vitest';
import {
  isNearBottom,
  shouldAutoScroll,
  shouldShowScrollToBottomFab,
} from './agentScroll';

describe('isNearBottom', () => {
  it('is true when distance to bottom is within threshold', () => {
    // scrollHeight 1000, clientHeight 400, scrollTop 550 → remaining 50
    expect(isNearBottom(550, 400, 1000, 80)).toBe(true);
    expect(isNearBottom(550, 400, 1000, 50)).toBe(true);
  });

  it('is false when distance to bottom exceeds threshold', () => {
    // remaining 50, threshold 40
    expect(isNearBottom(550, 400, 1000, 40)).toBe(false);
    // scrolled to top
    expect(isNearBottom(0, 400, 1000, 80)).toBe(false);
  });

  it('is true when already at bottom or content fits viewport', () => {
    expect(isNearBottom(600, 400, 1000, 0)).toBe(true);
    // content shorter than viewport
    expect(isNearBottom(0, 400, 300, 80)).toBe(true);
    expect(isNearBottom(0, 400, 400, 0)).toBe(true);
  });

  it('treats overscroll past bottom as near bottom', () => {
    // scrollTop + clientHeight > scrollHeight
    expect(isNearBottom(610, 400, 1000, 0)).toBe(true);
  });
});

describe('shouldAutoScroll', () => {
  it('auto-scrolls when near bottom', () => {
    expect(shouldAutoScroll(true, false)).toBe(true);
  });

  it('auto-scrolls when user just sent even if not near bottom', () => {
    expect(shouldAutoScroll(false, true)).toBe(true);
  });

  it('does not auto-scroll when scrolled up and user did not just send', () => {
    expect(shouldAutoScroll(false, false)).toBe(false);
  });

  it('auto-scrolls when both near bottom and just sent', () => {
    expect(shouldAutoScroll(true, true)).toBe(true);
  });
});

describe('shouldShowScrollToBottomFab', () => {
  it('shows FAB when not near bottom and has messages', () => {
    expect(shouldShowScrollToBottomFab(false, true)).toBe(true);
  });

  it('hides FAB when near bottom', () => {
    expect(shouldShowScrollToBottomFab(true, true)).toBe(false);
  });

  it('hides FAB when no messages even if not near bottom', () => {
    expect(shouldShowScrollToBottomFab(false, false)).toBe(false);
  });

  it('hides FAB when near bottom and no messages', () => {
    expect(shouldShowScrollToBottomFab(true, false)).toBe(false);
  });
});
