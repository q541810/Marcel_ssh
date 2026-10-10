// @vitest-environment jsdom
import { act } from "react";
import { Simulate } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentPanel from "@/components/agent/AgentPanel";
import MobileAgentHost from "@/mobile/MobileAgentHost";
import { useTaskStore } from "@/stores/taskStore";
import {
  draftKeyFor,
  resetAgentDrafts,
  useAgentDraftStore,
} from "@/stores/agentDraftStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useSessionStore } from "@/stores/sessionStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useJobStore } from "@/stores/jobStore";
import { useDebugStore } from "@/stores/debugStore";
import { cleanupTaskListeners } from "@/stores/agentStreamManager";
import { resetBackHandlers } from "@/mobile/backHandler";
import { createModel } from "@/lib/llmRegistry";
import type {
  AgentMessage,
  SavedConnection,
  UserInputMetadata,
} from "@/lib/types";

const native = vi.hoisted(() => ({
  open: vi.fn(),
  fileName: vi.fn(),
  readFile: vi.fn(),
  readImage: vi.fn(),
  resolveImage: vi.fn(),
  deleteImage: vi.fn(),
  saveImages: vi.fn(),
  startTask: vi.fn(),
  truncate: vi.fn(),
  getConnections: vi.fn(),
  listen: vi.fn(),
}));

// Keep the real hosts, transcript, hooks, stores and attachment codecs. Only
// native I/O, browser graphics and unrelated panels are substituted below.
vi.mock("@/lib/tauri", () => ({
  agentGetLocalFileName: native.fileName,
  agentReadLocalFile: native.readFile,
  agentReadMessageImage: native.readImage,
  agentResolveImagePath: native.resolveImage,
  agentDeleteMessageImage: native.deleteImage,
  agentSaveMessageImages: native.saveImages,
  agentStartTask: native.startTask,
  agentTruncateConversation: native.truncate,
  getConnections: native.getConnections,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.open }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/components/terminal/TerminalInstanceManager", () => ({
  terminalInstanceManager: {
    prepareReconnect: vi.fn(),
    onReconnected: vi.fn(),
    showDisconnectBanner: vi.fn(),
    setStdinEnabled: vi.fn(),
  },
}));
vi.mock("@/components/settings/ChatHistoryModal", () => ({
  default: () => null,
}));
vi.mock("@/components/agent/AgentTasksDrawer", () => ({
  AgentTasksDrawer: () => null,
}));
vi.mock("@/components/agent/MultiHostPicker", () => ({ default: () => null }));
vi.mock("@/components/agent/AgentCommandMenu", async () => {
  const { forwardRef } = await import("react");
  return { default: forwardRef(() => null) };
});
vi.mock("@/components/agent/ReasoningEffortPicker", () => ({
  ReasoningEffortPicker: () => null,
}));
vi.mock("@/mobile/MobileActiveAgentsSheet", () => ({ default: () => null }));
vi.mock("@/mobile/MobileApprovalSheet", () => ({ default: () => null }));
vi.mock("@/mobile/MobileQuestionSheet", () => ({ default: () => null }));
vi.mock("@/mobile/MobileChatHistorySheet", () => ({ default: () => null }));
vi.mock("@/mobile/MobileMultiHostPicker", () => ({ default: () => null }));

const CONVERSATION = "attachment-conversation";
const SESSION = "attachment-session";
const CONNECTION = "attachment-connection";
const DRAFT = draftKeyFor(CONVERSATION, SESSION);
const TIME = "2026-10-09T00:00:00.000Z";
const QUESTION = "帮我检查这份配置";
const FILE_BODY = "port=22\nworker.limit=8\n" + "trace-line\n".repeat(300);
const SAVED_IMAGE = `${CONVERSATION}/previous/screen.webp`;
const IMAGE_DATA = "data:image/webp;base64,c2NyZWVu";
const connection: SavedConnection = {
  id: CONNECTION,
  name: "测试服务器",
  host: "example.test",
  port: 22,
  username: "test",
  authMethod: "Password",
};

type FileReply = { name: string; base64: string; size: number };
type HostComponent = typeof AgentPanel | typeof MobileAgentHost;
let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let fileReplies: Map<string, FileReply>;
let createUrlDescriptor: PropertyDescriptor | undefined;
let revokeUrlDescriptor: PropertyDescriptor | undefined;

function encodedFile(name: string, text: string): FileReply {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    base64: btoa(
      Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
    ),
    size: bytes.length,
  };
}

