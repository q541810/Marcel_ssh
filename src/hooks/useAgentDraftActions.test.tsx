// @vitest-environment jsdom
import { act, useRef, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentConversation,
  AgentMessage,
  TruncateConversationResult,
  UserInputMetadata,
} from "@/lib/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  startTask: vi.fn<import("@/stores/taskStore").TaskState["startTask"]>(),
  truncate: vi.fn<typeof import("@/lib/tauri").agentTruncateConversation>(),
  readImage: vi.fn<typeof import("@/lib/tauri").agentReadMessageImage>(),
  deleteImage: vi.fn<typeof import("@/lib/tauri").agentDeleteMessageImage>(),
  deleteConversation:
    vi.fn<typeof import("@/lib/tauri").agentDeleteConversation>(),
  compress: vi.fn(),
  revoke: vi.fn(),
  onSend: vi.fn(),
  onRollback: vi.fn(),
}));

// 草稿、附件 hook、conversationStore 的撤回均走真实代码，只替换原生与任务启动边界。
vi.mock("@/lib/tauri", () => ({
  agentTruncateConversation: mocks.truncate,
  agentReadMessageImage: mocks.readImage,
  agentDeleteMessageImage: mocks.deleteImage,
  agentDeleteConversation: mocks.deleteConversation,
}));
vi.mock("@/lib/imageAttach", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/imageAttach")>()),
  compressImageFile: mocks.compress,
  revokePendingImages: mocks.revoke,
}));
vi.mock("@/stores/agentStreamManager", () => ({
  attachStreamListener: vi.fn(),
  attachPlanListener: vi.fn(),
  cleanupTaskListeners: vi.fn(),
}));

import { composeUserInput } from "@/lib/userInput";
import { useConversationStore } from "@/stores/conversationStore";
import { useTaskStore } from "@/stores/taskStore";
import {
  draftKeyFor,
  resetAgentDrafts,
  useAgentDraftStore,
} from "@/stores/agentDraftStore";
import {
  useAgentAttachments,
  type AgentAttachments,
} from "./useAgentAttachments";
import { useAgentDraftActions } from "./useAgentDraftActions";

type Actions = ReturnType<typeof useAgentDraftActions>;
interface Scope {
  conversationId: string | null;
  sessionId: string;
  connectionId: string;
}
const firstScope: Scope = {
  conversationId: "conversation-a",
  sessionId: "session-a",
  connectionId: "connection-a",
};
const secondScope: Scope = {
  conversationId: "conversation-b",
  sessionId: "session-b",
  connectionId: "connection-b",
};
const firstKey = draftKeyFor(firstScope.conversationId, firstScope.sessionId);
const secondKey = draftKeyFor(
  secondScope.conversationId,
  secondScope.sessionId,
);
const imageDataUrl = "data:image/webp;base64,aW1hZ2U=";
const previousImagePath = "conversation-a/previous-image.webp";
const timestamp = "2026-10-09T00:00:00.000Z";
const adjustedRollbackResult: TruncateConversationResult = {
  deletedMessages: 2,
  planAdjusted: true,
  plan: {
    taskId: "restored-plan-task",
    items: [{ id: "restored-item", title: "历史计划", status: "pending" }],
    currentIndex: 0,
  },
  planTaskId: "restored-plan-task",
};
const originalStartTask = useTaskStore.getState().startTask;
const draft = (key = firstKey) => useAgentDraftStore.getState().getDraft(key);

let root: Root;
let container: HTMLDivElement;
let latest: {
  actions: Actions;
  attachments: AgentAttachments;
  userJustSentRef: MutableRefObject<boolean>;
};

function Harness({ scope }: { scope: Scope }) {
  const attachments = useAgentAttachments({
    ...scope,
    canInteract: true,
    visionEnabled: true,
    subscribeText: false,
  });
  const userJustSentRef = useRef(false);
  const actions = useAgentDraftActions({
    attachments,
    ...scope,
    canInteract: true,
    userJustSentRef,
    onSend: mocks.onSend,
    onRollback: mocks.onRollback,
  });
  latest = { actions, attachments, userJustSentRef };
  return null;
}

