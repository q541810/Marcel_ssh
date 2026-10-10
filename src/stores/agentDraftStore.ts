import { create } from "zustand";
import type { AgentConversation, UserInputMetadata, UserTextAttachment } from "@/lib/types";
import { getErrorMessage } from "@/lib/errors";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_READ_BYTES,
  MAX_TEXT_FILE_BYTES,
  attachmentTooLargeMessage,
  base64ToBlob,
  blobToText,
  classifyAttachment,
  readLocalAttachment,
  resolveAttachmentName,
} from "@/lib/attachmentAttach";
import {
  MAX_ATTACH_IMAGES,
  compressImageFile,
  deletePersistedImagePaths,
  revokePendingImages,
  type PendingImage,
} from "@/lib/imageAttach";
import { agentDeleteMessageImage, agentReadMessageImage } from "@/lib/tauri";

export interface AttachmentItem {
  id: string;
  name: string;
  kind: "image" | "text";
  status: "loading" | "ready" | "error";
  size?: number;
  error?: string;
  content?: string;
  previewUrl?: string;
  dataUrl?: string;
  persistedPath?: string;
}

export interface AgentDraft {
  text: string;
  attachments: AttachmentItem[];
  notice: string | null;
}

/** 空桶必须引用稳定，否则 Zustand 的快照会不断变化。 */
export const EMPTY_DRAFT: AgentDraft = Object.freeze({
  text: "",
  attachments: Object.freeze([]) as unknown as AttachmentItem[],
  notice: null,
});

export function draftKeyFor(
  conversationId: string | null,
  sessionId: string | null,
): string {
  if (conversationId) return `conv:${conversationId}`;
  if (sessionId) return `session:${sessionId}`;
  return "unbound";
}

/** 双端输入区和异步反馈共用归属判断；同步空窗不能写进其他标签的草稿。 */
export function draftConversationIdFor({
  activeConversationId,
  conversations,
  activeConversationBySession,
  activeSessionId,
  activeConfigId,
}: {
  activeConversationId: string | null;
  conversations: Record<string, AgentConversation>;
  activeConversationBySession: Record<string, string>;
  activeSessionId: string | null;
  activeConfigId?: string;
}): string | null {
  if (!activeConversationId || !activeSessionId) return activeConversationId;
  // 同一台机器也可开多个标签；子对话沿用所属主对话的绑定。
  const rootConversationId = (id: string) => conversations[id]?.parentConversationId ?? id;
  const boundId = activeConversationBySession[activeSessionId];
  const activeRootId = rootConversationId(activeConversationId);
  const bindingMatches = boundId
    ? rootConversationId(boundId) === activeRootId
    : !Object.entries(activeConversationBySession).some(
      ([sessionId, id]) => sessionId !== activeSessionId && rootConversationId(id) === activeRootId,
    );
  return conversations[activeConversationId]?.connectionId === activeConfigId && bindingMatches
    ? activeConversationId
    : null;
}

export interface DraftSendSnapshot {
  id: string;
  draftKey: string;
  text: string;
  items: AttachmentItem[];
  images: PendingImage[];
  textAttachments: UserTextAttachment[];
  userInput: UserInputMetadata;
}

export interface DraftSendOutcome {
  status: "committed" | "rejected";
  /** 首次发送建立会话后，可显式把恢复目标绑定到该会话。 */
  draftKey?: string;
  /** 未提交时随有效快照一起恢复的反馈；已删除的快照不能留下提示。 */
  notice?: string;
}

export interface RestoreDraftMessage {
  text: string;
  textAttachments?: UserTextAttachment[];
  imagePaths?: string[];
}

type AttachmentSource =
  | { kind: "file"; file: File }
  | { kind: "path"; path: string }
  | { kind: "saved-image"; path: string; name: string };

interface AttachmentResource {
  id: string;
  draftKey: string;
  owner: "draft" | string;
  generation: number;
  source?: AttachmentSource;
  previewUrl?: string;
  persistedPath?: string;
}

