import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  X,
} from "lucide-react";
import type { AttachmentItem } from "@/stores/agentDraftStore";
import Modal from "@/components/ui/Modal";
import MobileFullscreenPage from "@/mobile/ui/MobileFullscreenPage";
import ImagePreviewModal from "@/components/sftp/ImagePreviewModal";
import MobileImageViewer from "@/mobile/MobileImageViewer";
import { usePreviewDialogFocus } from "@/hooks/usePreviewDialogFocus";
import { useAnimatedClose } from "@/hooks/useAnimatedPresence";
import { formatSize } from "@/lib/sftp-helpers";
import "./AttachmentPreview.css";

export interface AttachmentPreviewProps {
  item: AttachmentItem | null;
  mobile?: boolean;
  onClose: () => void;
}

// Only the current page is mounted, even after navigating through a large log.
const TEXT_PAGE_SIZE = 24_000;

function pageBoundary(content: string, offset: number): number {
  const end = Math.min(offset, content.length);
  // Keep a UTF-16 surrogate pair together at a page boundary.
  const current = content.charCodeAt(end);
  const previous = content.charCodeAt(end - 1);
  return current >= 0xdc00 &&
    current <= 0xdfff &&
    previous >= 0xd800 &&
    previous <= 0xdbff
    ? end + 1
    : end;
}

function TextPreview({
  content,
  mobile,
}: {
  content: string;
  mobile: boolean;
}) {
  const [page, setPage] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pages = Math.max(1, Math.ceil(content.length / TEXT_PAGE_SIZE));
  const activePage = Math.min(page, pages - 1);
  const start = pageBoundary(content, activePage * TEXT_PAGE_SIZE);
  const end = pageBoundary(content, (activePage + 1) * TEXT_PAGE_SIZE);
  const actionClass = `inline-flex shrink-0 items-center justify-center rounded-lg text-zinc-300 hover:bg-zinc-800 active:bg-zinc-800 disabled:opacity-30 ${mobile ? "h-12 w-12" : "h-9 w-9"}`;

  useLayoutEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [activePage]);

  return (
    <>
      <div
        ref={scrollerRef}
        tabIndex={0}
        aria-label="文本附件内容"
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-zinc-950 p-4 focus-visible:outline-offset-[-2px]"
      >
        {content.length === 0 ? (
          <p className="text-sm text-zinc-400">文件内容为空</p>
        ) : (
          <pre className="m-0 whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-zinc-200 [overflow-wrap:anywhere] [tab-size:2]">
            {content.slice(start, end)}
          </pre>
        )}
      </div>
      {pages > 1 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-zinc-800 px-3 py-2">
          <div className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-400">
            <div role="status">
              第 {activePage + 1} / {pages} 段
            </div>
            <div>仅分段预览，发送包含完整文件内容</div>
          </div>
          <button
            type="button"
            aria-label="上一段"
            disabled={activePage === 0}
            onClick={() => setPage(activePage - 1)}
            className={actionClass}
          >
            <ChevronLeft aria-hidden className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label="下一段"
            disabled={activePage === pages - 1}
            onClick={() => setPage(activePage + 1)}
            className={actionClass}
          >
            <ChevronRight aria-hidden className="h-5 w-5" />
          </button>
        </div>
      )}
    </>
  );
}

function PreviewNotice({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm leading-relaxed text-zinc-300"
    >
      {error ? (
        <AlertCircle aria-hidden className="h-6 w-6 text-red-300" />
      ) : (
        <Loader2
          aria-hidden
          className="h-6 w-6 animate-spin motion-reduce:animate-none"
        />
      )}
      {children}
    </div>
  );
}

