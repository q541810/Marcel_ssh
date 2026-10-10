// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentItem } from "@/stores/agentDraftStore";
import AttachmentStrip, { type AttachmentStripProps } from "./AttachmentStrip";

let host: HTMLDivElement;
let root: Root;

const textFile: AttachmentItem = {
  id: "text-1",
  name: "server.log",
  kind: "text",
  status: "ready",
  size: 42,
  content: "server started",
};

async function renderStrip(props: Partial<AttachmentStripProps> = {}) {
  const onPreview = props.onPreview ?? vi.fn();
  await act(async () =>
    root.render(
      <AttachmentStrip items={[textFile]} {...props} onPreview={onPreview} />,
    ),
  );
  return onPreview;
}

function button(name: string): HTMLButtonElement {
  const element = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${name}"]`,
  );
  if (!element) throw new Error(`Missing attachment action: ${name}`);
  return element;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("AttachmentStrip", () => {
  it("预览与移除是独立的可访问按钮，移除不会打开预览", async () => {
    const onRemove = vi.fn();
    const onPreview = await renderStrip({ mobile: true, onRemove });
    const remove = button("移除 server.log");
    expect(
      remove.closest("button")?.parentElement?.closest("button"),
    ).toBeNull();
    await act(async () => remove.click());
    expect(onRemove).toHaveBeenCalledWith("text-1");
    expect(onPreview).not.toHaveBeenCalled();
    await act(async () => button("预览 server.log").click());
    expect(onPreview).toHaveBeenCalledWith("text-1");
    expect(host.textContent).toContain("42 B");
    expect(host.textContent).not.toContain("server started");
  });

  it("读取中可以移除，错误有原因和独立重试，二者不会误预览", async () => {
    const onRemove = vi.fn();
    const onRetry = vi.fn();
    const onPreview = await renderStrip({
      items: [
        {
          ...textFile,
          id: "loading",
          name: "reading.log",
          status: "loading",
          content: undefined,
        },
        {
          ...textFile,
          id: "error",
          name: "broken.log",
          status: "error",
          content: undefined,
          error: "无法读取文件内容",
        },
      ],
      onRemove,
      onRetry,
    });
    expect(button("预览 reading.log").disabled).toBe(true);
    expect(button("预览 broken.log").disabled).toBe(true);
    expect(host.textContent).toContain("正在读取");
    expect(host.textContent).toContain("无法读取文件内容");
    await act(async () => button("移除 reading.log").click());
    await act(async () => button("重试读取 broken.log").click());
    expect(onRemove).toHaveBeenCalledWith("loading");
    expect(onRetry).toHaveBeenCalledWith("error");
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("只读消息不展示移除或重试，空文本仍然能预览", async () => {
    const onPreview = await renderStrip({
      items: [{ ...textFile, content: "", size: 0 }],
    });
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(button("预览 server.log").disabled).toBe(false);
    await act(async () => button("预览 server.log").click());
    expect(onPreview).toHaveBeenCalledWith("text-1");
    expect(host.textContent).toContain("0 B");
  });

  it("不支持图片的模型只显示说明，仍能预览且不删除图片", async () => {
    const onRemove = vi.fn();
    const onPreview = await renderStrip({
      items: [
        {
          id: "photo",
          name: "screen.png",
          kind: "image",
          status: "ready",
          previewUrl: "blob:screen",
        },
      ],
      onRemove,
      visionEnabled: false,
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      "当前模型不支持图片",
    );
    expect(onRemove).not.toHaveBeenCalled();
    await act(async () => button("预览 screen.png").click());
    expect(onPreview).toHaveBeenCalledWith("photo");
  });

  it("没有内容时不制造空附件预览，没有附件时不占位置", async () => {
    await renderStrip({ items: [{ ...textFile, content: undefined }] });
    expect(button("预览 server.log").disabled).toBe(true);
    expect(host.textContent).toContain("内容暂不可用");
    await renderStrip({ items: [] });
    expect(host.childElementCount).toBe(0);
  });
});
