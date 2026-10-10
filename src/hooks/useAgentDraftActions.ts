import { useCallback, useRef, type MutableRefObject } from "react";
import type { AgentMessage } from "@/lib/types";
import { getErrorMessage } from "@/lib/errors";
import { useTaskStore } from "@/stores/taskStore";
import {
  conversationIsBusy,
  useConversationStore,
} from "@/stores/conversationStore";
import {
  beginDraftImport,
  draftImportTarget,
  endDraftImport,
  draftKeyFor,
  useAgentDraftStore,
} from "@/stores/agentDraftStore";
import type { AgentAttachments } from "./useAgentAttachments";

interface Args {
  attachments: AgentAttachments;
  sessionId: string | null;
  connectionId?: string;
  conversationId: string | null;
  canInteract: boolean;
  userJustSentRef: MutableRefObject<boolean>;
  onRollback?: (removedCount: number) => void;
  onSend?: () => void;
}

/** 两端共用发送快照与撤回恢复；异步结果始终回到发起操作的草稿。 */
export function useAgentDraftActions({
  attachments,
  sessionId,
  connectionId,
  conversationId,
  canInteract,
  userJustSentRef,
  onRollback,
  onSend,
}: Args) {
  const sending = useAgentDraftStore((s) => !!s.sending[attachments.draftKey]);
  const latestSendIdRef = useRef<string | null>(null);

  const send = useCallback(async () => {
    if (
      !canInteract ||
      !sessionId ||
      (conversationId && conversationIsBusy(conversationId))
    )
      return;
    const snapshot = attachments.takeSendSnapshot();
    if (!snapshot) return;
    latestSendIdRef.current = snapshot.id;
    userJustSentRef.current = true;
    onSend?.();
    try {
      const taskId = await useTaskStore.getState().startTask(
        sessionId,
        snapshot.text,
        connectionId,
        snapshot.images.map((item) => item.dataUrl),
        snapshot.images.flatMap((item) =>
          item.persistedPath ? [item.persistedPath] : [],
        ),
        {
          conversationId: conversationId ?? undefined,
          userInput:
            snapshot.textAttachments.length > 0
              ? snapshot.userInput
              : undefined,
        },
      );
      const targetId =
        useTaskStore.getState().tasks[taskId]?.conversationId ?? conversationId;
      attachments.finishSend(snapshot, {
        status: "committed",
        draftKey: targetId ? draftKeyFor(targetId, sessionId) : undefined,
      });
    } catch (error) {
      const detail =
        error && typeof error === "object"
          ? (error as { stage?: string; conversationId?: string })
          : {};
      const committed = detail.stage === "start_task";
      const targetKey = detail.conversationId
        ? draftKeyFor(detail.conversationId, sessionId)
        : snapshot.draftKey;
      attachments.finishSend(snapshot, {
        status: committed ? "committed" : "rejected",
        draftKey: targetKey,
        notice: committed
          ? undefined
          : `未发送：${getErrorMessage(error)}。输入与附件已保留。`,
      });
      // 双端跨会话复用滚动 ref；旧发送不能清掉后来发送的滚动意图。
      if (!committed && latestSendIdRef.current === snapshot.id) {
        userJustSentRef.current = false;
      }
    }
  }, [
    attachments,
    sessionId,
    connectionId,
    conversationId,
    canInteract,
    userJustSentRef,
    onSend,
  ]);

  const rollback = useCallback(
    async (message: AgentMessage) => {
      if (!conversationId || conversationIsBusy(conversationId) || sending)
        return;
      const importId = beginDraftImport(attachments.draftKey);
      try {
        const result = await useConversationStore
          .getState()
          .rollbackToMessage(conversationId, message.id);
        const targetKey = draftImportTarget(importId);
        if (!targetKey) return;
        await useAgentDraftStore.getState().restoreMessage(targetKey, {
          text: result.prompt,
          textAttachments: result.userInput?.textAttachments,
          imagePaths: result.imagePaths?.length
            ? result.imagePaths
            : message.imagePaths,
        });
        if (
          draftImportTarget(importId) &&
          useConversationStore.getState().activeConversationId ===
            conversationId
        ) {
          onRollback?.(result.removedCount);
        }
      } catch (error) {
        const targetKey = draftImportTarget(importId);
        if (targetKey) {
          useAgentDraftStore
            .getState()
            .setNotice(targetKey, `撤回失败：${getErrorMessage(error)}`);
        }
      } finally {
        endDraftImport(importId);
      }
    },
    [attachments.draftKey, conversationId, sending, onRollback],
  );

  return { send, rollback, sending };
}