interface AgentDraftState {
  drafts: Record<string, AgentDraft>;
  /** 与发送快照同寿命；切 UI 不会结束正在发送的快照。 */
  sending: Record<string, number>;
  getDraft: (key: string) => AgentDraft;
  setText: (key: string, text: string | ((previous: string) => string)) => void;
  setNotice: (key: string, notice: string | null) => void;
  importFiles: (key: string, files: File[]) => Promise<void>;
  importPaths: (key: string, paths: string[]) => Promise<void>;
  remove: (key: string, id: string) => void;
  retry: (key: string, id: string) => Promise<void>;
  clear: (key: string) => void;
  discard: (key: string) => void;
  migrateDraft: (fromKey: string, toKey: string) => void;
  takeSendSnapshot: (
    key: string,
    visionEnabled?: boolean,
  ) => DraftSendSnapshot | null;
  finishSend: (snapshot: DraftSendSnapshot, outcome: DraftSendOutcome) => void;
  restoreMessage: (key: string, message: RestoreDraftMessage) => Promise<void>;
}

// File、读取代次和 URL 所有权属于运行时 manager，不落配置或聊天数据库。
const resources = new Map<string, AttachmentResource>();
const snapshots = new Map<string, DraftSendSnapshot>();
/** 选择器或撤回尚未返回时没有附件资源，但仍须随草稿迁移、清空和删除。 */
const pendingImports = new Map<string, string>();

/** 登记等待外部结果的草稿导入；选择文件和撤回共用，须在 finally 中释放。 */
export function beginDraftImport(key: string): string {
  const id = crypto.randomUUID();
  pendingImports.set(id, key);
  return id;
}

/** 返回当前归属；首次建会话会迁移，主动清空/删除后返回 null。 */
export function draftImportTarget(id: string): string | null {
  return pendingImports.get(id) ?? null;
}

export function endDraftImport(id: string): void {
  pendingImports.delete(id);
}

function updateDraft(
  key: string,
  update: (draft: AgentDraft) => AgentDraft,
): void {
  useAgentDraftStore.setState((state) => ({
    drafts: {
      ...state.drafts,
      [key]: update(state.drafts[key] ?? EMPTY_DRAFT),
    },
  }));
}

function releaseResource(resource: AttachmentResource): void {
  resource.generation++;
  resources.delete(resource.id);
  if (resource.previewUrl) {
    revokePendingImages([
      { id: resource.id, previewUrl: resource.previewUrl, dataUrl: "" },
    ]);
    resource.previewUrl = undefined;
  }
  if (resource.persistedPath) {
    void deletePersistedImagePaths(
      [resource.persistedPath],
      agentDeleteMessageImage,
    );
    resource.persistedPath = undefined;
  }
}

function isCurrent(resource: AttachmentResource, generation: number): boolean {
  return (
    resources.get(resource.id) === resource &&
    resource.owner === "draft" &&
    resource.generation === generation &&
    useAgentDraftStore
      .getState()
      .getDraft(resource.draftKey)
      .attachments.some(
        (item) => item.id === resource.id && item.status === "loading",
      )
  );
}

function patchCurrent(
  resource: AttachmentResource,
  generation: number,
  patch: Partial<AttachmentItem>,
): boolean {
  if (!isCurrent(resource, generation)) return false;
  updateDraft(resource.draftKey, (draft) => ({
    ...draft,
    attachments: draft.attachments.map((item) =>
      item.id === resource.id ? { ...item, ...patch } : item,
    ),
  }));
  return true;
}

function checkImageCapacity(resource: AttachmentResource): void {
  const count = useAgentDraftStore
    .getState()
    .getDraft(resource.draftKey)
    .attachments.filter(
      (item) =>
        item.id !== resource.id &&
        item.kind === "image" &&
        item.status !== "error",
    ).length;
  if (count >= MAX_ATTACH_IMAGES)
    throw new Error(
      `最多添加 ${MAX_ATTACH_IMAGES} 张图片，请移除多余图片后重试`,
    );
}

