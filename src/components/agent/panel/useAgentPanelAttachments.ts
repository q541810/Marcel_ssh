import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import * as tauri from "@/lib/tauri";
import {
  type PendingImage,
  revokePendingImages,
  compressImageFile,
  deletePersistedImagePaths,
  MAX_ATTACH_IMAGES,
} from "@/lib/imageAttach";
import {
  ATTACH_FILE_PICKER_FILTERS,
  classifyAttachment,
  blobToText,
  wrapTextAttachment,
  base64ToBlob,
  readLocalAttachment,
  partitionAttachmentPaths,
  unsupportedAttachmentHint,
  MAX_TEXT_FILE_BYTES,
} from "@/lib/attachmentAttach";
import { notifyInputTyping } from "./inputActivity";

type UseAgentPanelAttachmentsArgs = {
  /** 当前会话实际生效模型是否支持图片（决定图片走预览还是提示）。 */
  visionEnabled: boolean;
  canInteract: boolean;
  /** 切换对话时丢掉草稿附件，避免把 A 的撤回图带到 B。 */
  activeConversationId: string | null;
  /** 输入草稿写入（来自 useAgent 的 setInputDraft）。 */
  setInput: (text: string | ((prev: string) => string)) => void;
};

/**
 * AgentPanel 输入区的附件域：挂起图片预览、拖拽 / 粘贴 / 文件选择器的
 * 统一分拣（图片 → 预览，文本 → 草稿，其余 → 明确提示）、vision 开关与
 * 会话切换时的清理。发送与撤回直接复用这里的 state 与清理函数。
 */
