import { memo } from "react";
import type { AgentMessage } from "@/lib/types";
import {
  visualizationNotice,
  type HtmlVisualizationMode,
} from "@/lib/htmlVisualization";
import { useHtmlVisualization } from "@/hooks/useHtmlVisualization";
import VisualizationSkeleton from "./VisualizationSkeleton";

interface Props {
  message: AgentMessage;
}

const HEIGHT_CAP: Record<HtmlVisualizationMode, number> = {
  inline: 800,
  wide: 1200,
};

function HtmlVisualization({ message }: Props) {
  const {
    title,
    fragment,
    mode,
    path,
    frameRef,
    theme,
    doc,
    contentHeight,
    pending,
    growing,
    onLoad,
  } = useHtmlVisualization(message);

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

  return (
    <div className="my-2 min-w-0 w-full bg-transparent">
      <div className="mb-1.5 flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap text-meta text-fg-tertiary">
        <span className="shrink-0 font-medium text-fg-secondary">{title}</span>
        {message.isExecuting && <span>正在构建…</span>}
        {path && (
          <span className="truncate" title={path}>
            {path}
          </span>
        )}
      </div>
      <div className="relative">
        {(pending || growing) && <VisualizationSkeleton />}
        <iframe
          ref={frameRef}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={title}
          srcDoc={doc}
          onLoad={onLoad}
          className={`block w-full border-0 ${growing ? "marcel-viz-frame-grow" : "marcel-viz-frame"}`}
          style={{
            height: fragment.trim()
              ? Math.min(contentHeight, HEIGHT_CAP[mode])
              : 0,
            opacity: pending ? 0 : 1,
            backgroundColor: theme.background,
            colorScheme: "normal",
          }}
        />
      </div>
    </div>
  );
}

export default memo(HtmlVisualization);