function PreviewDialog({
  item,
  mobile,
  onClose,
}: {
  item: AttachmentItem;
  mobile: boolean;
  onClose: () => void;
}) {
  const { closing, requestClose, onAnimationEnd } = useAnimatedClose(onClose);
  const titleId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const name = item.name || (item.kind === "image" ? "图片" : "文本文件");
  const hasSize =
    typeof item.size === "number" &&
    Number.isFinite(item.size) &&
    item.size >= 0;

  useLayoutEffect(() => {
    if (mobile) return;
    const dialog = contentRef.current?.closest('[role="dialog"]');
    if (!dialog) return;
    dialog.setAttribute("aria-labelledby", titleId);
    const finishAnimation = (event: Event) => {
      if (event.target === dialog)
        onAnimationEnd({ target: dialog, currentTarget: dialog });
    };
    dialog.addEventListener("animationend", finishAnimation);
    return () => dialog.removeEventListener("animationend", finishAnimation);
  }, [mobile, onAnimationEnd, titleId]);
  usePreviewDialogFocus({
    open: true,
    mobile,
    dialogRef: contentRef,
    initialFocusRef: closeRef,
    onClose: requestClose,
  });

  const body = (
    <div
      ref={contentRef}
      role={mobile ? "dialog" : undefined}
      aria-modal={mobile ? true : undefined}
      aria-labelledby={mobile ? titleId : undefined}
      onKeyDown={(event) => event.stopPropagation()}
      className="flex min-h-0 flex-1 flex-col"
    >
      <header
        className="flex shrink-0 items-center gap-3 border-b border-zinc-700 px-4 py-2"
        style={
          mobile
            ? { paddingTop: "max(0.5rem, env(safe-area-inset-top, 0px))" }
            : undefined
        }
      >
        <div className="min-w-0 flex-1 py-1">
          <h2
            id={titleId}
            className="break-words text-sm font-semibold leading-relaxed text-zinc-100 [overflow-wrap:anywhere]"
          >
            {name}
          </h2>
          <p className="mt-0.5 text-xs text-zinc-400">
            {item.kind === "image" ? "图片预览" : "文本预览"}
            {hasSize ? ` · ${formatSize(item.size!)}` : ""}
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={requestClose}
          aria-label="关闭附件预览"
          className={`inline-flex shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 active:bg-zinc-700 ${mobile ? "h-12 w-12" : "h-9 w-9"}`}
        >
          <X aria-hidden className="h-5 w-5" />
        </button>
      </header>
      {item.status === "loading" ? (
        <PreviewNotice>正在读取附件…</PreviewNotice>
      ) : item.status === "error" ? (
        <PreviewNotice error>
          {item.error || "读取附件失败，请关闭预览后重试。"}
        </PreviewNotice>
      ) : typeof item.content === "string" ? (
        <TextPreview content={item.content} mobile={mobile} />
      ) : (
        <PreviewNotice error>附件内容暂不可用。</PreviewNotice>
      )}
    </div>
  );

  return mobile ? (
    <MobileFullscreenPage
      region="agent-attachment-preview"
      closing={closing}
      onExitAnimationEnd={onAnimationEnd}
      onBack={requestClose}
    >
      {body}
    </MobileFullscreenPage>
  ) : (
    <Modal
      open={!closing}
      onClose={requestClose}
      size="xl"
      contentClassName="attachment-preview-modal"
    >
      {body}
    </Modal>
  );
}

/** Preview only supplied local content. A closed preview mounts no readers or listeners. */
export default function AttachmentPreview({
  item,
  mobile = false,
  onClose,
}: AttachmentPreviewProps) {
  if (!item) return null;
  if (item.kind === "image" && item.status === "ready") {
    const Viewer = mobile ? MobileImageViewer : ImagePreviewModal;
    return (
      <Viewer
        key={item.id}
        open
        source={{
          kind: "local",
          src: item.previewUrl || item.dataUrl || "",
          fallbackSrc: item.dataUrl,
        }}
        fileName={item.name || "图片"}
        fileSize={item.size}
        onClose={onClose}
      />
    );
  }
  return (
    <PreviewDialog
      key={item.id}
      item={item}
      mobile={mobile}
      onClose={onClose}
    />
  );
}
