// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConnectWithPassword } from "./useConnectWithPassword";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/components/ui/Modal", () => ({
  default: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div>{children}</div> : null),
}));
vi.mock("@/mobile/backHandler", () => ({
  registerBackHandler: () => () => {},
}));
let api: ReturnType<typeof useConnectWithPassword>;
function Host() {
  api = useConnectWithPassword();
  return api.Prompt;
}
let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Host />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function submit(value: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
it("验证中禁用重复提交；认证失败重新提问时，旧提交不能关掉新输入框", async () => {
  let finish!: () => void;
  const verify = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const success = vi.fn().mockResolvedValue(undefined);
  const first = vi.fn(async () => {
    await verify;
    api.prompt({
      title: "私钥密码",
      description: "retry",
      error: "口令不正确",
      onSubmit: success,
    });
  });
  await act(async () =>
    api.prompt({ title: "私钥密码", description: "first", onSubmit: first }),
  );
  await submit("wrong");
  expect(container.textContent).toContain("正在验证");
  expect(container.querySelector("input")!.disabled).toBe(true);
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(first).toHaveBeenCalledOnce();
  await act(async () => finish());
  expect(container.querySelector('[role="alert"]')!.textContent).toBe(
    "口令不正确",
  );
  expect(container.querySelector("input")!.value).toBe("");
  await submit("right");
  expect(success).toHaveBeenCalledWith("right");
  expect(container.querySelector("input")).toBeNull();
});
it("保存失败留在输入框中，并显示后端的可读错误", async () => {
  await act(async () =>
    api.prompt({
      title: "SSH 密码",
      description: "save",
      onSubmit: async () => {
        throw { kind: "Config", message: "密钥链不可用" };
      },
    }),
  );
  await submit("secret");
  expect(container.querySelector('[role="alert"]')!.textContent).toBe(
    "密钥链不可用",
  );
  expect(container.querySelector("input")!.disabled).toBe(false);
});
