// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebugUnlock } from "./useDebugUnlock";

let host: HTMLDivElement;
let root: Root;
const unlock = vi.fn();

function Harness() {
  const tap = useDebugUnlock(unlock);
  return (
    <button type="button" onClick={tap}>
      version
    </button>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function tap() {
  act(() => host.querySelector("button")?.click());
}

describe("useDebugUnlock", () => {
  it("unlocks on seven taps within the interval", () => {
    for (let i = 0; i < 7; i += 1) tap();
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  it("resets the sequence after 1.2 seconds", () => {
    for (let i = 0; i < 6; i += 1) tap();
    vi.advanceTimersByTime(1200);
    tap();
    expect(unlock).not.toHaveBeenCalled();
    for (let i = 0; i < 6; i += 1) tap();
    expect(unlock).toHaveBeenCalledTimes(1);
  });
});
