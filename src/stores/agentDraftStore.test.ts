// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  name: vi.fn(),
  read: vi.fn(),
  readImage: vi.fn(),
  deleteImage: vi.fn(),
  compress: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("@/lib/tauri", () => ({
  agentGetLocalFileName: mocks.name,
  agentReadLocalFile: mocks.read,
  agentReadMessageImage: mocks.readImage,
  agentDeleteMessageImage: mocks.deleteImage,
}));
vi.mock("@/lib/imageAttach", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/imageAttach")>()),
  compressImageFile: mocks.compress,
  revokePendingImages: mocks.revoke,
}));

import {
  MAX_ATTACHMENT_READ_BYTES,
  MAX_TEXT_FILE_BYTES,
} from "@/lib/attachmentAttach";
import {
  EMPTY_DRAFT,
  draftKeyFor,
  draftSendBlockedReason,
  resetAgentDrafts,
  useAgentDraftStore,
} from "./agentDraftStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const key = draftKeyFor("one", "session-one");
const otherKey = draftKeyFor("two", "session-two");
const store = () => useAgentDraftStore.getState();
const draft = (owner = key) => store().getDraft(owner);
const image = (name = "photo.png") =>
  new File(["image"], name, { type: "image/png" });
const textFile = (name = "config.txt", text = "port=22") =>
  new File([text], name, { type: "text/plain" });

beforeEach(() => {
  resetAgentDrafts();
  vi.resetAllMocks();
  mocks.name.mockImplementation(async (path: string) => path.split("/").pop());
  mocks.read.mockImplementation(async (path: string) => ({
    name: path.split("/").pop(),
    base64: btoa("port=22"),
    size: 7,
  }));
  mocks.readImage.mockResolvedValue("data:image/png;base64,cGlj");
  mocks.deleteImage.mockResolvedValue(undefined);
  let count = 0;
  mocks.compress.mockImplementation(async () => ({
    dataUrl: "data:image/webp;base64,cGlj",
    previewUrl: `blob:image-${++count}`,
  }));
});
afterEach(() => resetAgentDrafts());

