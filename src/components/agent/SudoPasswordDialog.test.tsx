// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SudoPasswordDialog from "./SudoPasswordDialog";
import type { ActiveInteractionPayload } from "@/lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ respond: vi.fn(), back: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ sshRespondCredential: mocks.respond }));
vi.mock("@/hooks/usePrivacyMode", () => ({ usePrivacyMode: () => true }));
vi.mock("@/mobile/backHandler", () => ({ registerBackHandler: mocks.back }));
vi.mock("@/components/ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
const interaction: ActiveInteractionPayload = {
  type: "interactionActive",
  interactionId: "secret-request",
  kind: "credential",
  taskId: "task",
  sessionId: "session",
  conversationId: "conv",
  conversationTitle: "部署",
  queueLength: 1,
  sessionTarget: { username: "deploy", host: "private-host", port: 2222 },
  credential: { username: "root", command: "sudo id", rejected: true },
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.respond.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("显示 sudo 实际请求的账户、隐藏主机，并只通过专用接口提交密码", async () => {
  await act(async () =>
    root.render(
      <SudoPasswordDialog interaction={interaction} onMinimize={vi.fn()} />,
    ),
  );
  expect(container.textContent).toContain("root 的账户密码");
  expect(container.textContent).toContain("上次密码未被接受");
  expect(container.textContent).not.toContain("private-host");
  const input = container.querySelector("input")!;
  expect(input.type).toBe("password");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "secret");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(mocks.respond).toHaveBeenCalledWith("secret-request", "secret");
  expect(input.value).toBe("");
  expect(container.textContent).not.toContain("secret");
});
it("收起与手机返回不提交，明确取消才取消请求", async () => {
  const minimize = vi.fn();
  await act(async () =>
    root.render(
      <SudoPasswordDialog interaction={interaction} onMinimize={minimize} />,
    ),
  );
  await act(async () =>
    (
      container.querySelector('[aria-label="收起"]') as HTMLButtonElement
    ).click(),
  );
  expect(minimize).toHaveBeenCalledOnce();
  expect(mocks.back).toHaveBeenCalledWith(minimize);
  expect(mocks.respond).not.toHaveBeenCalled();
  const cancel = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "取消输入",
  )!;
  await act(async () => cancel.click());
  expect(mocks.respond).toHaveBeenCalledWith("secret-request", null);
});
