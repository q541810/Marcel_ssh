// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PREVIEW_IMAGE_SIZE } from "@/lib/constants";
import type { ImagePreviewSource } from "@/lib/imagePreview";

const native = vi.hoisted(() => ({
  listen: vi.fn(),
  preview: vi.fn<typeof import("@/lib/tauri").sftpPreviewImage>(),
  cleanup: vi.fn<typeof import("@/lib/tauri").sftpPreviewCleanup>(),
  convert: vi.fn<(path: string) => string>(),
  revoke: vi.fn(),
}));

// 使用真实事件订阅原语，只有原生边界由测试控制。
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: native.convert }));
vi.mock("@/lib/tauri", () => ({
  sftpPreviewImage: native.preview,
  sftpPreviewCleanup: native.cleanup,
}));

import { resetEventChannelsForTest, subscriberCount } from "@/lib/tauriEvent";
import { useImagePreviewSource } from "./useImagePreviewSource";

const PROGRESS_EVENT = "sftp-preview-progress";
const remoteA: ImagePreviewSource = {
  kind: "sftp",
  sessionId: "session",
  filePath: "/a.png",
};
const remoteB: ImagePreviewSource = {
  kind: "sftp",
  sessionId: "session",
  filePath: "/b.png",
};
const local: ImagePreviewSource = { kind: "local", src: "blob:attachment" };

type Options = Parameters<typeof useImagePreviewSource>[0];
type Listener = {
  handler: (event: { payload: unknown }) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLDivElement;
let mounted: boolean;
let latest: ReturnType<typeof useImagePreviewSource>;
let listeners: Listener[];
let ready: ReturnType<typeof deferred<void>> | null;

function Harness(props: Options) {
  latest = useImagePreviewSource(props);
  return null;
}

async function render(
  source: ImagePreviewSource,
  options: { open?: boolean; fileSize?: number } = {},
) {
  await act(async () => {
    root.render(
      <Harness
        open={options.open ?? true}
        source={source}
        fileSize={options.fileSize}
      />,
    );
  });
}

async function unmount() {
  if (!mounted) return;
  await act(async () => root.unmount());
  mounted = false;
}

async function emit(
  listener: Listener,
  previewId: string,
  written: number,
  total = 100,
) {
  await act(async () =>
    listener.handler({ payload: { previewId, written, total } }),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static revokeObjectURL = native.revoke;
    },
  );
  listeners = [];
  ready = null;
  native.listen
    .mockReset()
    .mockImplementation((_name: string, handler: Listener["handler"]) => {
      const unsubscribe = vi.fn();
      listeners.push({ handler, unsubscribe });
      return ready
        ? ready.promise.then(() => unsubscribe)
        : Promise.resolve(unsubscribe);
    });
  native.preview
    .mockReset()
    .mockResolvedValue({ localPath: "/tmp/preview.png" });
  native.cleanup.mockReset().mockResolvedValue(undefined);
  native.convert.mockReset().mockImplementation((path) => `asset://${path}`);
  native.revoke.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
});

