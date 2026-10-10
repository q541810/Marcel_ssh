import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ATTACH_FILE_PICKER_FILTERS,
  isAttachmentDialogCancelled,
} from "@/lib/attachmentAttach";
import { getErrorMessage } from "@/lib/errors";
import { withForegroundKeepAlive } from "@/mobile/mobileBridge";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  EMPTY_DRAFT,
  beginDraftImport,
  draftImportTarget,
  endDraftImport,
  draftKeyFor,
  draftSendBlockedReason,
  useAgentDraftStore,
  type DraftSendOutcome,
  type DraftSendSnapshot,
  type RestoreDraftMessage,
} from "@/stores/agentDraftStore";

interface UseAgentAttachmentsArgs {
  conversationId: string | null;
  sessionId: string | null;
  visionEnabled: boolean;
  canInteract: boolean;
  /** 允许准备草稿，但会话身份等条件就绪前不能发出。 */
  sendUnavailableReason?: string | null;
  /** 宿主只关心附件时关闭文本订阅，正文由 AgentDraft 单独订阅。 */
  subscribeText?: boolean;
}

/** 双端只适配事件；导入、发送、草稿归属和资源寿命由 store manager 统一管理。 */
export function useAgentAttachments({
  conversationId,
  sessionId,
  visionEnabled,
  canInteract,
  sendUnavailableReason = null,
  subscribeText = true,
}: UseAgentAttachmentsArgs) {
  const draftKey = draftKeyFor(conversationId, sessionId);
  const items = useAgentDraftStore(
    (state) => state.drafts[draftKey]?.attachments ?? EMPTY_DRAFT.attachments,
  );
  const notice = useAgentDraftStore(
    (state) => state.drafts[draftKey]?.notice ?? null,
  );
  const text = useAgentDraftStore((state) =>
    subscribeText ? (state.drafts[draftKey]?.text ?? "") : "",
  );
  const sending = useAgentDraftStore(
    (state) => (state.sending[draftKey] ?? 0) > 0,
  );
  const draft = { text, attachments: items, notice };
  const keepAliveEnabled = useSettingsStore(
    (state) => state.settings.mobileBackgroundSettings.keepAliveEnabled,
  );
  const [dragOver, setDragOver] = useState(false);
  const pickerOpen = useRef(false);

  useEffect(() => {
    setDragOver(false);
  }, [draftKey]);
  useEffect(() => {
    if (!conversationId || !sessionId) return;
    const fallbackKey = draftKeyFor(null, sessionId);
    useAgentDraftStore.getState().migrateDraft(fallbackKey, draftKey);
  }, [conversationId, sessionId, draftKey]);

  const setText = useCallback(
    (text: string | ((previous: string) => string)) => {
      useAgentDraftStore.getState().setText(draftKey, text);
    },
    [draftKey],
  );
  const remove = useCallback(
    (id: string) => useAgentDraftStore.getState().remove(draftKey, id),
    [draftKey],
  );
  const retry = useCallback(
    (id: string) => useAgentDraftStore.getState().retry(draftKey, id),
    [draftKey],
  );
  const clear = useCallback(
    () => useAgentDraftStore.getState().clear(draftKey),
    [draftKey],
  );
  const dismissNotice = useCallback(
    () => useAgentDraftStore.getState().setNotice(draftKey, null),
    [draftKey],
  );
  const handleFileObjects = useCallback(
    (files: File[]) =>
      useAgentDraftStore.getState().importFiles(draftKey, files),
    [draftKey],
  );
  const handleAttachmentPaths = useCallback(
    (paths: string[]) =>
      useAgentDraftStore.getState().importPaths(draftKey, paths),
    [draftKey],
  );

  const handleAttach = useCallback(async () => {
    if (!canInteract || pickerOpen.current) return;
    pickerOpen.current = true;
    const importId = beginDraftImport(draftKey);
    let selected: string | string[] | null;
    let targetKey: string | null = null;
    try {
      // manager 记录归属：普通切会话保持原草稿，首次建会话跟随迁移。
      selected = await withForegroundKeepAlive(keepAliveEnabled, () =>
        open({
          multiple: true,
          title: "添加图片和文件",
          filters: ATTACH_FILE_PICKER_FILTERS,
        }),
      );
    } catch (error) {
      const errorTargetKey = draftImportTarget(importId);
      if (errorTargetKey && !isAttachmentDialogCancelled(error)) {
        useAgentDraftStore
          .getState()
          .setNotice(
            errorTargetKey,
            `打开文件选择器失败：${getErrorMessage(error)}`,
          );
      }
      return;
    } finally {
      targetKey = draftImportTarget(importId);
      endDraftImport(importId);
      pickerOpen.current = false;
    }
    // 选择器关闭后再导入；旧导入完成时不能解开后一次选择器的锁。
    if (!selected || !targetKey) return;
    await useAgentDraftStore
      .getState()
      .importPaths(targetKey, Array.isArray(selected) ? selected : [selected]);
  }, [canInteract, draftKey, keepAliveEnabled]);

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent) => {
      if (!canInteract) return;
      const files = Array.from(event.clipboardData?.items ?? []).flatMap(
        (item) => {
          const file = item.kind === "file" ? item.getAsFile() : null;
          return file ? [file] : [];
        },
      );
      if (files.length === 0) return; // 普通文本粘贴和移动端 IME 继续由 textarea 处理。
      event.preventDefault();
      await handleFileObjects(files);
    },
    [canInteract, handleFileObjects],
  );

  const handleDragOver = useCallback(
    (event: React.DragEvent) => {
      if (!canInteract || !event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      setDragOver(true);
    },
    [canInteract],
  );
  const handleDragLeave = useCallback((event: React.DragEvent) => {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    )
      return;
    setDragOver(false);
  }, []);
  const handleDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDragOver(false);
      if (!canInteract) return;
      await handleFileObjects(Array.from(event.dataTransfer?.files ?? []));
    },
    [canInteract, handleFileObjects],
  );

  const takeSendSnapshot = useCallback(() => {
    if (!canInteract || sendUnavailableReason) return null;
    return useAgentDraftStore
      .getState()
      .takeSendSnapshot(draftKey, visionEnabled);
  }, [canInteract, draftKey, visionEnabled, sendUnavailableReason]);
  const finishSend = useCallback(
    (snapshot: DraftSendSnapshot, outcome: DraftSendOutcome) => {
      useAgentDraftStore.getState().finishSend(snapshot, outcome);
    },
    [],
  );
  const restoreMessage = useCallback(
    (message: RestoreDraftMessage) => {
      return useAgentDraftStore.getState().restoreMessage(draftKey, message);
    },
    [draftKey],
  );

  return {
    draftKey,
    draft,
    text,
    items,
    sending,
    importing: items.some((item) => item.status === "loading"),
    hasContent: !!text.trim() || items.length > 0,
    sendBlockedReason: !canInteract
      ? "请先连接服务器"
      : sendUnavailableReason
        ? sendUnavailableReason
        : sending
          ? "正在发送，请稍候"
          : draftSendBlockedReason(draft, visionEnabled),
    sendUnavailableReason,
    notice,
    dragOver,
    setText,
    remove,
    retry,
    clear,
    dismissNotice,
    handleAttach,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileObjects,
    handleAttachmentPaths,
    takeSendSnapshot,
    finishSend,
    restoreMessage,
  };
}

export type AgentAttachments = ReturnType<typeof useAgentAttachments>;
