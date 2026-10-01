// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReloadDiff } from "@/lib/types";
import { useDebugStore } from "@/stores/debugStore";
import DebugPage from "./DebugPage";

const mocks = vi.hoisted(() => ({
  addDebugServer: vi.fn(),
  pluginReload: vi.fn<() => Promise<ReloadDiff>>(),
  viewSetActiveId: vi.fn(),
  connections: [] as Array<{ id: string }>,
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(mocks),
    { getState: () => ({ addDebugServer: mocks.addDebugServer }) },
  ),
}));
vi.mock("@/stores/viewStore", () => ({
  useViewStore: { getState: () => ({ setActiveId: mocks.viewSetActiveId }) },
}));
vi.mock("@/lib/tauri", () => ({
  pluginReload: mocks.pluginReload,
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  mocks.pluginReload.mockResolvedValue({
    allIds: ["plugin-a", "plugin-b"],
    changed: ["plugin-a", "plugin-b"],
    removed: ["plugin-old"],
  });
  mocks.connections = [];
  localStorage.removeItem("marcel.debug.lightMode");
  localStorage.removeItem("marcel.debug.67Mode");
  useDebugStore.setState({ forceReasoningEffortPicker: false, lightMode: false, debug67Mode: false, debug67TokenLimit: 1000, debug67Speed: 8, debug67Thinking: false });
  delete document.documentElement.dataset.marcelTheme;
  localStorage.removeItem("marcel.debug.lightMode");
  localStorage.removeItem("marcel.debug.67Mode");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useDebugStore.setState({ forceReasoningEffortPicker: false, lightMode: false, debug67Mode: false, debug67TokenLimit: 1000, debug67Speed: 8, debug67Thinking: false });
  delete document.documentElement.dataset.marcelTheme;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<DebugPage />));
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  return button!;
}

function checkboxWithText(text: string): HTMLInputElement {
  const label = Array.from(host.querySelectorAll("label")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox).toBeTruthy();
  return checkbox!;
}

function pointer(button: HTMLButtonElement, type: "pointerdown" | "pointerup" | "pointercancel" | "lostpointercapture") {
  act(() => button.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 })));
}

function key(button: HTMLButtonElement, type: "keydown" | "keyup", value: string, repeat = false) {
  act(() => button.dispatchEvent(new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key: value,
    repeat,
  })));
}

async function advanceTime(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms));
}