describe("Agent 附件草稿 manager", () => {
  it("按会话归属，未建立会话时按 session 归属，空桶引用稳定", () => {
    expect(draftKeyFor("one", "different-session")).toBe(key);
    expect(draftKeyFor(null, "a")).not.toBe(draftKeyFor(null, "b"));
    expect(store().getDraft("missing")).toBe(EMPTY_DRAFT);
    expect(store().getDraft("another-missing")).toBe(EMPTY_DRAFT);
    store().setText(key, "第一台机器");
    store().setText(otherKey, "第二台机器");
    store().setText(key, (previous) => previous + "的内容");
    expect(draft().text).toBe("第一台机器的内容");
    expect(draft(otherKey).text).toBe("第二台机器");
  });

  it("导入即占位保序，文本文件独立存放，不改用户输入", async () => {
    store().setText(key, "检查配置");
    const operation = store().importFiles(key, [textFile(), image()]);
    expect(draft().attachments.map((item) => [item.name, item.status])).toEqual(
      [
        ["config.txt", "loading"],
        ["photo.png", "loading"],
      ],
    );
    expect(draft().text).toBe("检查配置");
    await operation;
    expect(draft().attachments.map((item) => item.status)).toEqual([
      "ready",
      "ready",
    ]);
    expect(draft().attachments[0].content).toBe("port=22");
    expect(draft().text).toBe("检查配置");
  });

  it("并发导入把 loading 计入图片容量，超额项明确失败且可在移除后重试", async () => {
    await store().importFiles(
      key,
      Array.from({ length: 4 }, (_, i) => image(`${i}.png`)),
    );
    const pending = deferred<{ dataUrl: string; previewUrl: string }>();
    mocks.compress.mockImplementationOnce(() => pending.promise);
    const first = store().importFiles(key, [image("fifth.png")]);
    const second = store().importFiles(key, [image("sixth.png")]);
    expect(
      draft().attachments.filter((item) => item.status !== "error"),
    ).toHaveLength(5);
    expect(draft().attachments[5]).toMatchObject({
      status: "error",
      error: expect.stringContaining("最多添加 5"),
    });
    pending.resolve({
      dataUrl: "data:image/png;base64,cGlj",
      previewUrl: "blob:fifth",
    });
    await Promise.all([first, second]);
    expect(mocks.compress).toHaveBeenCalledTimes(5);
    const rejectedId = draft().attachments[5].id;
    store().remove(key, draft().attachments[0].id);
    await store().retry(key, rejectedId);
    expect(
      draft().attachments.filter((item) => item.status === "ready"),
    ).toHaveLength(5);
    expect(mocks.compress).toHaveBeenCalledTimes(6);
  });

  it("总附件容量包含读取中条目，超出的选择有数量提示", async () => {
    const operation = store().importFiles(
      key,
      Array.from({ length: 11 }, (_, i) => textFile(`${i}.txt`)),
    );
    expect(draft().attachments).toHaveLength(10);
    expect(draft().notice).toContain("已忽略 1 个");
    await operation;
    expect(draft().attachments.every((item) => item.status === "ready")).toBe(
      true,
    );
  });

  it("移除正在压缩的图片后，迟到结果不能复活且生成的 URL 被回收", async () => {
    const pending = deferred<{ dataUrl: string; previewUrl: string }>();
    mocks.compress.mockReturnValueOnce(pending.promise);
    const operation = store().importFiles(key, [image()]);
    store().remove(key, draft().attachments[0].id);
    pending.resolve({
      dataUrl: "data:image/png;base64,cGlj",
      previewUrl: "blob:late",
    });
    await operation;
    expect(draft().attachments).toEqual([]);
    expect(mocks.revoke).toHaveBeenCalledWith([
      expect.objectContaining({ previewUrl: "blob:late" }),
    ]);
  });

  it("清空草稿使在读内容失效，同时不影响另一个会话", async () => {
    const pending = deferred<{ dataUrl: string; previewUrl: string }>();
    mocks.compress.mockReturnValueOnce(pending.promise);
    const operation = store().importFiles(key, [image()]);
    store().setText(otherKey, "保留");
    store().clear(key);
    pending.resolve({
      dataUrl: "data:image/png;base64,cGlj",
      previewUrl: "blob:cleared",
    });
    await operation;
    expect(draft()).toBe(EMPTY_DRAFT);
    expect(draft(otherKey).text).toBe("保留");
  });

  it("切换会话后在读结果只落回原草稿，显式首次发送迁移则跟随目标", async () => {
    const pending = deferred<{ dataUrl: string; previewUrl: string }>();
    mocks.compress.mockReturnValueOnce(pending.promise);
    const fallback = draftKeyFor(null, "session-one");
    const operation = store().importFiles(fallback, [image()]);
    store().setText(otherKey, "另一会话");
    store().migrateDraft(fallback, key);
    pending.resolve({
      dataUrl: "data:image/png;base64,cGlj",
      previewUrl: "blob:moved",
    });
    await operation;
    expect(draft(fallback)).toBe(EMPTY_DRAFT);
    expect(draft().attachments[0].status).toBe("ready");
    expect(draft(otherKey).attachments).toEqual([]);
  });

  it("无视觉模型保留已选图片且阻止发送，切回支持模型可发送", async () => {
    await store().importFiles(key, [image()]);
    expect(store().takeSendSnapshot(key, false)).toBeNull();
    expect(draft().attachments).toHaveLength(1);
    expect(draftSendBlockedReason(draft(), false)).toContain("当前模型不支持图片");
    expect(draft().notice).toBeNull();
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(store().takeSendSnapshot(key, true)?.images).toHaveLength(1);
  });

  it("读取中或失败项不能被发送；坏图反馈独立，其他文件仍成功", async () => {
    mocks.compress.mockRejectedValueOnce({
      kind: "Agent",
      message: "图片损坏",
    });
    const operation = store().importFiles(key, [image(), textFile()]);
    store().setText(key, "正文");
    expect(store().takeSendSnapshot(key)).toBeNull();
    await operation;
    expect(draft().attachments[0]).toMatchObject({
      status: "error",
      error: "图片损坏",
    });
    expect(draft().attachments[1].status).toBe("ready");
    expect(store().takeSendSnapshot(key)).toBeNull();
    store().remove(key, draft().attachments[0].id);
    expect(store().takeSendSnapshot(key)?.textAttachments[0].content).toBe(
      "port=22",
    );
  });

  it("仅文本附件也能发送，快照包含显式元数据；成功不清掉后来输入", async () => {
    await store().importFiles(key, [textFile()]);
    const snapshot = store().takeSendSnapshot(key)!;
    expect(snapshot.text).toBe("");
    expect(snapshot.userInput).toMatchObject({
      version: 1,
      text: "",
      textAttachments: [{ name: "config.txt", content: "port=22" }],
    });
    expect(snapshot.images).toEqual([]);
    expect(draft()).toBe(EMPTY_DRAFT);
    store().setText(key, "下一轮");
    store().finishSend(snapshot, { status: "committed" });
    expect(draft().text).toBe("下一轮");
    expect(draft().attachments).toEqual([]);
  });

  it("未提交失败恢复原 owner，保留后来输入和附件，重复回调幂等", async () => {
    store().setText(key, "原问题");
    await store().importFiles(key, [image()]);
    const snapshot = store().takeSendSnapshot(key)!;
    store().setText(key, "追加想法");
    store().setText(otherKey, "其他会话");
    await store().importFiles(key, [textFile()]);
    store().finishSend(snapshot, { status: "rejected" });
    expect(draft().text).toBe("原问题\n\n追加想法");
    expect(draft().attachments.map((item) => item.name)).toEqual([
      "photo.png",
      "config.txt",
    ]);
    expect(draft(otherKey).text).toBe("其他会话");
    expect(mocks.revoke).not.toHaveBeenCalled();
    store().finishSend(snapshot, { status: "rejected" });
    expect(draft().attachments).toHaveLength(2);
  });

  it("已提交后的启动失败只结束快照，不把内容恢复成第二条草稿", async () => {
    await store().importFiles(key, [image()]);
    const snapshot = store().takeSendSnapshot(key)!;
    expect(mocks.revoke).not.toHaveBeenCalled();
    store().finishSend(snapshot, { status: "committed" });
    expect(draft()).toBe(EMPTY_DRAFT);
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
    expect(store().sending[key]).toBeUndefined();
  });

  it("首次发送失败可绑定新 conversation，不误清另一个已存在的草稿", async () => {
    const fallback = draftKeyFor(null, "session-one");
    store().setText(fallback, "首次消息");
    await store().importFiles(fallback, [image()]);
    const snapshot = store().takeSendSnapshot(fallback)!;
    store().setText(key, "后来输入");
    store().finishSend(snapshot, { status: "rejected", draftKey: key });
    expect(draft(fallback)).toBe(EMPTY_DRAFT);
    expect(draft().text).toBe("首次消息\n\n后来输入");
    expect(draft().attachments[0].status).toBe("ready");
    expect(store().sending).toEqual({});
  });

  it("显式删除会话后迟到的失败不能把草稿复活", async () => {
    store().setText(key, "已删除会话的内容");
    await store().importFiles(key, [image()]);
    const snapshot = store().takeSendSnapshot(key)!;
    store().discard(key);
    store().finishSend(snapshot, { status: "rejected" });
    expect(draft()).toBe(EMPTY_DRAFT);
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
  });

  it("撤回恢复正文、文本附件和图片；缺新结构的旧文本不猜测拆分", async () => {
    await store().restoreMessage(key, {
      text: "说明",
      textAttachments: [
        { id: "old-text", name: "settings.ini", content: "hello" },
      ],
      imagePaths: ["one/original_0.webp"],
    });
    expect(draft().text).toBe("说明");
    expect(draft().attachments.map((item) => item.kind)).toEqual([
      "text",
      "image",
    ]);
    expect(draft().attachments[1].persistedPath).toBe("one/original_0.webp");
    expect(mocks.deleteImage).not.toHaveBeenCalled();
    store().remove(key, draft().attachments[1].id);
    expect(mocks.deleteImage).toHaveBeenCalledWith("one/original_0.webp");
    const oldText = "===== 文件名: notes.txt =====\n用户手写的正文";
    await store().restoreMessage(otherKey, { text: oldText });
    expect(draft(otherKey).text).toBe(oldText);
    expect(draft(otherKey).attachments).toEqual([]);
  });

  it("合并恢复超出容量时保留原有数据，发送门控要求用户处理", async () => {
    await store().restoreMessage(key, {
      text: "旧输入",
      textAttachments: Array.from({ length: 11 }, (_, i) => ({
        id: String(i),
        name: `${i}.txt`,
        content: "x",
      })),
      imagePaths: ["one/original.webp"],
    });
    expect(draft().attachments).toHaveLength(12);
    expect(draftSendBlockedReason(draft(), true)).toContain(
      "最多发送 10 个附件",
    );
    expect(mocks.readImage).toHaveBeenCalledWith("one/original.webp");
  });

  it("SAF 路径用真实文件名分类，读取错误保留为可重试项", async () => {
    const path = "content://provider/document/12345";
    mocks.name.mockResolvedValueOnce("camera.png");
    mocks.read.mockRejectedValueOnce({
      kind: "Agent",
      message: "访问权限已过期",
    });
    await store().importPaths(key, [path]);
    const failed = draft().attachments[0];
    expect(failed).toMatchObject({
      name: "camera.png",
      kind: "image",
      status: "error",
      error: "访问权限已过期",
    });
    mocks.name.mockResolvedValueOnce("camera.png");
    mocks.read.mockResolvedValueOnce({
      name: "camera.png",
      base64: btoa("pic"),
      size: 3,
    });
    await store().retry(key, failed.id);
    expect(draft().attachments[0]).toMatchObject({
      id: failed.id,
      status: "ready",
    });
  });

  it("原始 File 和路径入口统一 10 MB 上限，文本继续使用 5 MB", async () => {
    const hugeImage = image();
    Object.defineProperty(hugeImage, "size", {
      value: MAX_ATTACHMENT_READ_BYTES + 1,
    });
    await store().importFiles(key, [hugeImage]);
    expect(draft().attachments[0].error).toContain("10 MB");
    mocks.read.mockResolvedValueOnce({
      name: "camera.png",
      base64: btoa("pic"),
      size: MAX_ATTACHMENT_READ_BYTES + 1,
    });
    await store().importPaths(key, ["/camera.png"]);
    expect(draft().attachments[1].error).toContain("10 MB");
    expect(mocks.compress).not.toHaveBeenCalled();
    const hugeText = textFile();
    Object.defineProperty(hugeText, "size", { value: MAX_TEXT_FILE_BYTES + 1 });
    await store().importFiles(key, [hugeText]);
    expect(draft().attachments[2].error).toContain("5 MB");
  });

  it("未知二进制内容明确报错，GBK 文本仍可导入", async () => {
    await store().importFiles(key, [
      new File(
        [new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112])],
        "camera.heic",
      ),
      new File([new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])], "legacy.log"),
    ]);
    expect(draft().attachments[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining("二进制"),
    });
    expect(draft().attachments[1]).toMatchObject({
      status: "ready",
      content: "中文",
    });
  });
});