export function useAgentPanelAttachments({
  visionEnabled,
  canInteract,
  activeConversationId,
  setInput,
}: UseAgentPanelAttachmentsArgs) {
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [attachHint, setAttachHint] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const attachHintTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (attachHintTimerRef.current !== null) {
        window.clearTimeout(attachHintTimerRef.current);
      }
    },
    [],
  );

  const showAttachHint = useCallback((msg: string) => {
    setAttachHint(msg);
    if (attachHintTimerRef.current !== null) {
      window.clearTimeout(attachHintTimerRef.current);
    }
    attachHintTimerRef.current = window.setTimeout(() => {
      setAttachHint(null);
      attachHintTimerRef.current = null;
    }, 3200);
  }, []);

  const deletePersistedPaths = useCallback(
    async (paths: Array<string | undefined | null>) => {
      await deletePersistedImagePaths(paths, tauri.agentDeleteMessageImage);
    },
    [],
  );

  /** 清空预览；deleteDisk=true 时删除撤回恢复的落盘图 */
  const clearPendingImages = useCallback(
    (options?: { deleteDisk?: boolean }) => {
      const deleteDisk = options?.deleteDisk ?? false;
      setPendingImages((prev) => {
        if (deleteDisk) {
          void deletePersistedPaths(prev.map((p) => p.persistedPath));
        }
        revokePendingImages(prev);
        return [];
      });
    },
    [deletePersistedPaths],
  );

  const removePendingImage = useCallback(
    (id: string) => {
      setPendingImages((prev) => {
        const target = prev.find((p) => p.id === id);
        if (target?.persistedPath) {
          void deletePersistedPaths([target.persistedPath]);
        }
        if (target) revokePendingImages([target]);
        return prev.filter((p) => p.id !== id);
      });
    },
    [deletePersistedPaths],
  );

  // 切换对话/主机时丢掉草稿附件，避免把 A 的撤回图带到 B
  const prevConversationIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevConversationIdRef.current;
    prevConversationIdRef.current = activeConversationId;
    if (prev === undefined) return; // 首次挂载
    if (prev === activeConversationId) return;
    clearPendingImages({ deleteDisk: true });
  }, [activeConversationId, clearPendingImages]);

  // Vision OFF：清空已挂起图片并删落盘图（未保留在预览）
  useEffect(() => {
    if (!visionEnabled && pendingImages.length > 0) {
      clearPendingImages({ deleteDisk: true });
      showAttachHint("当前模型未开启「视觉 / 支持图片」");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to vision toggle
  }, [visionEnabled]);

  /** 追加文本附件到输入框草稿（带文件名标记），并保持输入框自动增高。 */
  const appendTextAttachment = useCallback(
    (text: string) => {
      setInput((prev) => (prev ? prev + text : text));
      requestAnimationFrame(() => {
        notifyInputTyping();
      });
    },
    [setInput],
  );

  /** 统一处理一组本地 File（拖拽 / 粘贴）：图片 → 预览区，文本 → 插入输入框。 */
  const handleFileObjects = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const imageFiles: File[] = [];
      const textFiles: File[] = [];
      const unsupported: string[] = [];
      for (const f of files) {
        const kind = classifyAttachment(f.name, f.type);
        if (kind === "image") imageFiles.push(f);
        else if (kind === "text") textFiles.push(f);
        else unsupported.push(f.name);
      }

      // 明确提示不支持的文件，避免静默吞掉（如 .zip/.exe/.pdf）
      if (unsupported.length > 0) {
        showAttachHint(unsupportedAttachmentHint(unsupported));
      }

      // 图片 → 预览（与 ctrl+v 完全同路径）；vision 关闭时跳过图片，文本照常处理
      if (imageFiles.length > 0) {
        if (!visionEnabled) {
          clearPendingImages({ deleteDisk: true });
          showAttachHint("当前模型未开启「视觉 / 支持图片」");
        } else {
          const room = MAX_ATTACH_IMAGES - pendingImages.length;
          const added: PendingImage[] = [];
          for (const file of imageFiles.slice(0, room)) {
            try {
              const { dataUrl, previewUrl } = await compressImageFile(file);
              added.push({ id: crypto.randomUUID(), previewUrl, dataUrl });
            } catch {
              // skip broken files
            }
          }
          if (added.length > 0) {
            setPendingImages((prev) =>
              [...prev, ...added].slice(0, MAX_ATTACH_IMAGES),
            );
          }
          if (imageFiles.length > room) {
            showAttachHint(`最多 ${MAX_ATTACH_IMAGES} 张，已忽略多余图片`);
          }
        }
      }

      // 文本 → 输入框
      for (const file of textFiles) {
        if (file.size > MAX_TEXT_FILE_BYTES) {
          showAttachHint(
            `「${file.name}」超过 ${Math.round(MAX_TEXT_FILE_BYTES / 1024 / 1024)}MB，已跳过`,
          );
          continue;
        }
        try {
          const content = await blobToText(file);
          appendTextAttachment(wrapTextAttachment(file.name, content));
        } catch {
          showAttachHint(`读取「${file.name}」失败`);
        }
      }
    },
    [
      visionEnabled,
      pendingImages.length,
      clearPendingImages,
      showAttachHint,
      appendTextAttachment,
    ],
  );

  /** 统一处理一组本地路径（文件选择器返回）：图片 → 预览区，文本 → 插入输入框。 */
  const handleAttachmentPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;

      // 分拣（含 content:// 展示名解析）抽在 attachmentAttach 里，桌面 / 移动共用
      const { imagePaths, textPaths, unsupported } =
        await partitionAttachmentPaths(paths);

      // 明确提示不支持的文件，避免静默吞掉（如 .zip/.exe/.pdf）
      if (unsupported.length > 0) {
        showAttachHint(
          unsupportedAttachmentHint(unsupported.map((u) => u.name)),
        );
      }

      // 图片 → 预览（读本地 → 压缩，与 ctrl+v 同链路）；vision 关闭时跳过图片，文本照常处理
      if (imagePaths.length > 0) {
        if (!visionEnabled) {
          clearPendingImages({ deleteDisk: true });
          showAttachHint("当前模型未开启「视觉 / 支持图片」");
        } else {
          const room = MAX_ATTACH_IMAGES - pendingImages.length;
          const added: PendingImage[] = [];
          for (const p of imagePaths.slice(0, room)) {
            try {
              const { base64 } = await readLocalAttachment(p);
              const blob = base64ToBlob(base64, "image/*");
              const { dataUrl, previewUrl } = await compressImageFile(blob);
              added.push({ id: crypto.randomUUID(), previewUrl, dataUrl });
            } catch {
              // skip broken files
            }
          }
          if (added.length > 0) {
            setPendingImages((prev) =>
              [...prev, ...added].slice(0, MAX_ATTACH_IMAGES),
            );
          }
          if (imagePaths.length > room) {
            showAttachHint(`最多 ${MAX_ATTACH_IMAGES} 张，已忽略多余图片`);
          }
        }
      }

      // 文本 → 输入框
      for (const p of textPaths) {
        try {
          const { name, base64, size } = await readLocalAttachment(p);
          if (size > MAX_TEXT_FILE_BYTES) {
            showAttachHint(
              `「${name}」超过 ${Math.round(MAX_TEXT_FILE_BYTES / 1024 / 1024)}MB，已跳过`,
            );
            continue;
          }
          const content = await blobToText(base64ToBlob(base64));
          appendTextAttachment(wrapTextAttachment(name, content));
        } catch {
          const name = p.split(/[/\\]/).pop() || p;
          showAttachHint(`读取「${name}」失败`);
        }
      }
    },
    [
      visionEnabled,
      pendingImages.length,
      clearPendingImages,
      showAttachHint,
      appendTextAttachment,
    ],
  );

  /** 附件按钮：系统文件选择器（图片 / 文本 / 所有文件）。 */
  const handleAttach = useCallback(async () => {
    if (!canInteract) return;
    try {
      const selected = await open({
        multiple: true,
        title: "添加图片和文件",
        filters: ATTACH_FILE_PICKER_FILTERS,
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await handleAttachmentPaths(paths);
    } catch {
      showAttachHint("打开文件选择器失败");
    }
  }, [canInteract, handleAttachmentPaths, showAttachHint]);

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      // 图片或文本文件才接管粘贴（普通文本粘贴走系统默认）
      const kind = classifyAttachment(file.name, file.type);
      if (kind === "image" || kind === "text") files.push(file);
    }
    if (files.length === 0) return;
    e.preventDefault();
    await handleFileObjects(files);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (!canInteract) return;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    await handleFileObjects(Array.from(files));
  };

  return {
    pendingImages,
    setPendingImages,
    attachHint,
    dragOver,
    showAttachHint,
    clearPendingImages,
    deletePersistedPaths,
    removePendingImage,
    handleFileObjects,
    handleAttachmentPaths,
    handleAttach,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}

export type AgentPanelAttachments = ReturnType<typeof useAgentPanelAttachments>;
