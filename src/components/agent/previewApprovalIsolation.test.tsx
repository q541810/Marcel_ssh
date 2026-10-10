// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallInfo } from "@/lib/types";
import type { AttachmentItem } from "@/stores/agentDraftStore";
import { resetBackHandlers } from "@/mobile/backHandler";
import ApprovalDialog from "./ApprovalDialog";
import AttachmentPreview from "./AttachmentPreview";

const approval: ToolCallInfo = {
  id: "background-command",
  name: "bash",
  arguments: { command: "systemctl restart nginx" },
  disposition: "ForceApproval",
};
const textFile: AttachmentItem = {
  id: "text",
  name: "server.log",
  kind: "text",
  status: "ready",
  content: "preview text",
};
const imageFile: AttachmentItem = {
  id: "image",
  name: "server.png",
  kind: "image",
  status: "ready",
  previewUrl: "data:image/png;base64,aW1hZ2U=",
};

const scenarios = [
  { label: "桌面文本", mobile: false, item: textFile, decoded: false },
  { label: "手机文本", mobile: true, item: textFile, decoded: false },
  { label: "桌面图片解码中", mobile: false, item: imageFile, decoded: false },
  { label: "手机图片解码中", mobile: true, item: imageFile, decoded: false },
  { label: "桌面图片已就绪", mobile: false, item: imageFile, decoded: true },
  { label: "手机图片已就绪", mobile: true, item: imageFile, decoded: true },
];
type Scenario = (typeof scenarios)[number];

let root: Root;
let host: HTMLDivElement;
let trigger: HTMLButtonElement;
let onApprove: ReturnType<typeof vi.fn>;
let onReject: ReturnType<typeof vi.fn>;
let onApprovalClose: ReturnType<typeof vi.fn>;
let onMinimize: ReturnType<typeof vi.fn>;
let onPreviewClose: ReturnType<typeof vi.fn>;

function Harness({
  scenario,
  showApproval,
}: {
  scenario: Scenario;
  showApproval: boolean;
}) {
  const [previewOpen, setPreviewOpen] = useState(true);
  return (
    <>
      {showApproval && (
        <ApprovalDialog
          open
          toolCall={approval}
          onApprove={onApprove}
          onReject={onReject}
          onClose={onApprovalClose}
          onMinimize={onMinimize}
        />
      )}
      <AttachmentPreview
        item={previewOpen ? scenario.item : null}
        mobile={scenario.mobile}
        onClose={() => {
          setPreviewOpen(false);
          onPreviewClose();
        }}
      />
    </>
  );
}

function dialog() {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error("预览对话框未挂载");
  return found;
}

async function showPendingApproval(scenario: Scenario) {
  await act(async () =>
    root.render(<Harness scenario={scenario} showApproval={false} />),
  );
  if (scenario.decoded) {
    const img = dialog().querySelector("img");
    if (!img) throw new Error("图片未挂载");
    Object.defineProperties(img, {
      naturalWidth: { configurable: true, value: 800 },
      naturalHeight: { configurable: true, value: 600 },
    });
    await act(async () =>
      img.dispatchEvent(new Event("load", { bubbles: true })),
    );
  }
  await act(async () =>
    root.render(<Harness scenario={scenario} showApproval />),
  );
  // 必须越过审批首 300ms 的冷却，否则没有隔离也会假通过。
  await act(async () => vi.advanceTimersByTime(1000));
  expect(host.textContent).toContain("需要操作批准");
  const focused = document.activeElement;
  expect(focused).toBeInstanceOf(HTMLButtonElement);
  expect(focused?.getAttribute("aria-label")).toMatch(/^关闭/);
  expect(dialog().contains(focused)).toBe(true);
}

async function pressFocused(key: string) {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement)) throw new Error("没有活动键盘目标");
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => target.dispatchEvent(event));
  return event;
}

function expectApprovalUntouched() {
  expect(onApprove).not.toHaveBeenCalled();
  expect(onReject).not.toHaveBeenCalled();
  expect(onMinimize).not.toHaveBeenCalled();
  expect(onApprovalClose).not.toHaveBeenCalled();
}

async function finishPreviewClose() {
  await act(async () => vi.advanceTimersByTime(450));
  expect(onPreviewClose).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expectApprovalUntouched();
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  resetBackHandlers();
  onApprove = vi.fn();
  onReject = vi.fn();
  onApprovalClose = vi.fn();
  onMinimize = vi.fn();
  onPreviewClose = vi.fn();
  trigger = document.createElement("button");
  trigger.textContent = "预览附件";
  document.body.appendChild(trigger);
  trigger.focus();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  trigger.remove();
  resetBackHandlers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(scenarios)("$label 与后台审批的键盘隔离", (scenario) => {
  it("Enter 不会批准后台命令，不阻止关闭按钮默认激活，关闭后审批键盘恢复", async () => {
    await showPendingApproval(scenario);
    const closeButton = document.activeElement as HTMLButtonElement;
    const enter = await pressFocused("Enter");
    expectApprovalUntouched();
    expect(enter.defaultPrevented).toBe(false);
    // jsdom 不执行合成 KeyboardEvent 的按钮默认激活；单独验证真实 click 路径。
    await act(async () => closeButton.click());
    await finishPreviewClose();

    const approveButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "批准",
    );
    if (!approveButton) throw new Error("后台审批已丢失");
    approveButton.focus();
    await pressFocused("Enter");
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("Escape 只关闭当前预览，不批准、拒绝或收起后台审批", async () => {
    await showPendingApproval(scenario);
    const escape = await pressFocused("Escape");
    expect(escape.defaultPrevented).toBe(true);
    expectApprovalUntouched();
    await finishPreviewClose();
    expect(host.textContent).toContain("需要操作批准");
  });
});

it("手机隐藏工具栏后焦点留在画布，Enter 只恢复预览工具栏", async () => {
  await showPendingApproval(scenarios[5]);
  const canvas = dialog().querySelector<HTMLElement>(
    '[aria-label="图片预览"]',
  )!;
  for (const type of ["touchstart", "touchend"]) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", {
      value: type === "touchstart" ? [{ clientX: 100, clientY: 100 }] : [],
    });
    await act(async () => canvas.dispatchEvent(event));
  }
  await act(async () => vi.advanceTimersByTime(350));
  expect(dialog().querySelector('button[aria-label="关闭"]')).toBeNull();
  expect(document.activeElement).toBe(canvas);
  await pressFocused("Enter");
  expectApprovalUntouched();
  expect(dialog().querySelector('button[aria-label="关闭"]')).not.toBeNull();
});
