// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  keepAlive: vi.fn(),
  name: vi.fn(),
  read: vi.fn(),
  compress: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@/mobile/mobileBridge", () => ({
  withForegroundKeepAlive: mocks.keepAlive,
}));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: { mobileBackgroundSettings: { keepAliveEnabled: false } },
    }),
}));
vi.mock("@/lib/tauri", () => ({
  agentGetLocalFileName: mocks.name,
  agentReadLocalFile: mocks.read,
  agentReadMessageImage: vi.fn(),
  agentDeleteMessageImage: vi.fn(async () => {}),
}));
vi.mock("@/lib/imageAttach", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/imageAttach")>()),
  compressImageFile: mocks.compress,
  revokePendingImages: mocks.revoke,
}));

import {
  draftKeyFor,
  resetAgentDrafts,
  useAgentDraftStore,
} from "@/stores/agentDraftStore";
import {
  useAgentAttachments,
  type AgentAttachments,
} from "./useAgentAttachments";

type Args = Parameters<typeof useAgentAttachments>[0];
const args = (overrides: Partial<Args> = {}): Args => ({
  conversationId: "one",
  sessionId: "session-one",
  visionEnabled: true,
  canInteract: true,
  ...overrides,
});
let root: Root;
let container: HTMLDivElement;
let latest: AgentAttachments;
let renders = 0;
let unmounted = false;
function Harness({ options }: { options: Args }) {
  latest = useAgentAttachments(options);
  renders++;
  return null;
}
async function render(options = args()) {
  await act(async () => root.render(<Harness options={options} />));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  resetAgentDrafts();
  vi.resetAllMocks();
  mocks.keepAlive.mockImplementation(
    async (_enabled: boolean, action: () => Promise<unknown>) => action(),
  );
  mocks.name.mockImplementation(async (path: string) => path.split("/").pop());
  mocks.read.mockImplementation(async (path: string) => ({
    name: path.split("/").pop(),
    base64: btoa("text"),
    size: 4,
  }));
  mocks.compress.mockResolvedValue({
    dataUrl: "data:image/png;base64,cGlj",
    previewUrl: "blob:preview",
  });
  mocks.open.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  renders = 0;
  unmounted = false;
});
afterEach(() => {
  if (!unmounted) act(() => root.unmount());
  container.remove();
  resetAgentDrafts();
});