afterEach(async () => {
  await unmount();
  resetEventChannelsForTest();
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useImagePreviewSource local ownership", () => {
  it.each([remoteA, local])(
    "关闭状态不读取、订阅或清理 $kind 来源",
    async (source) => {
      await render(source, { open: false });
      expect(latest).toMatchObject({
        imageSrc: null,
        loading: false,
        progress: null,
        error: null,
      });
      expect(native.listen).not.toHaveBeenCalled();
      expect(native.preview).not.toHaveBeenCalled();
      expect(native.cleanup).not.toHaveBeenCalled();
      expect(native.convert).not.toHaveBeenCalled();
      expect(native.revoke).not.toHaveBeenCalled();
    },
  );

  it.each([
    "blob:attachment",
    "data:image/png;base64,aW1hZ2U=",
    "asset://localhost/saved.png",
  ])("直接展示 %s，切页与关闭不回收调用方的 URL", async (src) => {
    const source: ImagePreviewSource = { kind: "local", src };
    await render(source, { fileSize: MAX_PREVIEW_IMAGE_SIZE + 1 });
    expect(latest).toMatchObject({
      imageSrc: src,
      loading: false,
      progress: null,
      error: null,
    });
    await render({ kind: "local", src: "blob:next" });
    await render(source, { open: false });
    await unmount();
    expect(native.listen).not.toHaveBeenCalled();
    expect(native.preview).not.toHaveBeenCalled();
    expect(native.cleanup).not.toHaveBeenCalled();
    expect(native.convert).not.toHaveBeenCalled();
    expect(native.revoke).not.toHaveBeenCalled();
  });

  it("主 URL 失败切换一次后备来源，重复旧事件不会把后备来源判为失败", async () => {
    await render({
      kind: "local",
      src: "blob:main",
      fallbackSrc: "data:image/png;base64,fallback",
    });
    const primaryError = latest.onImageError;
    await act(async () => primaryError());
    expect(latest).toMatchObject({
      imageSrc: "data:image/png;base64,fallback",
      loading: false,
      error: null,
    });
    await act(async () => primaryError());
    expect(latest.error).toBeNull();
    await act(async () => latest.onImageError());
    expect(latest.imageSrc).toBeNull();
    expect(latest.error).toContain("图片无法显示");
    expect(native.revoke).not.toHaveBeenCalled();
  });

  it.each([undefined, "blob:main"])(
    "缺少或重复后备 URL 时给出可读解码错误 (%s)",
    async (fallbackSrc) => {
      await render({ kind: "local", src: "blob:main", fallbackSrc });
      await act(async () => latest.onImageError());
      expect(latest).toMatchObject({ imageSrc: null, loading: false });
      expect(latest.error).toContain("图片无法显示");
      expect(native.cleanup).not.toHaveBeenCalled();
    },
  );

  it("空主 URL 有后备则直接显示，没有可用来源时不请求空地址", async () => {
    await render({ kind: "local", src: "", fallbackSrc: "blob:fallback" });
    expect(latest).toMatchObject({
      imageSrc: "blob:fallback",
      loading: false,
      error: null,
    });
    await render({ kind: "local", src: "" });
    expect(latest).toMatchObject({ imageSrc: null, loading: false });
    expect(latest.error).toContain("图片无法显示");
  });

  it("同值 source 重建、补充本地文件大小不会重置已经选择的后备来源", async () => {
    await render({
      kind: "local",
      src: "blob:main",
      fallbackSrc: "blob:fallback",
    });
    await act(async () => latest.onImageError());
    await render(
      { kind: "local", src: "blob:main", fallbackSrc: "blob:fallback" },
      { fileSize: 128 },
    );
    expect(latest).toMatchObject({ imageSrc: "blob:fallback", error: null });
  });

  it("切图或关闭后，旧图的解码失败事件不能污染当前图片", async () => {
    await render(local);
    const oldError = latest.onImageError;
    await render({ kind: "local", src: "blob:new" });
    await act(async () => oldError());
    expect(latest).toMatchObject({ imageSrc: "blob:new", error: null });
    const closedError = latest.onImageError;
    await render(local, { open: false });
    await act(async () => closedError());
    expect(latest).toMatchObject({
      imageSrc: null,
      loading: false,
      progress: null,
      error: null,
    });
    await render(local);
    await act(async () => oldError());
    expect(latest).toMatchObject({ imageSrc: local.src, error: null });
  });
});

