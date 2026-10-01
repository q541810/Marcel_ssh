// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { useDebugStore } from "./debugStore";

describe("debugStore 67 settings", () => {
  beforeEach(() => {
    localStorage.clear();
    useDebugStore.setState({
      debug67Mode: false,
      debug67TokenLimit: 1000,
      debug67Speed: 8,
      debug67Thinking: false,
    });
  });

  it("persists the mode and simulator controls", () => {
    const state = useDebugStore.getState();
    state.setDebug67Mode(true);
    state.setDebug67TokenLimit(2400);
    state.setDebug67Speed(14);
    state.setDebug67Thinking(true);

    expect(localStorage.getItem("marcel.debug.67Mode")).toBe("1");
    expect(localStorage.getItem("marcel.debug.67TokenLimit")).toBe("2400");
    expect(localStorage.getItem("marcel.debug.67Speed")).toBe("14");
    expect(localStorage.getItem("marcel.debug.67Thinking")).toBe("1");
    expect(useDebugStore.getState()).toMatchObject({
      debug67Mode: true,
      debug67TokenLimit: 2400,
      debug67Speed: 14,
      debug67Thinking: true,
    });
  });

  it("clamps invalid simulator values to the supported range", () => {
    const state = useDebugStore.getState();
    state.setDebug67TokenLimit(-1);
    state.setDebug67Speed(999);
    expect(useDebugStore.getState().debug67TokenLimit).toBe(1);
    expect(useDebugStore.getState().debug67Speed).toBe(30);

    state.setDebug67TokenLimit(Number.NaN);
    state.setDebug67Speed(Number.NaN);
    expect(useDebugStore.getState().debug67TokenLimit).toBe(1000);
    expect(useDebugStore.getState().debug67Speed).toBe(8);
  });
});