describe("useAgentAttachments 双端交互适配", () => {
  it("会话同步期间可以编辑和导入，但门控解除前不消费发送快照", async () => {
    const reason = "正在同步会话，请稍候";
    await render(args({ sendUnavailableReason: reason }));
    expect(latest.sendUnavailableReason).toBe(reason);
    expect(latest.sendBlockedReason).toBe(reason);
    await act(async () => {
      latest.setText("待发送正文");
      await latest.handleFileObjects([new File(["notes"], "notes.txt")]);
    });
    let snapshot: ReturnType<AgentAttachments["takeSendSnapshot"]> = null;
    await act(async () => {
      snapshot = latest.takeSendSnapshot();
    });
    expect(snapshot).toBeNull();
    expect(latest.sendBlockedReason).toBe(reason);
    expect(latest.notice).toBeNull();
    expect(latest.text).toBe("待发送正文");
    expect(latest.items).toHaveLength(1);
    expect(latest.sending).toBe(false);

    await render(args({ sendUnavailableReason: null }));
    expect(latest.sendBlockedReason).toBeNull();
    expect(latest.notice).toBeNull();
    await act(async () => {
      snapshot = latest.takeSendSnapshot();
    });
    expect(snapshot).toMatchObject({
      text: "待发送正文",
      textAttachments: [{ name: "notes.txt", content: "notes" }],
    });
    await act(async () =>
      latest.finishSend(snapshot!, { status: "committed" }),
    );
  });

  it("关闭文本订阅时输入不会重渲染宿主，发送快照仍读取真实正文", async () => {
    await render(args({ subscribeText: false }));
    const before = renders;
    await act(async () => latest.setText("正在输入的正文"));
    expect(renders).toBe(before);
    expect(latest.text).toBe("");
    expect(latest.hasContent).toBe(false);
    let snapshot: ReturnType<AgentAttachments["takeSendSnapshot"]> = null;
    await act(async () => {
      snapshot = latest.takeSendSnapshot();
    });
    expect(snapshot).toMatchObject({ text: "正在输入的正文" });
    expect(latest.sending).toBe(true);
    await act(async () =>
      latest.finishSend(snapshot!, { status: "committed" }),
    );
    expect(latest.sending).toBe(false);
  });

  it("默认订阅文本，其他会话的编辑不影响当前 hook", async () => {
    await render();
    await act(async () => latest.setText("本会话"));
    expect(latest.text).toBe("本会话");
    const before = renders;
    await act(async () =>
      useAgentDraftStore
        .getState()
        .setText(draftKeyFor("two", "session-two"), "别的会话"),
    );
    expect(renders).toBe(before);
    expect(latest.text).toBe("本会话");
  });

  it("同 session 建立 conversation 时迁移 fallback 草稿", async () => {
    await render(args({ conversationId: null }));
    const fallback = latest.draftKey;
    await act(async () => latest.setText("还没建会话的输入"));
    await render(args({ conversationId: "created" }));
    expect(latest.text).toBe("还没建会话的输入");
    expect(useAgentDraftStore.getState().getDraft(fallback).text).toBe("");
  });

  it("切到别的 session 不会收走上一台主机的 fallback 草稿", async () => {
    const first = draftKeyFor(null, "session-one");
    useAgentDraftStore.getState().setText(first, "第一台主机");
    await render(args({ conversationId: "two", sessionId: "session-two" }));
    expect(latest.text).toBe("");
    expect(useAgentDraftStore.getState().getDraft(first).text).toBe(
      "第一台主机",
    );
  });

  it.each(["", "已输入正文"])(
    "选择器未返回时首次绑定会话，附件跟随原草稿而不丢失：%s",
    async (text) => {
      await render(args({ conversationId: null }));
      const fallback = latest.draftKey;
      await act(async () => latest.setText(text));
      const pending = deferred<string[]>();
      mocks.open.mockReturnValueOnce(pending.promise);
      let operation!: Promise<void>;
      await act(async () => {
        operation = latest.handleAttach();
      });

      await render(args({ conversationId: "created" }));
      await act(async () => {
        pending.resolve(["/notes.txt"]);
        await operation;
      });

      expect(latest.items).toHaveLength(1);
      expect(latest.items[0]).toMatchObject({
        name: "notes.txt",
        status: "ready",
      });
      expect(latest.text).toBe(text);
      expect(
        useAgentDraftStore.getState().getDraft(fallback).attachments,
      ).toEqual([]);
    },
  );

  it("选择器跟随首次绑定后再次切会话，结果仍属于首次绑定的会话", async () => {
    await render(args({ conversationId: null }));
    const pending = deferred<string[]>();
    mocks.open.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.handleAttach();
    });
    await render(args({ conversationId: "created" }));
    const createdKey = latest.draftKey;
    await render(args({ conversationId: "other" }));

    await act(async () => {
      pending.resolve(["/notes.txt"]);
      await operation;
    });

    expect(latest.items).toEqual([]);
    expect(
      useAgentDraftStore.getState().getDraft(createdKey).attachments[0],
    ).toMatchObject({
      name: "notes.txt",
      status: "ready",
    });
  });

  it.each(["clear", "discard"] as const)(
    "首次绑定后 %s 目标草稿，迟到选择器不能复活原桶或目标桶",
    async (action) => {
      await render(args({ conversationId: null }));
      const fallback = latest.draftKey;
      const pending = deferred<string[]>();
      mocks.open.mockReturnValueOnce(pending.promise);
      let operation!: Promise<void>;
      await act(async () => {
        operation = latest.handleAttach();
      });
      await render(args({ conversationId: "created" }));
      await act(async () =>
        useAgentDraftStore.getState()[action](latest.draftKey),
      );
      await act(async () => {
        pending.resolve(["/notes.txt"]);
        await operation;
      });

      expect(latest.items).toEqual([]);
      expect(
        useAgentDraftStore.getState().getDraft(fallback).attachments,
      ).toEqual([]);
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it("首次绑定期间选择器报错，错误显示在绑定后的草稿", async () => {
    await render(args({ conversationId: null }));
    const fallback = latest.draftKey;
    const pending = deferred<string[]>();
    mocks.open.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.handleAttach();
    });
    await render(args({ conversationId: "created" }));
    await act(async () => {
      pending.reject({ kind: "Io", message: "文件提供方不可用" });
      await operation;
    });

    expect(latest.notice).toBe("打开文件选择器失败：文件提供方不可用");
    expect(useAgentDraftStore.getState().getDraft(fallback).notice).toBeNull();
  });

  it.each([null, [], "cancel-string", "cancel-error", "cancel-object"])(
    "取消选择器 %s 保持草稿且不报错",
    async (caseName) => {
      await render();
      await act(async () => latest.setText("未发送草稿"));
      if (caseName === "cancel-string")
        mocks.open.mockRejectedValueOnce("File picker cancelled");
      else if (caseName === "cancel-error")
        mocks.open.mockRejectedValueOnce(new Error("dialog dismissed"));
      else if (caseName === "cancel-object")
        mocks.open.mockRejectedValueOnce({
          kind: "Cancelled",
          message: "File picker cancelled",
        });
      else mocks.open.mockResolvedValueOnce(caseName);
      await act(async () => latest.handleAttach());
      expect(latest.text).toBe("未发送草稿");
      expect(latest.notice).toBeNull();
      expect(latest.items).toEqual([]);
      expect(mocks.keepAlive).toHaveBeenCalledWith(false, expect.any(Function));
    },
  );

  it("真实选择器错误展示结构化 message，随后仍可以再次打开", async () => {
    await render();
    mocks.open.mockRejectedValueOnce({ kind: "Io", message: "权限不足" });
    await act(async () => latest.handleAttach());
    expect(latest.notice).toBe("打开文件选择器失败：权限不足");
    mocks.open.mockResolvedValueOnce(["/notes.txt"]);
    await act(async () => latest.handleAttach());
    expect(latest.items[0]).toMatchObject({
      name: "notes.txt",
      status: "ready",
    });
  });

  it("选择器返回时换了会话，文件仍导入打开选择器时的草稿", async () => {
    await render();
    const firstKey = latest.draftKey;
    const pending = deferred<string[]>();
    mocks.open.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.handleAttach();
    });
    await render(args({ conversationId: "two", sessionId: "session-two" }));
    await act(async () => {
      pending.resolve(["/notes.txt"]);
      await operation;
    });
    expect(latest.items).toEqual([]);
    expect(
      useAgentDraftStore.getState().getDraft(firstKey).attachments[0],
    ).toMatchObject({ name: "notes.txt", status: "ready" });
  });

  it("选择器未返回时主动清理草稿，迟到选择不能复活该草稿", async () => {
    await render();
    const pending = deferred<string[]>();
    mocks.open.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.handleAttach();
    });
    await act(async () => latest.clear());
    await act(async () => {
      pending.resolve(["/notes.txt"]);
      await operation;
    });
    expect(latest.items).toEqual([]);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("旧导入结束不会解除仍然打开的后一次文件选择器的互斥", async () => {
    await render();
    const reading = deferred<{ name: string; base64: string; size: number }>();
    mocks.open.mockResolvedValueOnce(["/first.txt"]);
    mocks.read.mockReturnValueOnce(reading.promise);
    let first!: Promise<void>;
    await act(async () => {
      first = latest.handleAttach();
    });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    const picking = deferred<string[] | null>();
    mocks.open.mockReturnValueOnce(picking.promise);
    let second!: Promise<void>;
    await act(async () => {
      second = latest.handleAttach();
    });
    expect(mocks.open).toHaveBeenCalledTimes(2);
    await act(async () => {
      reading.resolve({ name: "first.txt", base64: btoa("first"), size: 5 });
      await first;
    });
    await act(async () => latest.handleAttach());
    expect(mocks.open).toHaveBeenCalledTimes(2);
    await act(async () => {
      picking.resolve(null);
      await second;
    });
  });

  it("普通文本粘贴不接管，文件粘贴进入附件而不修改文本", async () => {
    await render();
    const preventDefault = vi.fn();
    const ordinary = {
      clipboardData: { items: [{ kind: "string", type: "text/plain" }] },
      preventDefault,
    } as unknown as React.ClipboardEvent;
    await act(async () => latest.handlePaste(ordinary));
    expect(preventDefault).not.toHaveBeenCalled();
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    const filePaste = {
      clipboardData: { items: [{ kind: "file", getAsFile: () => file }] },
      preventDefault,
    } as unknown as React.ClipboardEvent;
    await act(async () => latest.handlePaste(filePaste));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(latest.items[0]).toMatchObject({
      name: "notes.txt",
      content: "notes",
      status: "ready",
    });
    expect(latest.text).toBe("");
    expect(latest.hasContent).toBe(true);
  });

  it("压缩期间切无视觉模型，图片保留并给出发送阻止原因", async () => {
    await render();
    const pending = deferred<{ dataUrl: string; previewUrl: string }>();
    mocks.compress.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.handleFileObjects([new File(["pic"], "photo.png")]);
    });
    expect(latest.importing).toBe(true);
    await render(args({ visionEnabled: false }));
    await act(async () => {
      pending.resolve({
        dataUrl: "data:image/png;base64,cGlj",
        previewUrl: "blob:late",
      });
      await operation;
    });
    expect(latest.items).toHaveLength(1);
    expect(latest.sendBlockedReason).toContain("当前模型不支持图片");
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it("页面卸载保留草稿及预览，重新挂载仍能看到附件", async () => {
    await render();
    await act(async () =>
      latest.handleFileObjects([new File(["pic"], "photo.png")]),
    );
    const owner = latest.draftKey;
    await act(async () => root.unmount());
    unmounted = true;
    expect(
      useAgentDraftStore.getState().getDraft(owner).attachments,
    ).toHaveLength(1);
    expect(mocks.revoke).not.toHaveBeenCalled();
    root = createRoot(container);
    unmounted = false;
    await render();
    expect(latest.items[0].previewUrl).toBe("blob:preview");
  });
});