/** 每次异步落点检查资源身份和代次；清理/重试不会被迟到结果复活。 */
async function readResource(resource: AttachmentResource): Promise<void> {
  const generation = ++resource.generation;
  const source = resource.source;
  if (!source) return;
  try {
    if (source.kind === "saved-image") {
      checkImageCapacity(resource);
      const dataUrl = await agentReadMessageImage(source.path);
      if (!isCurrent(resource, generation)) return;
      if (
        patchCurrent(resource, generation, {
          status: "ready",
          dataUrl,
          previewUrl: dataUrl,
          error: undefined,
        })
      )
        resource.source = undefined;
      return;
    }

    const name =
      source.kind === "file"
        ? source.file.name
        : await resolveAttachmentName(source.path);
    if (!isCurrent(resource, generation)) return;
    let kind = classifyAttachment(
      name,
      source.kind === "file" ? source.file.type : undefined,
    );
    patchCurrent(resource, generation, {
      name,
      kind: kind === "image" ? "image" : "text",
    });
    if (kind === "unsupported")
      throw new Error("不支持此文件类型，请选择图片或文本文件");
    if (kind === "image") checkImageCapacity(resource);

    let blob: Blob;
    let displayName = name;
    if (source.kind === "file") {
      blob = source.file;
    } else {
      const result = await readLocalAttachment(source.path);
      if (!isCurrent(resource, generation)) return;
      displayName = result.name || name;
      if (result.size > MAX_ATTACHMENT_READ_BYTES) {
        throw new Error(
          attachmentTooLargeMessage(displayName, MAX_ATTACHMENT_READ_BYTES),
        );
      }
      // 名称解析和实际读取可能由不同的 SAF 查询返回；以成功读取的名称为准。
      kind = classifyAttachment(displayName);
      patchCurrent(resource, generation, {
        name: displayName,
        kind: kind === "image" ? "image" : "text",
      });
      if (kind === "unsupported")
        throw new Error("不支持此文件类型，请选择图片或文本文件");
      if (kind === "image") checkImageCapacity(resource);
      blob = base64ToBlob(result.base64);
    }
    if (blob.size > MAX_ATTACHMENT_READ_BYTES) {
      throw new Error(
        attachmentTooLargeMessage(displayName, MAX_ATTACHMENT_READ_BYTES),
      );
    }
    patchCurrent(resource, generation, { size: blob.size });
    if (kind === "image") {
      const image = await compressImageFile(blob);
      if (!isCurrent(resource, generation)) {
        revokePendingImages([{ id: resource.id, ...image }]);
        return;
      }
      resource.previewUrl = image.previewUrl;
      if (
        patchCurrent(resource, generation, {
          ...image,
          status: "ready",
          error: undefined,
        })
      )
        resource.source = undefined;
    } else {
      if (blob.size > MAX_TEXT_FILE_BYTES) {
        throw new Error(
          attachmentTooLargeMessage(displayName, MAX_TEXT_FILE_BYTES),
        );
      }
      const content = await blobToText(blob);
      if (
        patchCurrent(resource, generation, {
          content,
          status: "ready",
          error: undefined,
        })
      )
        resource.source = undefined;
    }
  } catch (error) {
    patchCurrent(resource, generation, {
      status: "error",
      error: getErrorMessage(error),
    });
  }
}

function sourceName(source: AttachmentSource): string {
  if (source.kind === "saved-image") return source.name;
  return source.kind === "file"
    ? source.file.name
    : source.path.split(/[/\\]/).pop() || "所选文件";
}

