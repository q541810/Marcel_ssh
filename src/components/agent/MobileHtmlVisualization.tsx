import { memo, useState } from "react";
import { Maximize2 } from "lucide-react";
import type { AgentMessage } from "@/lib/types";
import {
  MOBILE_VIZ_STREAM_THROTTLE_MS,
  mobileVisualizationCap,
  mobileVisualizationFrame,
  visualizationNotice,
} from "@/lib/htmlVisualization";
import { useHtmlVisualization } from "@/hooks/useHtmlVisualization";
import { useIframeFocusReveal } from "@/hooks/useIframeFocusReveal";
import { useViewportSize } from "@/hooks/useViewportSize";
import MobileHtmlVisualizationViewer from "@/mobile/MobileHtmlVisualizationViewer";
import VisualizationSkeleton from "./VisualizationSkeleton";

interface Props {
  message: AgentMessage;
}

/**
 * 手机端对话内的交互可视化。
 *
 * 与桌面版的区别：高度压在一屏以内（`mobileVisualizationCap`），iframe 内部不滚动
 * ——手指落在可视化上下滑，带动的是对话列表本身，而不是卡在里层。放不下的部分
 * 在底部渐隐，并给「全屏查看」入口，全屏查看器里才能完整滚动浏览。
 */
function MobileHtmlVisualization({ message }: Props) {
  // 底色按「所在的面」取：手机对话页（zinc-950）比底部面板、桌面面板（zinc-900）更深，
  // 写死一个颜色总有一边会是一块偏亮或偏暗的方块。见 globals.css 的
  // `.marcel-viz-surface-page`。
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const {
    title,
    fragment,
    path,
    token,
    frameRef,
    theme,
    ready,
    doc,
    contentHeight,
    pending,
    growing,
    onLoad,
  } = useHtmlVisualization(message, {
    scrollable: false,
    streamThrottleMs: MOBILE_VIZ_STREAM_THROTTLE_MS,
    focus: "report",
    host,
  });
  useIframeFocusReveal(frameRef, token);
  const viewport = useViewportSize();
  const [viewerOpen, setViewerOpen] = useState(false);

  const notice = visualizationNotice(message, fragment);
  if (notice) {
    return (
      <div
        className={`my-1 text-meta ${notice.tone === "error" ? "text-red-400" : "text-fg-tertiary"}`}
      >
        {notice.text}
      </div>
    );
  }

  const hasContent = !!fragment.trim();
  const { height, clipped } = mobileVisualizationFrame(
    contentHeight,
    mobileVisualizationCap(viewport.width, viewport.height),
  );
  // 全屏查看器打开的是定稿文档，流式阶段没有可看的完整内容。
  const canOpenViewer = hasContent && !message.isExecuting;

  return (
    <div ref={setHost} className="my-2 min-w-0 w-full bg-transparent">
      <div className="mb-1.5 flex min-w-0 items-center gap-2 whitespace-nowrap text-meta text-fg-tertiary">
        <span className="min-w-0 truncate font-medium text-fg-secondary">
          {title}
        </span>
        {message.isExecuting && <span className="shrink-0">正在构建…</span>}
        {path && (
          <span className="min-w-0 truncate" title={path}>
            {path}
          </span>
        )}
        {canOpenViewer && (
          // 触控热区 44px，用负外边距收回去，标题行的高度不变。
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            className="-my-3.5 -mr-2 ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-fg-secondary transition-colors duration-100 active:bg-white/10 active:text-fg"
            aria-label="全屏查看"
          >
            <Maximize2 aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="relative overflow-hidden">
        {(pending || growing) && <VisualizationSkeleton />}
        {ready && (
          <iframe
            ref={frameRef}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            title={title}
            srcDoc={doc}
            onLoad={onLoad}
            className={`block w-full border-0 ${growing ? "marcel-viz-frame-grow" : "marcel-viz-frame"}`}
            style={{
              height: hasContent ? height : 0,
              opacity: pending ? 0 : 1,
              backgroundColor: theme.background,
              colorScheme: "normal",
            }}
          />
        )}
        {hasContent && clipped && (
          <>
            {/* 渐隐只提示「下面还有」，不拦截触摸：手指照样落在可视化上。 */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-20"
              style={{
                background: `linear-gradient(to top, ${theme.background} 8%, transparent)`,
              }}
            />
            {canOpenViewer && (
              <button
                type="button"
                onClick={() => setViewerOpen(true)}
                className="absolute bottom-2 left-1/2 flex min-h-11 -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-surface-raised/90 px-4 text-read text-fg shadow-raised backdrop-blur pressable"
              >
                <Maximize2 aria-hidden="true" className="h-4 w-4" />
                全屏查看
              </button>
            )}
          </>
        )}
      </div>
      {viewerOpen && canOpenViewer && (
        <MobileHtmlVisualizationViewer
          title={title}
          fragment={fragment}
          token={token}
          theme={theme}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  );
}

export default memo(MobileHtmlVisualization);