function filePath(platform: string, name: string): string {
  // The mobile URI deliberately has no extension: the native display name,
  // not a content:// document identifier, must drive attachment classification.
  return platform === "mobile"
    ? `content://test.documents/document/${name === "config.log" ? "101" : "102"}`
    : `D:/fixtures/${name}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function draft() {
  return useAgentDraftStore.getState().getDraft(DRAFT);
}

function button(label: string, scope: ParentNode = host): HTMLButtonElement {
  const result = scope.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!result) throw new Error(`Missing action: ${label}`);
  return result;
}

function textarea(): HTMLTextAreaElement {
  const result = host.querySelector("textarea");
  if (!result) throw new Error("Composer not mounted");
  return result;
}

async function click(label: string, scope?: ParentNode) {
  await act(async () => button(label, scope).click());
}

async function typeQuestion(value: string) {
  await act(async () => {
    const input = textarea();
    input.value = value;
    Simulate.change(input);
  });
}

async function chooseFiles(paths: string[]) {
  native.open.mockResolvedValueOnce(paths);
  await click("添加图片或文本文件");
}

async function waitForReady(count: number) {
  await act(async () => {
    await vi.waitFor(
      () => {
        expect(draft().attachments).toHaveLength(count);
        expect(draft().attachments.map((item) => item.status)).toEqual(
          Array(count).fill("ready"),
        );
      },
      { interval: 5, timeout: 2000 },
    );
  });
}

async function closePreview(platform: string) {
  const dialog = document.querySelector('[role="dialog"]')!;
  await click("关闭附件预览", document);
  await act(async () => {
    const animated =
      platform === "mobile"
        ? document.querySelector('[data-region="agent-attachment-preview"]')!
        : dialog;
    if (platform === "mobile") {
      // jsdom has no AnimationEvent feature detection; dispatch React's
      // animation event directly for the full-screen shell's onAnimationEnd.
      Simulate.animationEnd(animated);
    } else {
      animated.dispatchEvent(new Event("animationend", { bubbles: true }));
    }
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
}

function setVision(enabled: boolean) {
  const settings = useSettingsStore.getState().settings;
  useSettingsStore.setState({
    settings: {
      ...settings,
      llmRegistry: {
        ...settings.llmRegistry,
        models: [
          {
            ...createModel("test-channel", "test-model"),
            id: "test-model",
            vision: enabled,
          },
        ],
      },
    },
  });
}

async function mount(Host: HostComponent) {
  await act(async () => root.render(<Host />));
  expect(textarea().disabled).toBe(false);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });

  // jsdom does not decode images or provide a canvas. Keep compressImageFile
  // real and substitute only those browser facilities.
  vi.stubGlobal(
    "Image",
    class {
      width = 64;
      height = 48;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => callback(new Blob(["encoded-image"], { type: "image/webp" })),
  );
  createUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  revokeUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  let nextUrl = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => `blob:attachment-${++nextUrl}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });

  resetAgentDrafts();
  resetBackHandlers();
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useConversationStore.setState(useConversationStore.getInitialState(), true);
  useSessionStore.setState(useSessionStore.getInitialState(), true);
  useConnectionStore.setState(useConnectionStore.getInitialState(), true);
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useJobStore.setState(useJobStore.getInitialState(), true);
  useDebugStore.setState({ debug67Mode: false });
  useSessionStore.setState({
    activeSessionId: SESSION,
    sessions: {
      [SESSION]: {
        id: SESSION,
        configId: CONNECTION,
        connectionId: "test@example.test:22",
        status: "connected",
        createdAt: TIME,
      },
    },
  });
  useConnectionStore.setState({
    connections: [connection],
    activeConnectionId: CONNECTION,
  });
  useConversationStore.setState({
    activeConversationId: CONVERSATION,
    activeConversationBySession: { [SESSION]: CONVERSATION },
    activeConversationByConnection: { [CONNECTION]: CONVERSATION },
    conversations: {
      [CONVERSATION]: {
        id: CONVERSATION,
        title: "附件测试",
        connectionId: CONNECTION,
        createdAt: TIME,
        updatedAt: TIME,
      },
    },
    messages: {
      [CONVERSATION]: [
        {
          id: "history",
          role: "assistant",
          content: "可以开始提问。",
          timestamp: TIME,
        },
      ],
    },
  });
  setVision(true);

  fileReplies = new Map();
  for (const platform of ["desktop", "mobile"]) {
    fileReplies.set(
      filePath(platform, "config.log"),
      encodedFile("config.log", FILE_BODY),
    );
    fileReplies.set(
      filePath(platform, "screen.png"),
      encodedFile("screen.png", "image-source"),
    );
  }
  native.fileName.mockImplementation(
    async (path: string) =>
      fileReplies.get(path)?.name ?? path.split("/").pop(),
  );
  native.readFile.mockImplementation(async (path: string) => {
    const reply = fileReplies.get(path);
    if (!reply) throw new Error(`Missing native file fixture: ${path}`);
    return reply;
  });
  native.readImage.mockResolvedValue(IMAGE_DATA);
  native.resolveImage.mockImplementation(
    async (path: string) => `D:/app/images/${path}`,
  );
  native.deleteImage.mockResolvedValue(undefined);
  native.saveImages.mockResolvedValue([`${CONVERSATION}/sent/image.webp`]);
  native.startTask.mockResolvedValue("started");
  native.truncate.mockResolvedValue({
    deletedMessages: 2,
    planAdjusted: false,
    plan: null,
    planTaskId: null,
  });
  native.getConnections.mockResolvedValue([connection]);
  native.listen.mockImplementation(async () => vi.fn());
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const taskId of Object.keys(useTaskStore.getState().tasks))
    cleanupTaskListeners(taskId);
  resetAgentDrafts();
  resetBackHandlers();
  host.remove();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  if (createUrlDescriptor)
    Object.defineProperty(URL, "createObjectURL", createUrlDescriptor);
  else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  if (revokeUrlDescriptor)
    Object.defineProperty(URL, "revokeObjectURL", revokeUrlDescriptor);
  else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  ["desktop", AgentPanel],
  ["mobile", MobileAgentHost],
] as const)("%s 附件完整用户流程", (platform, Host) => {
  it("导入文本不盖住原提问，可从紧凑卡片预览和移除", async () => {
    await mount(Host);
    await typeQuestion(QUESTION);
    await chooseFiles([filePath(platform, "config.log")]);
    await waitForReady(1);
    expect(textarea().value).toBe(QUESTION);
    expect(host.textContent).not.toContain("worker.limit=8");
    expect(button("发送").disabled).toBe(false);
    await click("预览 config.log");
    expect(document.querySelector("pre")?.textContent).toBe(FILE_BODY);
    expect(textarea().value).toBe(QUESTION);
    await closePreview(platform);
    await click("移除 config.log");
    expect(draft().attachments).toHaveLength(0);
    expect(textarea().value).toBe(QUESTION);
    expect(host.querySelector('[aria-label="预览 config.log"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("只有文本附件也能发送，读取未完成时禁发；完整正文交给后端，消息仍显示附件卡", async () => {
    const reading = deferred<FileReply>();
    native.readFile.mockImplementationOnce(() => reading.promise);
    await mount(Host);
    expect(button("发送").disabled).toBe(true);
    await chooseFiles([filePath(platform, "config.log")]);
    expect(draft().attachments[0]?.status).toBe("loading");
    expect(button("发送").disabled).toBe(true);
    await click("发送");
    expect(native.startTask).not.toHaveBeenCalled();
    await act(async () =>
      reading.resolve(encodedFile("config.log", FILE_BODY)),
    );
    await waitForReady(1);
    expect(textarea().value).toBe("");
    expect(button("发送").disabled).toBe(false);
    await click("发送");
    expect(native.startTask).toHaveBeenCalledOnce();
    const request = native.startTask.mock.calls[0];
    expect(request[1]).toContain("===== 文件名: config.log =====");
    expect(request[1]).toContain(FILE_BODY);
    expect(request[8]).toMatchObject({
      version: 1,
      text: "",
      textAttachments: [{ name: "config.log", content: FILE_BODY }],
    });
    expect(draft().attachments).toHaveLength(0);
    const sent = useConversationStore
      .getState()
      .messages[CONVERSATION].find((message) => message.role === "user")!;
    const bubble = host.querySelector(`[data-message-id="${sent.id}"]`)!;
    expect(bubble.textContent).toContain("config.log");
    expect(bubble.textContent).not.toContain("worker.limit=8");
    expect(bubble.querySelector('[aria-label="移除 config.log"]')).toBeNull();
    await click("预览 config.log", bubble);
    expect(document.querySelector("pre")?.textContent).toBe(FILE_BODY);
    await closePreview(platform);
  });

  it("模型没有视觉能力时图片保留在草稿并阻止发送，换模型后同一附件可用", async () => {
    setVision(false);
    await mount(Host);
    await typeQuestion("看看这张截图");
    await chooseFiles([filePath(platform, "screen.png")]);
    await waitForReady(1);
    const imageId = draft().attachments[0].id;
    expect(draft().attachments[0].kind).toBe("image");
    expect(button("预览 screen.png").disabled).toBe(false);
    expect(host.textContent).toContain("不支持图片");
    expect(button("发送").disabled).toBe(true);
    await click("发送");
    expect(native.startTask).not.toHaveBeenCalled();
    expect(native.deleteImage).not.toHaveBeenCalled();
    await act(async () => setVision(true));
    expect(button("发送").disabled).toBe(false);
    expect(draft().attachments[0].id).toBe(imageId);
    expect(textarea().value).toBe("看看这张截图");
  });

  it("撤回含文件与图片的历史消息，恢复原提问与两个可操作附件", async () => {
    const input: UserInputMetadata = {
      version: 1,
      text: QUESTION,
      textAttachments: [
        {
          id: "stored-file",
          name: "config.log",
          content: FILE_BODY,
          size: new TextEncoder().encode(FILE_BODY).length,
        },
      ],
    };
    const message: AgentMessage = {
      id: "rollback-user",
      role: "user",
      timestamp: TIME,
      content: `${QUESTION}\n\n===== 文件名: config.log =====\n${FILE_BODY}`,
      userInput: input,
      imagePaths: [SAVED_IMAGE],
    };
    useConversationStore.setState({
      messages: {
        [CONVERSATION]: [
          message,
          {
            id: "answer",
            role: "assistant",
            content: "检查结果",
            timestamp: TIME,
          },
        ],
      },
    });
    await mount(Host);
    const bubble = host.querySelector('[data-message-id="rollback-user"]')!;
    expect(bubble.textContent).toContain(QUESTION);
    expect(bubble.textContent).not.toContain("worker.limit=8");
    const rollback = bubble.querySelector<HTMLButtonElement>(
      'button[title="撤回到这条消息"]',
    )!;
    expect(rollback.disabled).toBe(false);
    await act(async () => rollback.click());
    await waitForReady(2);
    expect(native.truncate).toHaveBeenCalledWith(CONVERSATION, TIME);
    expect(native.readImage).toHaveBeenCalledWith(SAVED_IMAGE);
    expect(textarea().value).toBe(QUESTION);
    const restoredText = draft().attachments.find(
      (item) => item.kind === "text",
    )!;
    const restoredImage = draft().attachments.find(
      (item) => item.kind === "image",
    )!;
    expect(restoredText).toMatchObject({
      name: "config.log",
      content: FILE_BODY,
      status: "ready",
    });
    expect(restoredImage).toMatchObject({
      persistedPath: SAVED_IMAGE,
      dataUrl: IMAGE_DATA,
      status: "ready",
    });
    expect(button("移除 config.log").disabled).toBe(false);
    expect(button(`预览 ${restoredImage.name}`).disabled).toBe(false);
    expect(button("发送").disabled).toBe(false);
    expect(host.querySelector('[data-message-id="rollback-user"]')).toBeNull();
    await click("预览 config.log");
    expect(document.querySelector("pre")?.textContent).toBe(FILE_BODY);
    await closePreview(platform);
  });

  it("无法识别的附件元数据保持历史原文，撤回也不会猜结构而删正文", async () => {
    const original =
      "旧记录正文\n\n===== 文件名: original.txt =====\n保留全部历史文件内容";
    useConversationStore.setState({
      messages: {
        [CONVERSATION]: [
          {
            id: "legacy-user",
            role: "user",
            content: original,
            timestamp: TIME,
            userInput: {
              version: 99,
              text: "不能据此隐藏原文",
              textAttachments: [],
            } as unknown as UserInputMetadata,
          },
        ],
      },
    });
    await mount(Host);
    const bubble = host.querySelector('[data-message-id="legacy-user"]')!;
    expect(bubble.textContent).toContain(original);
    expect(bubble.querySelector('[aria-label="附件"]')).toBeNull();
    const rollback = bubble.querySelector<HTMLButtonElement>(
      'button[title="撤回到这条消息"]',
    )!;
    await act(async () => rollback.click());
    expect(textarea().value).toBe(original);
    expect(draft().attachments).toHaveLength(0);
  });
});
