// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compressImageFile, TARGET_IMAGE_BYTES } from "./imageAttach";

let dimensions: { width: number; height: number };
let brokenImage: boolean;
let canvas: {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: ReturnType<typeof vi.fn>;
};
let createUrl: ReturnType<typeof vi.fn>;
let revokeUrl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dimensions = { width: 100, height: 100 };
  brokenImage = false;
  let nextUrl = 0;
  createUrl = vi.fn(() => `blob:${++nextUrl}`);
  revokeUrl = vi.fn();
  const BrowserURL = URL;
  vi.stubGlobal(
    "URL",
    Object.assign(class extends BrowserURL {}, {
      createObjectURL: createUrl,
      revokeObjectURL: revokeUrl,
    }),
  );
  vi.stubGlobal(
    "Image",
    class {
      width = dimensions.width;
      height = dimensions.height;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() =>
          brokenImage ? this.onerror?.() : this.onload?.(),
        );
      }
    },
  );
  canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage: vi.fn() })),
    toBlob: vi.fn((callback: BlobCallback) =>
      callback(new Blob(["compressed"], { type: "image/webp" })),
    ),
  };
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) =>
    tag === "canvas"
      ? canvas
      : createElement(tag, options)) as typeof document.createElement);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("imageAttach 压缩与临时资源", () => {
  it("成功后回收解码 URL，只把最终预览 URL 交给 manager", async () => {
    const result = await compressImageFile(new Blob(["source"]));
    expect(result.dataUrl).toMatch(/^data:image\/webp;base64,/);
    expect(result.previewUrl).toBe("blob:2");
    expect(revokeUrl.mock.calls).toEqual([["blob:1"]]);
  });

  it("坏图释放解码 URL 并返回可读错误", async () => {
    brokenImage = true;
    await expect(compressImageFile(new Blob(["broken"]))).rejects.toThrow(
      "无法读取图片",
    );
    expect(revokeUrl.mock.calls).toEqual([["blob:1"]]);
    expect(createUrl).toHaveBeenCalledTimes(1);
  });

  it("极窄的长图缩放后仍至少一像素，零尺寸图明确拒绝", async () => {
    dimensions = { width: 1, height: 10000 };
    await compressImageFile(new Blob(["source"]));
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(2048);
    dimensions = { width: 0, height: 100 };
    await expect(compressImageFile(new Blob(["source"]))).rejects.toThrow(
      "图片尺寸无效",
    );
  });

  it("编码器降质后仍超限时不生成无法发送的预览", async () => {
    const oversized = new Blob(["small fixture"]);
    Object.defineProperty(oversized, "size", { value: TARGET_IMAGE_BYTES + 1 });
    canvas.toBlob.mockImplementation((callback: BlobCallback) =>
      callback(oversized),
    );
    await expect(compressImageFile(new Blob(["source"]))).rejects.toThrow(
      "图片压缩后仍超过 5 MB",
    );
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(revokeUrl.mock.calls).toEqual([["blob:1"]]);
  });

  it("WebP 编码不可用时回落 JPEG，并保留实际的 data URL MIME", async () => {
    canvas.toBlob.mockImplementation((callback: BlobCallback, type: string) => {
      callback(
        type === "image/webp"
          ? null
          : new Blob(["jpeg"], { type: "image/jpeg" }),
      );
    });
    const result = await compressImageFile(new Blob(["source"]));
    expect(result.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  });
});
