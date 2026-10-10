import { useId, useState } from "react";
import {
  AlertCircle,
  FileText,
  Image,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import type { AttachmentItem } from "@/stores/agentDraftStore";
import { formatSize } from "@/lib/sftp-helpers";

export interface AttachmentStripProps {
  items: readonly AttachmentItem[];
  mobile?: boolean;
  onPreview: (id: string) => void;
  /** Omit the mutation callbacks when displaying attachments in a sent message. */
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  visionEnabled?: boolean;
}

function AttachmentThumbnail({ item }: { item: AttachmentItem }) {
  const src = item.previewUrl || item.dataUrl;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (item.status === "loading") {
    return (
      <Loader2
        aria-hidden
        className="h-5 w-5 animate-spin motion-reduce:animate-none"
      />
    );
  }
  if (item.status === "error") {
    return <AlertCircle aria-hidden className="h-5 w-5" />;
  }
  if (item.kind === "image" && src && failedSrc !== src) {
    return (
      <img
        src={src}
        alt=""
        className="h-full w-full rounded-md object-cover"
        onError={() => setFailedSrc(src)}
      />
    );
  }
  return item.kind === "image" ? (
    <Image aria-hidden className="h-5 w-5" />
  ) : (
    <FileText aria-hidden className="h-5 w-5" />
  );
}

function AttachmentCard({
  item,
  mobile,
  onPreview,
  onRemove,
  onRetry,
}: Omit<AttachmentStripProps, "items" | "visionEnabled"> & {
  item: AttachmentItem;
}) {
  const descriptionId = useId();
  const name = item.name || (item.kind === "image" ? "图片" : "文本文件");
  const hasContent =
    item.kind === "image"
      ? Boolean(item.previewUrl || item.dataUrl)
      : typeof item.content === "string";
  const canPreview = item.status === "ready" && hasContent;
  const hasSize =
    typeof item.size === "number" &&
    Number.isFinite(item.size) &&
    item.size >= 0;
  const detail =
    item.status === "loading"
      ? "正在读取…"
      : item.status === "error"
        ? item.error || "读取失败，请重试"
        : !hasContent
          ? "内容暂不可用"
          : `${item.kind === "image" ? "图片" : "文本"}${hasSize ? ` · ${formatSize(item.size!)}` : ""}`;
  const actionClass = `inline-flex shrink-0 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-100 active:bg-zinc-700 focus-visible:outline-offset-[-2px] ${mobile ? "h-12 w-12" : "h-9 w-8"}`;

  return (
    <li
      className={`flex shrink-0 items-center overflow-hidden rounded-xl border ${item.status === "error" ? "border-red-800/60 bg-red-950/30" : "border-zinc-700 bg-zinc-900"} ${item.status === "error" && onRetry ? "w-[18rem]" : mobile ? "w-[15rem]" : "w-[13rem]"} max-w-full`}
      data-attachment-id={item.id}
    >
      <button
        type="button"
        disabled={!canPreview}
        onClick={() => onPreview(item.id)}
        aria-label={`预览 ${name}`}
        aria-describedby={descriptionId}
        aria-haspopup="dialog"
        data-attachment-preview={item.id}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left transition-colors enabled:hover:bg-zinc-800 enabled:active:bg-zinc-800 disabled:cursor-default focus-visible:outline-offset-[-2px]"
        title={canPreview ? `预览 ${name}` : `${name}：${detail}`}
      >
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${item.status === "error" ? "text-red-300" : "bg-zinc-800 text-zinc-400"}`}
        >
          <AttachmentThumbnail item={item} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-zinc-200">
            {name}
          </span>
          <span
            id={descriptionId}
            className={`mt-0.5 block text-[11px] leading-4 ${item.status === "error" ? "line-clamp-2 text-red-300" : "truncate text-zinc-400"}`}
            title={detail}
          >
            {detail}
          </span>
        </span>
      </button>
      {item.status === "error" && onRetry && (
        <button
          type="button"
          onClick={() => onRetry(item.id)}
          className={actionClass}
          aria-label={`重试读取 ${name}`}
          title={`重试读取 ${name}`}
        >
          <RotateCw aria-hidden className="h-4 w-4" />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(item.id)}
          className={`${actionClass} mr-1 hover:text-red-300`}
          aria-label={`移除 ${name}`}
          title={`移除 ${name}`}
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      )}
    </li>
  );
}

/** A bounded composer row shared with read-only message attachments. */
export default function AttachmentStrip({
  items,
  mobile = false,
  onPreview,
  onRemove,
  onRetry,
  visionEnabled = true,
}: AttachmentStripProps) {
  if (items.length === 0) return null;
  const unsupportedImages =
    !visionEnabled && items.some((item) => item.kind === "image");
  return (
    <div className="min-w-0 max-w-full">
      <ul
        aria-label="附件"
        className="m-0 flex list-none items-stretch gap-2 overflow-x-auto overscroll-x-contain px-0.5 py-1"
      >
        {items.map((item) => (
          <AttachmentCard
            key={item.id}
            item={item}
            mobile={mobile}
            onPreview={onPreview}
            onRemove={onRemove}
            onRetry={onRetry}
          />
        ))}
      </ul>
      {unsupportedImages && (
        <p role="status" className="mt-1 text-xs leading-relaxed text-zinc-300">
          当前模型不支持图片，请更换支持图片的模型或移除图片后发送。
        </p>
      )}
    </div>
  );
}