/** 同步创建占位再开始任何读取。后续批次能立即看到本批次占用的容量。 */
async function importSources(
  key: string,
  sources: AttachmentSource[],
  restoring = false,
): Promise<void> {
  if (sources.length === 0) return;
  const draft = useAgentDraftStore.getState().getDraft(key);
  // 恢复已存在的消息不能因为新草稿占了容量就丢掉原附件；超限由发送门控说明。
  const room = restoring
    ? sources.length
    : Math.max(0, MAX_ATTACHMENTS - draft.attachments.length);
  const accepted = sources.slice(0, room);
  let imageCount = draft.attachments.filter(
    (item) => item.kind === "image" && item.status !== "error",
  ).length;
  const items: AttachmentItem[] = [];
  const pending: AttachmentResource[] = [];
  for (const source of accepted) {
    const id = crypto.randomUUID();
    const name = sourceName(source);
    const kind =
      source.kind === "saved-image"
        ? "image"
        : classifyAttachment(
            name,
            source.kind === "file" ? source.file.type : undefined,
          );
    const full = kind === "image" && imageCount >= MAX_ATTACH_IMAGES;
    const error = full
      ? `最多添加 ${MAX_ATTACH_IMAGES} 张图片，请移除多余图片后重试`
      : undefined;
    const resource: AttachmentResource = {
      id,
      draftKey: key,
      owner: "draft",
      generation: 0,
      source,
      persistedPath: source.kind === "saved-image" ? source.path : undefined,
    };
    resources.set(id, resource);
    items.push({
      id,
      name,
      kind: kind === "image" ? "image" : "text",
      status: error ? "error" : "loading",
      error,
      size: source.kind === "file" ? source.file.size : undefined,
      persistedPath: resource.persistedPath,
    });
    if (!error) {
      pending.push(resource);
      if (kind === "image") imageCount++;
    }
  }
  updateDraft(key, (current) => ({
    ...current,
    attachments: [...current.attachments, ...items],
    notice:
      sources.length > room
        ? `最多添加 ${MAX_ATTACHMENTS} 个附件，已忽略 ${sources.length - room} 个`
        : null,
  }));
  // 顺序读取限制解码的瞬时内存；占位顺序不受其它批次完成先后影响。
  for (const resource of pending) {
    if (resources.get(resource.id) === resource && resource.owner === "draft")
      await readResource(resource);
  }
}

export function draftSendBlockedReason(
  draft: AgentDraft,
  visionEnabled: boolean,
): string | null {
  if (draft.attachments.some((item) => item.status === "loading"))
    return "附件正在读取，请稍候或移除读取中的附件";
  if (draft.attachments.some((item) => item.status === "error"))
    return "有附件读取失败，请重试或移除后发送";
  if (draft.attachments.length > MAX_ATTACHMENTS)
    return `最多发送 ${MAX_ATTACHMENTS} 个附件，请移除多余附件`;
  const images = draft.attachments.filter((item) => item.kind === "image");
  if (images.length > MAX_ATTACH_IMAGES)
    return `最多发送 ${MAX_ATTACH_IMAGES} 张图片，请移除多余图片`;
  if (images.length > 0 && !visionEnabled)
    return "当前模型不支持图片，请切换支持图片的模型或移除图片";
  if (
    draft.attachments.some((item) =>
      item.kind === "image" ? !item.dataUrl : item.content === undefined,
    )
  ) {
    return "附件内容尚未就绪，请重新添加";
  }
  return null;
}

function mergeText(previous: string, later: string): string {
  if (!previous || previous === later) return later;
  if (!later) return previous;
  return `${previous}\n\n${later}`;
}

