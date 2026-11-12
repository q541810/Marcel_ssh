// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetMotionLog,
  clearMotionLog,
  getMotionLog,
  noteContent,
  noteGesture,
  noteOpen,
  type OpenRecord,
} from './motionLog';

let now = 1000;
let frames: FrameRequestCallback[] = [];

/** Advance the clock by `gap` and run one frame. */
function frame(gap: number): void {
  now += gap;
  const due = frames;
  frames = [];
  due.forEach((cb) => cb(now));
}

function page(title: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = `<h1>${title}</h1>`;
  return el;
}

function fakeAnim(startTime: number, duration: number): Animation {
  return {
    ready: Promise.resolve(),
    startTime,
    effect: { getComputedTiming: () => ({ duration }) },
  } as unknown as Animation;
}

function tap(downToClick = 0): void {
  window.dispatchEvent(new MouseEvent('pointerup'));
  now += downToClick;
  window.dispatchEvent(new MouseEvent('click'));
}

beforeEach(() => {
  now = 1000;
  frames = [];
  __resetMotionLog();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('motionLog', () => {
  it('splits a tapped open into lift → click → built → moving, with pacing while it grows', async () => {
    tap(8);
    now += 300; // the tap handler and React mounting the page
    const el = page('Agent');
    const probe = noteOpen(el);
    probe.moving(fakeAnim(now + 40, 100));
    await Promise.resolve();
    frame(40);
    noteContent(el, false); // the content, built right after the first frame
    frame(16);
    frame(60); // a missed frame while growing
    frame(16);
    await vi.waitFor(() => expect(getMotionLog()).toHaveLength(1));
    const r = getMotionLog()[0] as OpenRecord;
    expect(r).toMatchObject({ kind: 'open', page: 'Agent', tapToBuilt: 300, builtToMoving: 40, frames: 2, late: 1 });
    expect(r).toMatchObject({ contentMs: 40, contentFaded: false });
    // Event timeStamps come from the real clock in jsdom; only check it is a number when present.
    expect(r.liftToClick === null || typeof r.liftToClick === 'number').toBe(true);
    expect(r.worstMs).toBe(60);
  });

  it('an open without a recent tap has no tap timings', async () => {
    tap();
    now += 5000;
    const el = page('通知跳转');
    noteOpen(el).moving(undefined);
    frame(16);
    frame(600);
    await Promise.resolve();
    expect(getMotionLog()).toHaveLength(0); // still waiting for its content
    now += 400;
    noteContent(el, true);
    await vi.waitFor(() => expect(getMotionLog()).toHaveLength(1));
    expect(getMotionLog()[0]).toMatchObject({
      tapToBuilt: null,
      liftToClick: null,
      builtToMoving: null,
      contentMs: 1016,
      contentFaded: true,
    });
  });

  it('a page whose content never reports is filed without it after a while', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      noteOpen(page('普通页')).moving(undefined);
      frame(16);
      frame(600);
      await Promise.resolve();
      await Promise.resolve();
      expect(getMotionLog()).toHaveLength(0);
      vi.advanceTimersByTime(3000);
      expect(getMotionLog()[0]).toMatchObject({ page: '普通页', contentMs: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps gestures newest first, a dozen at most, and clears', () => {
    for (let i = 0; i < 15; i++) noteGesture(i % 2 ? 'back' : 'cancel', i, 0, 16);
    const log = getMotionLog();
    expect(log).toHaveLength(12);
    expect(log[0]).toMatchObject({ kind: 'gesture', frames: 14 });
    clearMotionLog();
    expect(getMotionLog()).toHaveLength(0);
  });
});