describe("DebugPage", () => {
  it("adds one passwordless virtual server through the shared store action", async () => {
    await render();
    expect(host.textContent).toContain("仅在本次运行中有效");
    const add = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("添加虚拟服务器"),
    );
    expect(add).toBeTruthy();
    await act(async () => add?.click());
    expect(mocks.addDebugServer).toHaveBeenCalledTimes(1);
  });

  it("shows the server-list action once the debug connection exists", async () => {
    mocks.connections = [{ id: "debug:msfakeserver" }];
    await render();
    expect(host.textContent).toContain("已添加虚拟服务器");
    expect(host.textContent).toContain("去服务器列表");
  });

  it("toggles forced reasoning visibility in the shared debug store", async () => {
    await render();
    const checkbox = checkboxWithText("强制显示思考强度滑条");
    expect(checkbox.checked).toBe(false);
    expect(useDebugStore.getState().forceReasoningEffortPicker).toBe(false);

    act(() => checkbox.click());
    expect(checkbox.checked).toBe(true);
    expect(useDebugStore.getState().forceReasoningEffortPicker).toBe(true);

    act(() => checkbox.click());
    expect(checkbox.checked).toBe(false);
    expect(useDebugStore.getState().forceReasoningEffortPicker).toBe(false);
  });

  it("reflects an existing forced reasoning setting and an external reset", async () => {
    useDebugStore.getState().setForceReasoningEffortPicker(true);
    await render();
    const checkbox = checkboxWithText("强制显示思考强度滑条");
    expect(checkbox.checked).toBe(true);

    act(() => useDebugStore.getState().setForceReasoningEffortPicker(false));
    expect(checkbox.checked).toBe(false);
  });

  it("toggles the experimental light theme on the document root", async () => {
    await render();
    const checkbox = checkboxWithText("亮色模式");
    expect(checkbox.checked).toBe(false);
    expect(document.documentElement.dataset.marcelTheme).toBeUndefined();

    act(() => checkbox.click());
    expect(checkbox.checked).toBe(true);
    expect(document.documentElement.dataset.marcelTheme).toBe("light");

    act(() => checkbox.click());
    expect(checkbox.checked).toBe(false);
    expect(document.documentElement.dataset.marcelTheme).toBeUndefined();
  });

  it("toggles the persistent 67 simulation mode", async () => {
    await render();
    const checkbox = checkboxWithText("67 模式");
    expect(checkbox.checked).toBe(false);

    act(() => checkbox.click());
    expect(checkbox.checked).toBe(true);
    expect(useDebugStore.getState().debug67Mode).toBe(true);
    expect(localStorage.getItem("marcel.debug.67Mode")).toBe("1");

    act(() => checkbox.click());
    expect(checkbox.checked).toBe(false);
    expect(localStorage.getItem("marcel.debug.67Mode")).toBeNull();
  });

  it("edits the persistent 67 output controls", async () => {
    await render();
    act(() => checkboxWithText("67 模式").click());

    const tokenInput = host.querySelector<HTMLInputElement>('input[aria-label="67 模式输出 token 上限"]');
    const speedInput = host.querySelector<HTMLInputElement>('input[aria-label="67 模式输出速度"]');
    const thinking = checkboxWithText("先思考一会儿再输出 67");
    expect(tokenInput).toBeTruthy();
    expect(speedInput).toBeTruthy();

    act(() => {
      useDebugStore.getState().setDebug67TokenLimit(2400);
      useDebugStore.getState().setDebug67Speed(12);
      thinking.click();
    });

    expect(tokenInput!.value).toBe("2400");
    expect(speedInput!.value).toBe("12");

    expect(useDebugStore.getState().debug67TokenLimit).toBe(2400);
    expect(useDebugStore.getState().debug67Speed).toBe(12);
    expect(useDebugStore.getState().debug67Thinking).toBe(true);
    expect(localStorage.getItem("marcel.debug.67TokenLimit")).toBe("2400");
    expect(localStorage.getItem("marcel.debug.67Speed")).toBe("12");
    expect(localStorage.getItem("marcel.debug.67Thinking")).toBe("1");
  });

  it("reloads plugins and reports changed and removed plugin counts", async () => {
    await render();
    await act(async () => buttonWithText("尝试热重载插件").click());

    expect(mocks.pluginReload).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("变更 2 个");
    expect(host.textContent).toContain("移除 1 个");
    expect(buttonWithText("尝试热重载插件").disabled).toBe(false);
  });

  it("disables plugin reload and prevents duplicate requests while it is pending", async () => {
    let finishReload!: (diff: ReloadDiff) => void;
    mocks.pluginReload.mockImplementationOnce(() => new Promise<ReloadDiff>((resolve) => {
      finishReload = resolve;
    }));
    await render();
    const button = buttonWithText("尝试热重载插件");
    act(() => button.click());

    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("正在尝试热重载");
    act(() => button.click());
    expect(mocks.pluginReload).toHaveBeenCalledTimes(1);

    await act(async () => finishReload({ allIds: [], changed: [], removed: [] }));
    expect(button.disabled).toBe(false);
    expect(host.textContent).toContain("变更 0 个");
  });

  it("reports a plugin reload failure and allows another attempt", async () => {
    mocks.pluginReload.mockRejectedValueOnce(new Error("Plugin scan failed"));
    await render();
    const button = buttonWithText("尝试热重载插件");
    await act(async () => button.click());

    expect(host.textContent).toContain("插件热重载失败");
    expect(button.disabled).toBe(false);

    await act(async () => button.click());
    expect(mocks.pluginReload).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("变更 2 个");
    expect(host.textContent).not.toContain("插件热重载失败");
  });
});