export const useAgentDraftStore = create<AgentDraftState>((set, get) => ({
  drafts: {},
  sending: {},
  getDraft: (key) => get().drafts[key] ?? EMPTY_DRAFT,
  setText: (key, text) => {
    const draft = get().getDraft(key);
    const next = typeof text === "function" ? text(draft.text) : text;
    if (next === draft.text) return;
    updateDraft(key, (current) => ({ ...current, text: next }));
  },
  setNotice: (key, notice) =>
    updateDraft(key, (draft) => ({ ...draft, notice })),
  importFiles: (key, files) =>
    importSources(
      key,
      files.map((file) => ({ kind: "file", file })),
    ),
  importPaths: (key, paths) =>
    importSources(
      key,
      paths.map((path) => ({ kind: "path", path })),
    ),
  remove: (key, id) => {
    const resource = resources.get(id);
    if (!resource || resource.draftKey !== key || resource.owner !== "draft")
      return;
    releaseResource(resource);
    updateDraft(key, (draft) => ({
      ...draft,
      notice: null,
      attachments: draft.attachments.filter((item) => item.id !== id),
    }));
  },
  retry: async (key, id) => {
    const resource = resources.get(id);
    const item = get()
      .getDraft(key)
      .attachments.find((entry) => entry.id === id);
    if (
      !resource ||
      resource.draftKey !== key ||
      resource.owner !== "draft" ||
      item?.status !== "error"
    )
      return;
    if (!resource.source) {
      get().setNotice(key, "此附件无法重新读取，请移除后重新添加");
      return;
    }
    updateDraft(key, (draft) => ({
      ...draft,
      notice: null,
      attachments: draft.attachments.map((entry) =>
        entry.id === id
          ? { ...entry, status: "loading", error: undefined }
          : entry,
      ),
    }));
    await readResource(resource);
  },
  clear: (key) => {
    for (const [id, targetKey] of pendingImports) {
      if (targetKey === key) pendingImports.delete(id);
    }
    for (const item of get().getDraft(key).attachments) {
      const resource = resources.get(item.id);
      if (resource?.owner === "draft" && resource.draftKey === key)
        releaseResource(resource);
    }
    updateDraft(key, () => EMPTY_DRAFT);
  },
  discard: (key) => {
    get().clear(key);
    for (const [id, snapshot] of snapshots) {
      if (snapshot.draftKey !== key) continue;
      for (const item of snapshot.items) {
        const resource = resources.get(item.id);
        if (resource?.owner === id) releaseResource(resource);
      }
      snapshots.delete(id);
    }
    set((state) => {
      const drafts = { ...state.drafts };
      const sending = { ...state.sending };
      delete drafts[key];
      delete sending[key];
      return { drafts, sending };
    });
  },
  migrateDraft: (fromKey, toKey) => {
    const hasPendingImport = [...pendingImports.values()].some(
      (key) => key === fromKey,
    );
    if (
      fromKey === toKey ||
      (!get().drafts[fromKey] && !get().sending[fromKey] && !hasPendingImport)
    )
      return;
    for (const [id, targetKey] of pendingImports) {
      if (targetKey === fromKey) pendingImports.set(id, toKey);
    }
    for (const resource of resources.values()) {
      if (resource.draftKey === fromKey) resource.draftKey = toKey;
    }
    for (const snapshot of snapshots.values()) {
      if (snapshot.draftKey === fromKey) snapshot.draftKey = toKey;
    }
    set((state) => {
      const previous = state.drafts[fromKey] ?? EMPTY_DRAFT;
      const target = state.drafts[toKey] ?? EMPTY_DRAFT;
      const drafts = {
        ...state.drafts,
        [toKey]: {
          text: mergeText(previous.text, target.text),
          attachments: [...previous.attachments, ...target.attachments],
          notice: target.notice ?? previous.notice,
        },
      };
      const sending = { ...state.sending };
      if (sending[fromKey])
        sending[toKey] = (sending[toKey] ?? 0) + sending[fromKey];
      delete drafts[fromKey];
      delete sending[fromKey];
      return { drafts, sending };
    });
  },
  takeSendSnapshot: (key, visionEnabled = true) => {
    const draft = get().getDraft(key);
    const reason = get().sending[key]
      ? "正在发送，请稍候"
      : draftSendBlockedReason(draft, visionEnabled);
    // 阻止发送的原因由 UI 随状态派生，不能存成过期后仍留在草稿的提示。
    if (reason) return null;
    if (!draft.text.trim() && draft.attachments.length === 0) return null;
    const items = draft.attachments.map((item) => ({ ...item }));
    const textAttachments: UserTextAttachment[] = items
      .filter((item) => item.kind === "text")
      .map((item) => ({
        id: item.id,
        name: item.name,
        content: item.content!,
        size: item.size,
      }));
    const snapshot: DraftSendSnapshot = {
      id: crypto.randomUUID(),
      draftKey: key,
      text: draft.text,
      items,
      images: items
        .filter((item) => item.kind === "image")
        .map((item) => ({
          id: item.id,
          previewUrl: item.previewUrl ?? item.dataUrl!,
          dataUrl: item.dataUrl!,
          persistedPath: item.persistedPath,
        })),
      textAttachments,
      userInput: { version: 1, text: draft.text, textAttachments },
    };
    snapshots.set(snapshot.id, snapshot);
    for (const item of items) {
      const resource = resources.get(item.id);
      if (resource) {
        resource.owner = snapshot.id;
        resource.generation++;
      }
    }
    set((state) => ({
      drafts: { ...state.drafts, [key]: EMPTY_DRAFT },
      sending: { ...state.sending, [key]: (state.sending[key] ?? 0) + 1 },
    }));
    return snapshot;
  },
  finishSend: (given, outcome) => {
    const snapshot = snapshots.get(given.id);
    if (!snapshot) return; // 重复回调或会话已删除，不得恢复已回收的内容。
    if (outcome.draftKey && outcome.draftKey !== snapshot.draftKey) {
      if (snapshot.draftKey.startsWith("session:")) {
        get().migrateDraft(snapshot.draftKey, outcome.draftKey);
      } else {
        // 有明确会话归属的其它草稿不能随发送结果一起搬走，只重绑该快照。
        const previousKey = snapshot.draftKey;
        snapshot.draftKey = outcome.draftKey;
        for (const item of snapshot.items) {
          const resource = resources.get(item.id);
          if (resource?.owner === snapshot.id)
            resource.draftKey = snapshot.draftKey;
        }
        set((state) => {
          const sending = { ...state.sending };
          if ((sending[previousKey] ?? 0) <= 1) delete sending[previousKey];
          else sending[previousKey]--;
          sending[snapshot.draftKey] = (sending[snapshot.draftKey] ?? 0) + 1;
          return { sending };
        });
      }
    }
    const key = snapshot.draftKey;
    snapshots.delete(snapshot.id);
    const restored: AttachmentItem[] = [];
    for (const item of snapshot.items) {
      const resource = resources.get(item.id);
      if (!resource || resource.owner !== snapshot.id) continue;
      if (outcome.status === "committed") {
        releaseResource(resource);
      } else {
        resource.owner = "draft";
        resource.draftKey = key;
        resource.generation++;
        restored.push(item);
      }
    }
    set((state) => {
      const sending = { ...state.sending };
      if ((sending[key] ?? 0) <= 1) delete sending[key];
      else sending[key]--;
      if (outcome.status === "committed") return { sending };
      const current = state.drafts[key] ?? EMPTY_DRAFT;
      return {
        sending,
        drafts: {
          ...state.drafts,
          [key]: {
            text: mergeText(snapshot.text, current.text),
            attachments: [...restored, ...current.attachments],
            notice:
              outcome.notice ??
              "发送未成功，原输入和附件已恢复，后来输入的内容已保留",
          },
        },
      };
    });
  },
  restoreMessage: async (key, message) => {
    // 撤回不会猜测旧文本里的分隔符；只有显式元数据才恢复成文本附件。
    const textItems: AttachmentItem[] = (message.textAttachments ?? []).map(
      (attachment) => {
        const id = crypto.randomUUID();
        resources.set(id, { id, draftKey: key, owner: "draft", generation: 0 });
        return { ...attachment, id, kind: "text", status: "ready" };
      },
    );
    updateDraft(key, (draft) => ({
      text: mergeText(message.text, draft.text),
      attachments: [...textItems, ...draft.attachments],
      notice: null,
    }));
    if (message.imagePaths?.length) {
      await importSources(
        key,
        message.imagePaths.map((path, index) => ({
          kind: "saved-image", path, name: `图片 ${index + 1}`,
        })),
        true,
      );
    }
  },
}));

/** 测试或应用退出时使用；页面卸载不能清理仍属于其它草稿的资源。 */
export function resetAgentDrafts(): void {
  for (const resource of [...resources.values()]) releaseResource(resource);
  snapshots.clear();
  pendingImports.clear();
  useAgentDraftStore.setState({ drafts: {}, sending: {} });
}