describe("useImagePreviewSource SFTP lifecycle", () => {
  it("等待进度订阅就绪后下载，只显示本次进度，关闭时清理自己的临时文件", async () => {
    ready = deferred<void>();
    const download = deferred<{ localPath: string }>();
    native.preview.mockReturnValue(download.promise);
    await render(remoteA);
    expect(latest).toMatchObject({
      loading: true,
      imageSrc: null,
      progress: null,
    });
    expect(native.preview).not.toHaveBeenCalled();
    await act(async () => ready!.resolve());
    expect(native.preview).toHaveBeenCalledWith(
      "session",
      "/a.png",
      expect.any(String),
    );
    const previewId = native.preview.mock.calls[0][2];
    await emit(listeners[0], "another-preview", 70);
    expect(latest.progress).toBeNull();
    await emit(listeners[0], previewId, 30);
    expect(latest.progress).toEqual({ written: 30, total: 100 });
    await act(async () => download.resolve({ localPath: "/tmp/a.png" }));
    expect(latest).toMatchObject({
      imageSrc: "asset:///tmp/a.png",
      loading: false,
      error: null,
    });
    expect(native.convert).toHaveBeenCalledWith("/tmp/a.png");
    expect(native.cleanup).not.toHaveBeenCalled();
    expect(subscriberCount(PROGRESS_EVENT)).toBe(0);
    expect(listeners[0].unsubscribe).toHaveBeenCalledTimes(1);
    await render(remoteA, { open: false });
    await unmount();
    expect(native.cleanup.mock.calls).toEqual([["/tmp/a.png"]]);
    expect(native.revoke).not.toHaveBeenCalled();
  });

  it("相同原始字段重新构造 source，不重订阅、重复下载或重置进度", async () => {
    const download = deferred<{ localPath: string }>();
    native.preview.mockReturnValue(download.promise);
    await render({ ...remoteA }, { fileSize: 200 });
    await emit(listeners[0], native.preview.mock.calls[0][2], 30, 200);
    await render({ ...remoteA }, { fileSize: 200 });
    expect(latest.progress).toEqual({ written: 30, total: 200 });
    expect(native.preview).toHaveBeenCalledTimes(1);
    expect(native.listen).toHaveBeenCalledTimes(1);
    await act(async () => download.resolve({ localPath: "/tmp/a.png" }));
    await render({ ...remoteA }, { fileSize: 200 });
    expect(latest.imageSrc).toBe("asset:///tmp/a.png");
    expect(native.preview).toHaveBeenCalledTimes(1);
    expect(native.cleanup).not.toHaveBeenCalled();
  });

  it.each(["close", "unmount"])(
    "订阅尚未就绪时 %s，订阅返回后立即回收且不发起下载",
    async (action) => {
      ready = deferred<void>();
      await render(remoteA);
      if (action === "close") await render(remoteA, { open: false });
      else await unmount();
      await act(async () => ready!.resolve());
      expect(native.preview).not.toHaveBeenCalled();
      expect(native.cleanup).not.toHaveBeenCalled();
      expect(subscriberCount(PROGRESS_EVENT)).toBe(0);
      expect(listeners[0].unsubscribe).toHaveBeenCalledTimes(1);
      if (action === "close") expect(latest.loading).toBe(false);
    },
  );

  it("下载中关闭，迟到的结果仅清理其临时路径，不转换为图片 URL", async () => {
    const download = deferred<{ localPath: string }>();
    native.preview.mockReturnValue(download.promise);
    await render(remoteA);
    await render(remoteA, { open: false });
    expect(subscriberCount(PROGRESS_EVENT)).toBe(0);
    await act(async () => download.resolve({ localPath: "/tmp/late.png" }));
    expect(latest).toMatchObject({
      imageSrc: null,
      loading: false,
      progress: null,
      error: null,
    });
    expect(native.cleanup.mock.calls).toEqual([["/tmp/late.png"]]);
    expect(native.convert).not.toHaveBeenCalled();
    await unmount();
    expect(native.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(["A", "B"])(
    "切图后 %s 的下载先返回，各轮只清理自己的临时路径",
    async (first) => {
      const a = deferred<{ localPath: string }>();
      const b = deferred<{ localPath: string }>();
      native.preview
        .mockReturnValueOnce(a.promise)
        .mockReturnValueOnce(b.promise);
      await render(remoteA);
      const aId = native.preview.mock.calls[0][2];
      await render(remoteB);
      const bListener = listeners[1];
      await emit(bListener, aId, 90);
      expect(latest.progress).toBeNull();
      if (first === "A") {
        await act(async () => a.resolve({ localPath: "/tmp/a.png" }));
        expect(latest).toMatchObject({ loading: true, imageSrc: null });
        await act(async () => b.resolve({ localPath: "/tmp/b.png" }));
      } else {
        await act(async () => b.resolve({ localPath: "/tmp/b.png" }));
        expect(native.cleanup).not.toHaveBeenCalled();
        await act(async () => a.resolve({ localPath: "/tmp/a.png" }));
      }
      expect(latest).toMatchObject({
        imageSrc: "asset:///tmp/b.png",
        loading: false,
        error: null,
      });
      expect(native.cleanup.mock.calls).toEqual([["/tmp/a.png"]]);
      expect(native.convert.mock.calls).toEqual([["/tmp/b.png"]]);
      await render(remoteB, { open: false });
      expect(native.cleanup.mock.calls).toEqual([
        ["/tmp/a.png"],
        ["/tmp/b.png"],
      ]);
    },
  );

  it("远程切到本地后，旧下载晚到只回收远程文件", async () => {
    const download = deferred<{ localPath: string }>();
    native.preview.mockReturnValue(download.promise);
    await render(remoteA);
    await render(local);
    await act(async () => download.resolve({ localPath: "/tmp/late.png" }));
    expect(latest).toMatchObject({
      imageSrc: local.src,
      loading: false,
      error: null,
    });
    await render(local, { open: false });
    expect(native.cleanup.mock.calls).toEqual([["/tmp/late.png"]]);
    expect(native.revoke).not.toHaveBeenCalled();
  });

  it("结构化下载错误显示 message 并退订，下次打开可正常读取", async () => {
    native.preview.mockRejectedValueOnce({
      kind: "Sftp",
      message: "远程图片已移走",
    });
    await render(remoteA);
    expect(latest).toMatchObject({
      imageSrc: null,
      loading: false,
      error: "远程图片已移走",
    });
    expect(subscriberCount(PROGRESS_EVENT)).toBe(0);
    expect(native.cleanup).not.toHaveBeenCalled();
    await render(remoteA, { open: false });
    await render(remoteA);
    expect(latest).toMatchObject({
      imageSrc: "asset:///tmp/preview.png",
      loading: false,
      error: null,
    });
  });

  it("旧请求失败不会覆盖新图或清理新图文件", async () => {
    const oldDownload = deferred<{ localPath: string }>();
    native.preview.mockReturnValueOnce(oldDownload.promise);
    await render(remoteA);
    await render(remoteB);
    await act(async () =>
      oldDownload.reject({ kind: "Sftp", message: "旧下载已断开" }),
    );
    expect(latest).toMatchObject({
      imageSrc: "asset:///tmp/preview.png",
      loading: false,
      error: null,
    });
    expect(native.cleanup).not.toHaveBeenCalled();
  });

  it("订阅注册失败仍按既有契约尝试下载，不遗留事件通道", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    native.listen.mockRejectedValueOnce(new Error("event bridge unavailable"));
    await render(remoteA);
    expect(native.preview).toHaveBeenCalledTimes(1);
    expect(latest).toMatchObject({
      imageSrc: "asset:///tmp/preview.png",
      loading: false,
      error: null,
    });
    expect(subscriberCount(PROGRESS_EVENT)).toBe(0);
  });

  it("超出已有远程预览上限时拒绝下载，切换后不残留上一张图", async () => {
    await render(remoteA, { fileSize: 1024 });
    await render(remoteB, { fileSize: MAX_PREVIEW_IMAGE_SIZE + 1 });
    expect(latest).toMatchObject({
      imageSrc: null,
      loading: false,
      progress: null,
    });
    expect(latest.error).toContain("预览上限为 50.0 MB");
    expect(native.preview).toHaveBeenCalledTimes(1);
    expect(native.cleanup.mock.calls).toEqual([["/tmp/preview.png"]]);
    expect(native.listen).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, MAX_PREVIEW_IMAGE_SIZE])(
    "大小缺失或刚好位于上限仍可预览 (%s)",
    async (fileSize) => {
      await render(remoteA, { fileSize });
      expect(latest).toMatchObject({
        imageSrc: "asset:///tmp/preview.png",
        loading: false,
        error: null,
      });
      expect(native.preview).toHaveBeenCalledTimes(1);
    },
  );

  it("远程图片解码失败有明确错误，临时文件在关闭时正常回收", async () => {
    await render(remoteA);
    await act(async () => latest.onImageError());
    expect(latest).toMatchObject({ imageSrc: null, loading: false });
    expect(latest.error).toContain("图片无法显示");
    await render(remoteA, { open: false });
    expect(native.cleanup.mock.calls).toEqual([["/tmp/preview.png"]]);
  });

  it("临时文件清理失败不影响关闭或下一张本地图片", async () => {
    native.cleanup.mockRejectedValueOnce({
      kind: "Io",
      message: "文件暂时被占用",
    });
    await render(remoteA);
    await render(local);
    expect(latest).toMatchObject({
      imageSrc: local.src,
      loading: false,
      error: null,
    });
    expect(native.cleanup.mock.calls).toEqual([["/tmp/preview.png"]]);
  });

  it("StrictMode 的已取消首轮不发起重复下载或遗留订阅", async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness open source={remoteA} />
        </StrictMode>,
      ),
    );
    expect(native.preview).toHaveBeenCalledTimes(1);
    expect(subscriberCount(PROGRESS_EVENT)).toBe(0);
    await unmount();
    expect(native.cleanup.mock.calls).toEqual([["/tmp/preview.png"]]);
  });
});
