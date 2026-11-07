// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBackDiagnostics,
  registerBackHandler,
  resetBackHandlers,
  type BackGestureFrame,
  type BackPreview,
} from "./backHandler";

function makePreview() {
  const calls: string[] = [];
  const frames: BackGestureFrame[] = [];
  const preview: BackPreview = {
    start: (edge) => calls.push(`start:${edge}`),
    update: (f) => {
      calls.push("update");
      frames.push(f);
    },
    cancel: () => calls.push("cancel"),
    commit: () => calls.push("commit"),
  };
  return { preview, calls, frames };
}

/** Manual frame clock so smoothing is deterministic. */
let now = 0;
let pending: FrameRequestCallback[] = [];
function flushFrames(count = 1, stepMs = 16): void {
  for (let i = 0; i < count; i++) {
    now += stepMs;
    const run = pending;
    pending = [];
    run.forEach((cb) => cb(now));
  }
}

const setIntercept = vi.fn<(enabled: boolean) => void>();

beforeEach(() => {
  now = 0;
  pending = [];
  setIntercept.mockReset();
  window.AndroidBridge = { setBackIntercept: setIntercept } as never;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    pending.push(cb);
    return pending.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    pending = [];
  });
  resetBackHandlers();
});

afterEach(() => {
  resetBackHandlers();
  delete window.AndroidBridge;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settleNativeSync(): Promise<void> {
  await Promise.resolve();
}

describe("native intercept sync", () => {
  it("tells native when the stack goes empty → non-empty → empty", async () => {
    await settleNativeSync();
    setIntercept.mockClear();

    const off = registerBackHandler(() => {});
    await settleNativeSync();
    expect(setIntercept).toHaveBeenLastCalledWith(true);

    off();
    await settleNativeSync();
    expect(setIntercept).toHaveBeenLastCalledWith(false);
  });

  it("does not flicker when a layer re-registers within one task", async () => {
    const off1 = registerBackHandler(() => {});
    await settleNativeSync();
    setIntercept.mockClear();

    // React effect re-run: cleanup then register again, same task.
    off1();
    registerBackHandler(() => {});
    await settleNativeSync();
    expect(setIntercept).not.toHaveBeenCalled();
  });

  it("keeps native enabled while any layer remains", async () => {
    const offA = registerBackHandler(() => {});
    registerBackHandler(() => {});
    await settleNativeSync();
    setIntercept.mockClear();
    offA();
    await settleNativeSync();
    expect(setIntercept).not.toHaveBeenCalled();
  });
});

describe("commit (no preview)", () => {
  it("closes the topmost layer and reports consumption", () => {
    const order: string[] = [];
    registerBackHandler(() => order.push("bottom"));
    registerBackHandler(() => order.push("top"));
    expect(window.__marcelHandleBack?.()).toBe(true);
    expect(order).toEqual(["top"]);
    expect(window.__marcelHandleBack?.()).toBe(true);
    expect(order).toEqual(["top", "bottom"]);
    expect(window.__marcelHandleBack?.()).toBe(false);
  });

  it("ignores gesture events when the top layer has no preview", () => {
    const close = vi.fn();
    registerBackHandler(close);
    window.__marcelBackStart?.(0, 300);
    window.__marcelBackProgress?.(0.5, 0, 320);
    flushFrames(3);
    window.__marcelBackCancel?.();
    expect(close).not.toHaveBeenCalled();
  });
});

describe("predictive back gesture", () => {
  it("starts, smooths progress toward the target, and passes edge + dy", () => {
    const { preview, calls, frames } = makePreview();
    registerBackHandler(() => {}, preview);

    window.__marcelBackStart?.(1, 400);
    expect(calls).toEqual(["start:right"]);

    window.__marcelBackProgress?.(0.6, 1, 450);
    flushFrames(1);
    const first = frames[0];
    // Followed, but not teleported.
    expect(first.progress).toBeGreaterThan(0);
    expect(first.progress).toBeLessThan(0.6);
    expect(first.edge).toBe("right");
    expect(first.dy).toBeGreaterThan(0);

    flushFrames(40);
    const last = frames[frames.length - 1];
    expect(last.progress).toBeCloseTo(0.6, 2);
    expect(last.dy).toBeCloseTo(50, 0);
  });

  it("follows the raw finger X inward (dx) and reports where the finger is", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { preview, frames } = makePreview();
    registerBackHandler(() => {}, preview);
    // Right edge: finger starts at physical x=780 (390 CSS px) and moves left.
    window.__marcelBackStart?.(1, 400, 780);
    now += 16;
    window.__marcelBackProgress?.(0.1, 1, 400, 580);
    flushFrames(40);
    const last = frames[frames.length - 1];
    expect(last.dx).toBeCloseTo(100, 0);
    expect(last.x).toBeCloseTo(290, 0);
  });

  it("falls back to progress × width when native sends no X or a frozen X", () => {
    vi.stubGlobal("innerWidth", 400);
    const { preview, frames } = makePreview();
    registerBackHandler(() => {}, preview);
    window.__marcelBackStart?.(0, 300);
    window.__marcelBackProgress?.(0.5, 0, 300);
    flushFrames(40);
    expect(frames[frames.length - 1].dx).toBeCloseTo(200, 0);

    resetBackHandlers();
    const second = makePreview();
    registerBackHandler(() => {}, second.preview);
    window.__marcelBackStart?.(0, 300, 10);
    window.__marcelBackProgress?.(0.25, 0, 300, 10);
    flushFrames(40);
    expect(second.frames[second.frames.length - 1].dx).toBeCloseTo(100, 0);
  });

  it("finger back at the start: follows the finger even if the system's progress still lags", () => {
    vi.stubGlobal("innerWidth", 400);
    const { preview, frames } = makePreview();
    registerBackHandler(() => {}, preview);
    // Left edge, finger starts at x=10, goes in to x=210, then comes all the way back.
    window.__marcelBackStart?.(0, 300, 10);
    window.__marcelBackProgress?.(0.5, 0, 300, 210);
    flushFrames(40);
    expect(frames[frames.length - 1].dx).toBeCloseTo(200, 0);
    // The system's spring-smoothed progress is still 0.3 when the finger is already home.
    window.__marcelBackProgress?.(0.3, 0, 300, 10);
    flushFrames(40);
    expect(frames[frames.length - 1].dx).toBeLessThan(1);
  });

  it("clamps out-of-range progress", () => {
    const { preview, frames } = makePreview();
    registerBackHandler(() => {}, preview);
    window.__marcelBackStart?.(0, 0);
    window.__marcelBackProgress?.(7, 0, 0);
    flushFrames(60);
    expect(frames[frames.length - 1].progress).toBeLessThanOrEqual(1);
    window.__marcelBackProgress?.(-3, 0, 0);
    flushFrames(60);
    expect(frames[frames.length - 1].progress).toBeGreaterThanOrEqual(0);
  });

  it("cancel settles the preview and leaves the layer open", () => {
    const { preview, calls } = makePreview();
    const close = vi.fn();
    registerBackHandler(close, preview);
    window.__marcelBackStart?.(0, 0);
    window.__marcelBackProgress?.(0.3, 0, 0);
    flushFrames(2);
    window.__marcelBackCancel?.();
    expect(calls[calls.length - 1]).toBe("cancel");
    expect(close).not.toHaveBeenCalled();

    // Stray progress after cancel (a late native event) must not revive it.
    const before = calls.length;
    window.__marcelBackProgress?.(0.9, 0, 0);
    flushFrames(5);
    expect(calls.length).toBe(before);
  });

  it("commit freezes the preview, then closes the layer", () => {
    const { preview, calls } = makePreview();
    const close = vi.fn(() => calls.push("close"));
    registerBackHandler(close, preview);
    window.__marcelBackStart?.(0, 0);
    window.__marcelBackProgress?.(0.5, 0, 0);
    flushFrames(3);

    expect(window.__marcelHandleBack?.()).toBe(true);
    expect(calls.slice(-2)).toEqual(["commit", "close"]);

    // No further frames after the commit.
    const before = calls.length;
    flushFrames(5);
    expect(calls.length).toBe(before);
  });

  it("a new gesture settles one the system never resolved", () => {
    const a = makePreview();
    registerBackHandler(() => {}, a.preview);
    window.__marcelBackStart?.(0, 0);
    window.__marcelBackStart?.(0, 0);
    expect(a.calls).toEqual(["start:left", "cancel", "start:left"]);
  });

  it("cancels the preview of a layer that was covered mid-gesture", () => {
    const lower = makePreview();
    registerBackHandler(() => {}, lower.preview);
    window.__marcelBackStart?.(0, 0);

    const upperClose = vi.fn();
    registerBackHandler(upperClose);
    expect(window.__marcelHandleBack?.()).toBe(true);
    expect(lower.calls).toContain("cancel");
    expect(lower.calls).not.toContain("commit");
    expect(upperClose).toHaveBeenCalledTimes(1);
  });

  it("drops the session quietly when its layer unregisters under the finger", () => {
    const { preview, calls } = makePreview();
    const off = registerBackHandler(() => {}, preview);
    window.__marcelBackStart?.(0, 0);
    window.__marcelBackProgress?.(0.4, 0, 0);
    off();
    flushFrames(2);
    expect(calls).toContain("cancel");
    expect(calls.filter((c) => c === "update")).toHaveLength(0);
  });

  it("skips previews entirely under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const { preview, calls } = makePreview();
    const close = vi.fn();
    registerBackHandler(close, preview);
    window.__marcelBackStart?.(0, 0);
    window.__marcelBackProgress?.(0.5, 0, 0);
    flushFrames(3);
    expect(calls).toEqual([]);
    // Commit still works.
    expect(window.__marcelHandleBack?.()).toBe(true);
    expect(close).toHaveBeenCalled();
  });
});

describe('diagnostics', () => {
  it('counts what native delivered, even for layers without a preview', async () => {
    const before = getBackDiagnostics();
    registerBackHandler(() => {});
    await settleNativeSync();
    expect(getBackDiagnostics().interceptSent).toBe(true);
    expect(getBackDiagnostics().stackDepth).toBe(1);

    window.__marcelBackStart?.(0, 10);
    window.__marcelBackProgress?.(0.25, 0, 10);
    window.__marcelBackProgress?.(0.5, 0, 10);
    window.__marcelBackCancel?.();
    window.__marcelHandleBack?.();

    const d = getBackDiagnostics();
    expect(d.starts - before.starts).toBe(1);
    expect(d.frames - before.frames).toBe(2);
    expect(d.cancels - before.cancels).toBe(1);
    expect(d.commits - before.commits).toBe(1);
    expect(d.lastProgress).toBe(0.5);
    expect(d.topHadPreview).toBe(false);
  });
});