async function render(scope = firstScope) {
  await act(async () => {
    useConversationStore.setState({
      activeConversationId: scope.conversationId,
    });
    root.render(<Harness scope={scope} />);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function conversation(scope: Scope): AgentConversation {
  return {
    id: scope.conversationId!,
    connectionId: scope.connectionId,
    title: scope.conversationId!,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function seedDraft(
  key = firstKey,
  text = "原来的问题",
  includeImage = true,
) {
  await act(async () => {
    useAgentDraftStore.getState().setText(key, text);
    await useAgentDraftStore
      .getState()
      .importFiles(key, [
        new File(["port=22\n"], "config.txt", { type: "text/plain" }),
        ...(includeImage
          ? [new File(["image"], "photo.png", { type: "image/png" })]
          : []),
      ]);
  });
}

function seedHistory(): AgentMessage {
  const userInput: UserInputMetadata = {
    version: 1,
    text: "历史问题",
    textAttachments: [
      {
        id: "history-file",
        name: "original.conf",
        content: "original=true\n",
        size: 14,
      },
    ],
  };
  const target: AgentMessage = {
    id: "history-user",
    role: "user",
    content: composeUserInput(userInput),
    userInput,
    imagePaths: [previousImagePath],
    timestamp: "2026-10-09T00:00:01.000Z",
  };
  useConversationStore.setState({
    messages: {
      [firstScope.conversationId!]: [
        { id: "earlier", role: "assistant", content: "更早的历史", timestamp },
        target,
        {
          id: "history-answer",
          role: "assistant",
          content: "原来的回答",
          timestamp: "2026-10-09T00:00:02.000Z",
        },
      ],
      [secondScope.conversationId!]: [
        {
          id: "other-history",
          role: "user",
          content: "另一会话历史",
          timestamp,
        },
      ],
    },
  });
  return target;
}

beforeEach(() => {
  resetAgentDrafts();
  vi.resetAllMocks();
  mocks.startTask.mockResolvedValue("task-a");
  mocks.truncate.mockResolvedValue({
    deletedMessages: 2,
    planAdjusted: false,
    plan: null,
    planTaskId: null,
  });
  mocks.readImage.mockResolvedValue(imageDataUrl);
  mocks.deleteImage.mockResolvedValue(undefined);
  mocks.deleteConversation.mockResolvedValue(undefined);
  let nextPreview = 0;
  mocks.compress.mockImplementation(async () => ({
    dataUrl: imageDataUrl,
    previewUrl: `blob:preview-${++nextPreview}`,
  }));
  useTaskStore.setState({
    tasks: {},
    plans: {},
    plansDirty: false,
    activeTaskId: null,
    compacting: {},
    startTask: mocks.startTask,
  });
  useConversationStore.setState({
    conversations: {
      [firstScope.conversationId!]: conversation(firstScope),
      [secondScope.conversationId!]: conversation(secondScope),
    },
    messages: {},
    hasEarlierMessages: {},
    activeConversationId: firstScope.conversationId,
    activeConversationBySession: {},
    activeConversationByConnection: {},
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetAgentDrafts();
  useTaskStore.setState({ startTask: originalStartTask });
});

describe("useAgentDraftActions 的异步归属与恢复", () => {
  it.each([
    { name: "提交前失败", stage: undefined },
    { name: "保存图片失败", stage: "save_images" },
  ])("$name：恢复原输入和附件，同时保留后来输入", async ({ stage }) => {
    await render();
    await seedDraft(firstKey, "  原问题\n");
    const pending = deferred<string>();
    mocks.startTask.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.actions.send();
    });
    expect(draft().text).toBe("");
    expect(draft().attachments).toEqual([]);
    expect(latest.actions.sending).toBe(true);
    expect(mocks.startTask.mock.calls[0]).toEqual([
      firstScope.sessionId,
      "  原问题\n",
      firstScope.connectionId,
      [imageDataUrl],
      [],
      {
        conversationId: firstScope.conversationId,
        userInput: {
          version: 1,
          text: "  原问题\n",
          textAttachments: [
            expect.objectContaining({
              name: "config.txt",
              content: "port=22\n",
            }),
          ],
        },
      },
    ]);
    await act(async () => {
      latest.attachments.setText("后来想到的补充");
      await latest.attachments.handleFileObjects([
        new File(["later"], "later.txt"),
      ]);
    });
    await act(async () => {
      pending.reject(
        Object.assign(new Error("磁盘暂时不可用"), stage ? { stage } : {}),
      );
      await operation;
    });
    expect(draft().text).toBe("  原问题\n\n\n后来想到的补充");
    expect(draft().attachments.map((item) => item.name)).toEqual([
      "config.txt",
      "photo.png",
      "later.txt",
    ]);
    expect(draft().notice).toContain("未发送：磁盘暂时不可用");
    expect(latest.actions.sending).toBe(false);
    expect(latest.userJustSentRef.current).toBe(false);
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.onSend).toHaveBeenCalledOnce();
  });

  it("发送等待期间切换会话，失败只恢复到发起发送的 owner", async () => {
    await render();
    await seedDraft();
    const pending = deferred<string>();
    mocks.startTask.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.actions.send();
    });
    await render(secondScope);
    await seedDraft(secondKey, "第二台主机的草稿", false);
    const otherDraft = draft(secondKey);
    await act(async () => {
      pending.reject({
        kind: "Agent",
        message: "保存图片失败",
        stage: "save_images",
        conversationId: firstScope.conversationId,
      });
      await operation;
    });
    expect(draft().text).toBe("原来的问题");
    expect(draft().attachments.map((item) => item.kind)).toEqual([
      "text",
      "image",
    ]);
    expect(draft(secondKey)).toBe(otherDraft);
    expect(latest.attachments.draftKey).toBe(secondKey);
    expect(mocks.startTask).toHaveBeenCalledOnce();
  });

  it("旧会话发送失败不能清掉新会话发送的主动滚动标志", async () => {
    await render();
    await seedDraft();
    const firstPending = deferred<string>();
    const secondPending = deferred<string>();
    mocks.startTask
      .mockReturnValueOnce(firstPending.promise)
      .mockReturnValueOnce(secondPending.promise);
    let firstOperation!: Promise<void>;
    let secondOperation!: Promise<void>;
    await act(async () => {
      firstOperation = latest.actions.send();
    });
    await render(secondScope);
    await seedDraft(secondKey, "第二台主机的问题", false);
    await act(async () => {
      secondOperation = latest.actions.send();
    });
    expect(latest.userJustSentRef.current).toBe(true);
    await act(async () => {
      firstPending.reject({ kind: "Agent", message: "第一台主机发送失败" });
      await firstOperation;
    });
    expect(latest.userJustSentRef.current).toBe(true);
    expect(useAgentDraftStore.getState().sending[secondKey]).toBe(1);
    await act(async () => {
      secondPending.reject({ kind: "Agent", message: "第二台主机发送失败" });
      await secondOperation;
    });
    expect(latest.userJustSentRef.current).toBe(false);
  });

  it("首次发送的错误携带新 conversationId，即使已切走也恢复到该新会话", async () => {
    const fallbackScope = { ...firstScope, conversationId: null };
    const fallbackKey = draftKeyFor(null, firstScope.sessionId);
    const createdKey = draftKeyFor(
      "created-conversation",
      firstScope.sessionId,
    );
    await render(fallbackScope);
    await seedDraft(fallbackKey, "首次发送");
    const pending = deferred<string>();
    mocks.startTask.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.actions.send();
    });
    expect(mocks.startTask.mock.calls[0][5]?.conversationId).toBeUndefined();
    await render(secondScope);
    await seedDraft(secondKey, "其它会话不能被覆盖", false);
    await act(async () => {
      useAgentDraftStore.getState().setText(createdKey, "新会话后来的输入");
      pending.reject({
        kind: "Agent",
        message: "图片保存失败",
        stage: "save_images",
        conversationId: "created-conversation",
      });
      await operation;
    });
    expect(draft(fallbackKey).text).toBe("");
    expect(draft(fallbackKey).attachments).toEqual([]);
    expect(draft(createdKey).text).toBe("首次发送\n\n新会话后来的输入");
    expect(draft(createdKey).attachments).toHaveLength(2);
    expect(draft(secondKey).text).toBe("其它会话不能被覆盖");
    expect(useAgentDraftStore.getState().sending).toEqual({});
  });

  it("stage=start_task 表示消息已提交，失败不重复回填，也不清掉后来输入", async () => {
    await render();
    await seedDraft();
    const pending = deferred<string>();
    mocks.startTask.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.actions.send();
    });
    await act(async () => {
      useConversationStore.setState({
        messages: {
          [firstScope.conversationId!]: [
            {
              id: "committed-user",
              role: "user",
              content: "已持久化的消息",
              imagePaths: ["new-message.webp"],
              timestamp,
            },
          ],
        },
      });
      latest.attachments.setText("保留下一轮输入");
      pending.reject({
        kind: "Agent",
        message: "任务启动被拒绝",
        stage: "start_task",
        conversationId: firstScope.conversationId,
      });
      await operation;
    });
    expect(draft().text).toBe("保留下一轮输入");
    expect(draft().attachments).toEqual([]);
    expect(draft().notice).toBeNull();
    expect(mocks.revoke).toHaveBeenCalledWith([
      expect.objectContaining({ previewUrl: "blob:preview-1" }),
    ]);
    expect(mocks.startTask).toHaveBeenCalledOnce();
    expect(
      useConversationStore.getState().messages[firstScope.conversationId!],
    ).toHaveLength(1);
    expect(latest.actions.sending).toBe(false);
  });

  it("撤回等待期间新增草稿内容，恢复历史附件时不会覆盖新增内容", async () => {
    await render();
    const target = seedHistory();
    await seedDraft(firstKey, "当前草稿", false);
    const pending =
      deferred<
        Awaited<
          ReturnType<typeof import("@/lib/tauri").agentTruncateConversation>
        >
      >();
    mocks.truncate.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.actions.rollback(target);
    });
    expect(mocks.truncate).toHaveBeenCalledWith(
      firstScope.conversationId,
      target.timestamp,
    );
    await act(async () => {
      latest.attachments.setText("后来编辑过的草稿");
      await latest.attachments.handleFileObjects([
        new File(["new"], "new.txt"),
      ]);
    });
    await act(async () => {
      pending.resolve({
        deletedMessages: 2,
        planAdjusted: false,
        plan: null,
        planTaskId: null,
      });
      await operation;
    });
    expect(draft().text).toBe("历史问题\n\n后来编辑过的草稿");
    expect(draft().attachments.map((item) => item.name)).toEqual([
      "original.conf",
      "config.txt",
      "new.txt",
      "图片 1",
    ]);
    expect(draft().attachments[0].content).toBe("original=true\n");
    expect(draft().attachments[3]).toMatchObject({
      status: "ready",
      persistedPath: previousImagePath,
    });
    expect(mocks.onRollback).toHaveBeenCalledWith(2);
    expect(
      useConversationStore
        .getState()
        .messages[firstScope.conversationId!].map((message) => message.id),
    ).toEqual(["earlier"]);
    expect(mocks.deleteImage).not.toHaveBeenCalled();
  });

  it("撤回等待期间切会话，历史和草稿只改变原 owner，不向新会话播通知", async () => {
    await render();
    const target = seedHistory();
    await seedDraft(firstKey, "第一台主机草稿", false);
    const pending =
      deferred<
        Awaited<
          ReturnType<typeof import("@/lib/tauri").agentTruncateConversation>
        >
      >();
    mocks.truncate.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.actions.rollback(target);
    });
    await render(secondScope);
    await seedDraft(secondKey, "第二台主机草稿", false);
    const otherDraft = draft(secondKey);
    const otherMessages =
      useConversationStore.getState().messages[secondScope.conversationId!];
    await act(async () => {
      pending.resolve({
        deletedMessages: 2,
        planAdjusted: false,
        plan: null,
        planTaskId: null,
      });
      await operation;
    });
    expect(draft().text).toBe("历史问题\n\n第一台主机草稿");
    expect(draft().attachments).toHaveLength(3);
    expect(draft(secondKey)).toBe(otherDraft);
    expect(
      useConversationStore.getState().messages[secondScope.conversationId!],
    ).toBe(otherMessages);
    expect(mocks.onRollback).not.toHaveBeenCalled();
    expect(mocks.readImage).toHaveBeenCalledWith(previousImagePath);
  });

  it("撤回 IPC 失败在原 owner 显示错误，当前草稿与历史保持原样", async () => {
    await render();
    const target = seedHistory();
    await seedDraft(firstKey, "原草稿", false);
    const pending =
      deferred<
        Awaited<
          ReturnType<typeof import("@/lib/tauri").agentTruncateConversation>
        >
      >();
    mocks.truncate.mockReturnValueOnce(pending.promise);
    const originalItems = draft().attachments;
    const originalMessages =
      useConversationStore.getState().messages[firstScope.conversationId!];
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.actions.rollback(target);
    });
    await render(secondScope);
    await seedDraft(secondKey, "当前会话草稿", false);
    await act(async () => {
      pending.reject({ kind: "Database", message: "数据库暂时忙碌" });
      await operation;
    });
    expect(draft().text).toBe("原草稿");
    expect(draft().attachments).toBe(originalItems);
    expect(draft().notice).toBe("撤回失败：数据库暂时忙碌");
    expect(
      useConversationStore.getState().messages[firstScope.conversationId!],
    ).toBe(originalMessages);
    expect(draft(secondKey).text).toBe("当前会话草稿");
    expect(draft(secondKey).notice).toBeNull();
    expect(mocks.onRollback).not.toHaveBeenCalled();
  });

  it("会话已显式删除并 discard 后，迟到的发送失败不能重新建立草稿提示", async () => {
    await render();
    await seedDraft();
    const pending = deferred<string>();
    mocks.startTask.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.actions.send();
    });
    await act(async () =>
      useConversationStore
        .getState()
        .deleteConversation(firstScope.conversationId!),
    );
    expect(useAgentDraftStore.getState().drafts[firstKey]).toBeUndefined();
    await render(secondScope);
    await seedDraft(secondKey, "当前会话保留", false);
    const currentDraft = draft(secondKey);
    await act(async () => {
      pending.reject({
        kind: "Agent",
        message: "原会话已删除",
        stage: "save_images",
        conversationId: firstScope.conversationId,
      });
      await operation;
    });
    expect(useAgentDraftStore.getState().drafts[firstKey]).toBeUndefined();
    expect(draft(secondKey)).toBe(currentDraft);
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "撤回等待时明确清空草稿，迟到结果失败=%s 时保留后来输入",
    async (failed) => {
      await render();
      const target = seedHistory();
      await seedDraft(firstKey, "清空前的草稿", false);
      const pending = deferred<TruncateConversationResult>();
      mocks.truncate.mockReturnValueOnce(pending.promise);
      let operation!: Promise<void>;
      await act(async () => {
        operation = latest.actions.rollback(target);
      });
      await act(async () => {
        latest.attachments.clear();
        latest.attachments.setText("清空后新写的内容");
      });
      const currentDraft = draft();
      await act(async () => {
        if (failed) {
          pending.reject({ kind: "Database", message: "数据库暂时忙碌" });
        } else {
          pending.resolve(adjustedRollbackResult);
        }
        await operation;
      });
      expect(draft()).toBe(currentDraft);
      expect(mocks.readImage).not.toHaveBeenCalled();
      expect(mocks.onRollback).not.toHaveBeenCalled();
      expect(
        useConversationStore.getState().messages[firstScope.conversationId!],
      ).toHaveLength(failed ? 3 : 1);
    },
  );

  it("撤回等待期间只清理断线缓存，仍可恢复草稿且不重建历史和计划缓存", async () => {
    await render();
    const target = seedHistory();
    await seedDraft(firstKey, "断线前的草稿", false);
    const pending = deferred<TruncateConversationResult>();
    mocks.truncate.mockReturnValueOnce(pending.promise);
    let operation!: Promise<void>;
    await act(async () => {
      operation = latest.actions.rollback(target);
    });
    await act(async () => {
      useConversationStore
        .getState()
        .clearConnectionConversations(firstScope.connectionId);
    });
    await render(secondScope);
    await act(async () => {
      pending.resolve(adjustedRollbackResult);
      await operation;
    });
    expect(draft().text).toBe("历史问题\n\n断线前的草稿");
    expect(draft().attachments.map((item) => item.name)).toEqual([
      "original.conf",
      "config.txt",
      "图片 1",
    ]);
    expect(
      useConversationStore.getState().messages[firstScope.conversationId!],
    ).toBeUndefined();
    expect(
      useTaskStore.getState().plans[adjustedRollbackResult.planTaskId!],
    ).toBeUndefined();
    expect(
      useTaskStore.getState().tasks[adjustedRollbackResult.planTaskId!],
    ).toBeUndefined();
    expect(mocks.onRollback).not.toHaveBeenCalled();
  });

  it.each([
    { action: "clear", failed: false },
    { action: "clear", failed: true },
    { action: "discard", failed: false },
    { action: "discard", failed: true },
  ] as const)(
    "撤回正在读图时 $action，迟到读取失败=$failed 不恢复内容或读取后续图片",
    async ({ action, failed }) => {
      await render();
      const target = seedHistory();
      target.imagePaths!.push("conversation-a/later-image.webp");
      const pending = deferred<string>();
      mocks.readImage.mockReturnValueOnce(pending.promise);
      let operation!: Promise<void>;
      await act(async () => {
        operation = latest.actions.rollback(target);
      });
      expect(mocks.readImage).toHaveBeenCalledOnce();
      expect(mocks.readImage).toHaveBeenCalledWith(previousImagePath);
      expect(draft().text).toBe("历史问题");
      await act(async () => {
        if (action === "discard") {
          await useConversationStore
            .getState()
            .deleteConversation(firstScope.conversationId!);
        } else {
          latest.attachments.clear();
          latest.attachments.setText("清空之后重新写");
        }
      });
      const currentDraft = useAgentDraftStore.getState().drafts[firstKey];
      await act(async () => {
        if (failed) {
          pending.reject({ kind: "Image", message: "图片读取失败" });
        } else {
          pending.resolve(imageDataUrl);
        }
        await operation;
      });
      expect(useAgentDraftStore.getState().drafts[firstKey]).toBe(currentDraft);
      expect(mocks.readImage).toHaveBeenCalledOnce();
      expect(mocks.readImage).toHaveBeenCalledWith(previousImagePath);
      expect(mocks.onRollback).not.toHaveBeenCalled();
      expect(mocks.deleteImage.mock.calls.map(([path]) => path)).toEqual([
        previousImagePath,
        "conversation-a/later-image.webp",
      ]);
    },
  );

  it.each([
    { name: "有草稿，撤回成功", hasDraft: true, failed: false },
    { name: "空草稿，撤回成功", hasDraft: false, failed: false },
    { name: "有草稿，撤回失败", hasDraft: true, failed: true },
    { name: "空草稿，撤回失败", hasDraft: false, failed: true },
  ])(
    "$name：显式删除后，迟到撤回不能重建草稿或读取图片",
    async ({ hasDraft, failed }) => {
      await render();
      const target = seedHistory();
      if (hasDraft) await seedDraft(firstKey, "待删除草稿", false);
      const pending =
        deferred<
          Awaited<
            ReturnType<typeof import("@/lib/tauri").agentTruncateConversation>
          >
        >();
      mocks.truncate.mockReturnValueOnce(pending.promise);
      let operation!: Promise<void>;
      await act(async () => {
        operation = latest.actions.rollback(target);
      });
      await act(async () =>
        useConversationStore
          .getState()
          .deleteConversation(firstScope.conversationId!),
      );
      expect(useAgentDraftStore.getState().drafts[firstKey]).toBeUndefined();
      await render(secondScope);
      await seedDraft(secondKey, "当前会话保留", false);
      const currentDraft = draft(secondKey);
      const currentMessages =
        useConversationStore.getState().messages[secondScope.conversationId!];
      await act(async () => {
        if (failed) {
          pending.reject({ kind: "Database", message: "原会话已删除" });
        } else {
          pending.resolve(adjustedRollbackResult);
        }
        await operation;
      });
      expect(useAgentDraftStore.getState().drafts[firstKey]).toBeUndefined();
      expect(
        useConversationStore.getState().messages[firstScope.conversationId!],
      ).toBeUndefined();
      expect(
        useConversationStore.getState().conversations[
          firstScope.conversationId!
        ],
      ).toBeUndefined();
      expect(mocks.readImage).not.toHaveBeenCalled();
      expect(mocks.onRollback).not.toHaveBeenCalled();
      expect(
        useTaskStore.getState().plans[adjustedRollbackResult.planTaskId!],
      ).toBeUndefined();
      expect(
        useTaskStore.getState().tasks[adjustedRollbackResult.planTaskId!],
      ).toBeUndefined();
      expect(draft(secondKey)).toBe(currentDraft);
      expect(
        useConversationStore.getState().messages[secondScope.conversationId!],
      ).toBe(currentMessages);
    },
  );
});
