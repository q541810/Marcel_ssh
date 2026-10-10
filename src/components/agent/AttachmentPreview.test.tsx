// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentItem } from "@/stores/agentDraftStore";
import { resetBackHandlers } from "@/mobile/backHandler";
import AttachmentPreview from "./AttachmentPreview";

let host: HTMLDivElement;
let root: Root;
let trigger: HTMLButtonElement;

const textFile: AttachmentItem = {
  id: "text",
  name: "server.log",
  kind: "text",
  status: "ready",
  content: "hello",
};

function Harness({
  item,
  mobile,
  onClose,
}: {
  item: AttachmentItem | null;
  mobile: boolean;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <AttachmentPreview
      item={open ? item : null}
      mobile={mobile}
      onClose={() => {
        setOpen(false);
        onClose();
      }}
    />
  );
}

async function renderPreview(
  item: AttachmentItem | null = textFile,
  mobile = false,
) {
  const onClose = vi.fn();
  await act(async () =>
    root.render(<Harness item={item} mobile={mobile} onClose={onClose} />),
  );
  return onClose;
}

function button(name: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${name}"]`,
  );
  if (!element) throw new Error(`Missing preview action: ${name}`);
  return element;
}

async function click(name: string) {
  await act(async () => button(name).click());
}

async function finishClose() {
  await act(async () => vi.advanceTimersByTime(450));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  resetBackHandlers();
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
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AttachmentPreview", () => {
  it("关闭时不挂载对话框、图片或返回处理器", async () => {
    await renderPreview(null, true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(window.__marcelHandleBack?.()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("文本作为纯文本展示，HTML 附件不能插入可执行 DOM", async () => {
    const content =
      '<script>throw new Error("executed")</script><img src=x onerror=alert(1)>';
    await renderPreview({ ...textFile, name: "example.html", content });
    expect(document.querySelector("pre")?.textContent).toBe(content);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    const dialog = document.querySelector('[role="dialog"]');
    const headingId = dialog?.getAttribute("aria-labelledby");
    expect(headingId && document.getElementById(headingId)?.textContent).toBe(
      "example.html",
    );
  });

  it("大文件只挂当前一段，切换不会把前文累积进 DOM", async () => {
    const content = "开头" + "a".repeat(100_000) + "结尾";
    await renderPreview({ ...textFile, content }, true);
    expect(document.querySelector("pre")!.textContent!.length).toBeLessThan(
      30_000,
    );
    expect(document.querySelector("pre")!.textContent).toContain("开头");
    expect(document.body.textContent).toContain("发送包含完整文件内容");
    await click("下一段");
    expect(document.querySelector("pre")!.textContent!.length).toBeLessThan(
      30_000,
    );
    expect(document.querySelector("pre")!.textContent).not.toContain("开头");
    expect(document.body.textContent).toContain("第 2 / 5 段");
    await click("上一段");
    expect(document.querySelector("pre")!.textContent).toContain("开头");
  });

  it("分段边界不拆开 emoji，空文件保留明确说明", async () => {
    const content = "a".repeat(23_999) + "😀" + "末尾";
    await renderPreview({ ...textFile, content });
    const first = document.querySelector("pre")!.textContent ?? "";
    expect(first?.endsWith("😀")).toBe(true);
    await click("下一段");
    expect(first + (document.querySelector("pre")!.textContent ?? "")).toBe(
      content,
    );
    await act(async () =>
      root.render(
        <AttachmentPreview
          item={{ ...textFile, content: "" }}
          onClose={() => {}}
        />,
      ),
    );
    expect(document.body.textContent).toContain("文件内容为空");
  });

  it("对话框限制焦点，Escape 关闭后归还给附件按钮", async () => {
    const onClose = await renderPreview();
    expect(document.activeElement).toBe(button("关闭附件预览"));
    trigger.focus();
    expect(document.activeElement).toBe(button("关闭附件预览"));
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "文本附件内容",
    );
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await finishClose();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("手机系统返回关闭预览并注销这一层，关闭不重新聚焦输入框", async () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    const onClose = await renderPreview(textFile, true);
    const focus = vi.spyOn(textarea, "focus");
    await act(async () => expect(window.__marcelHandleBack?.()).toBe(true));
    await finishClose();
    expect(onClose).toHaveBeenCalledOnce();
    expect(window.__marcelHandleBack?.()).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    textarea.remove();
  });

  it("损坏/缺失内容明确降级，读取中不会假装空文件", async () => {
    await renderPreview({ ...textFile, status: "loading", content: undefined });
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "正在读取",
    );
    await act(async () =>
      root.render(
        <AttachmentPreview
          item={{ ...textFile, status: "error", error: "读取失败，权限不足" }}
          onClose={() => {}}
        />,
      ),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "权限不足",
    );
    await act(async () =>
      root.render(
        <AttachmentPreview
          item={{ ...textFile, content: undefined }}
          onClose={() => {}}
        />,
      ),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "暂不可用",
    );
  });

  it("图片保持比例，支持按钮及双指缩放并能复位", async () => {
    await renderPreview(
      {
        id: "image",
        name: "screen.png",
        kind: "image",
        status: "ready",
        previewUrl: "blob:preview",
      },
      true,
    );
    const stage = document.querySelector<HTMLDivElement>(
      '[aria-label="图片预览"]',
    )!;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 600, 400),
    );
    const image = document.querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", { value: 1200 });
    Object.defineProperty(image, "naturalHeight", { value: 800 });
    await act(async () => image.dispatchEvent(new Event("load")));
    expect(document.querySelector("output")?.textContent).toBe("50%");
    await click("放大图片");
    expect(document.querySelector("output")?.textContent).toBe("63%");
    await click("适应窗口");
    expect(document.querySelector("output")?.textContent).toBe("50%");

    async function touch(type: string, positions: number[]) {
      const event = new Event(type, {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "touches", {
        value: positions.map((clientX) => ({ clientX, clientY: 200 })),
      });
      await act(async () => stage.dispatchEvent(event));
    }
    await touch("touchstart", [250, 350]);
    await touch("touchmove", [250, 450]);
    expect(document.querySelector("output")?.textContent).toBe("100%");
    expect(image.style.transform).toContain("scale(1)");
    await touch("touchend", []);
    await click("适应窗口");
    expect(document.querySelector("output")?.textContent).toBe("50%");
  });

  it("图片加载失败有明确提示，关闭不留下图片", async () => {
    await renderPreview({
      id: "image",
      name: "broken.png",
      kind: "image",
      status: "ready",
      previewUrl: "blob:broken",
    });
    await act(async () =>
      document.querySelector("img")!.dispatchEvent(new Event("error")),
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "图片无法显示",
    );
    await click("关闭");
    await finishClose();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
