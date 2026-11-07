// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMascotFrames } from "@/lib/mascot/frames";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const fireConfetti = vi.fn();
let reduced = false;
vi.mock("@/lib/confetti", () => ({
  fireConfetti: (b: unknown) => fireConfetti(b),
  prefersReducedMotion: () => reduced,
}));

let host: HTMLDivElement;
let root: Root;

/** 一块够用的假 2D 画布：变身动画要的方法都有，什么也不画。 */
function fakeContext() {
  const noop = () => {};
  return new Proxy({}, {
    get: (_t, key) => (key === "createLinearGradient" ? () => ({ addColorStop: noop }) : noop),
    set: () => true,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  reduced = false;
  localStorage.clear();
  await loadMascotFrames(); // 预先加载：第一下戳下去就能同步开演
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(fakeContext as never);
  vi.resetModules();
  const Logo = (await import("./EasterEggLogo")).default;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Logo className="logo" />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const button = () => host.querySelector("button") as HTMLButtonElement;
const img = () => host.querySelector("img") as HTMLImageElement;
const sprite = () => host.querySelector('canvas[role="img"]');
const morph = () => host.querySelector('canvas[aria-hidden="true"]');

async function poke() {
  await act(async () => {
    button().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    button().click();
  });
}

describe("EasterEggLogo 变像素", () => {
  it("没戳之前就是原图，没有像素小人", () => {
    expect(img().style.visibility).toBe("");
    expect(sprite()).toBeNull();
    expect(morph()).toBeNull();
  });

  it("第一下戳下去：原图让位（只隐藏、版面还撑着），变身画布和像素小人出现", async () => {
    await poke();
    expect(img().style.visibility).toBe("hidden");
    expect(host.contains(img())).toBe(true);
    expect(sprite()).not.toBeNull();
    expect(morph()).not.toBeNull();
  });

  it("再戳不会重来：同一时刻只有一块变身画布，没有第二个像素小人", async () => {
    await poke();
    await poke();
    await poke();
    expect(host.querySelectorAll('canvas[aria-hidden="true"]')).toHaveLength(1);
    expect(host.querySelectorAll('canvas[role="img"]')).toHaveLength(1);
  });

  it("画布不可用时不演动画：直接交棒给像素小人，不抛错", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await poke();
    expect(morph()).toBeNull();
    expect(sprite()).not.toBeNull();
    expect(img().style.visibility).toBe("hidden");
  });

  it("变身完成后再戳，仍然是同一个像素小人、不再有变身画布", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await poke();
    const first = sprite();
    await poke();
    await poke();
    expect(morph()).toBeNull();
    expect(sprite()).toBe(first);
  });

  it("减少动态效果：不演动画，直接是像素小人，也不炸碎片", async () => {
    reduced = true;
    await poke();
    expect(morph()).toBeNull();
    expect(sprite()).not.toBeNull();
    expect(img().style.visibility).toBe("hidden");
    expect(fireConfetti).not.toHaveBeenCalled();
  });
});
