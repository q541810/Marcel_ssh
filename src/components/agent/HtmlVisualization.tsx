import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage } from "@/lib/types";
import {
  buildSettledVisualizationDoc,
  buildStreamingVisualizationDoc,
  HTML_VIZ_HEIGHT_MESSAGE,
  HTML_VIZ_STREAM_MESSAGE,
  resolveVisualizationTheme,
  trimIncompleteStreamingScript,
  type HtmlVisualizationMode,
  visualizationPresentation,
} from "@/lib/htmlVisualization";

interface Props {
  message: AgentMessage;
}

const MIN_HEIGHT = 48;
const HEIGHT_CAP: Record<HtmlVisualizationMode, number> = {
  inline: 800,
  wide: 1200,
};

function HtmlVisualization({ message }: Props) {
  const tr = message.toolResult;
  const { title, fragment, mode, path } = visualizationPresentation(message);
  const token = tr?.toolCallId ?? message.id;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [theme, setTheme] = useState(resolveVisualizationTheme);

  useEffect(() => {
    const refreshTheme = () => setTheme(resolveVisualizationTheme());
    const observer = new MutationObserver(refreshTheme);
    observer.observe(document.documentElement, { attributes: true });
    observer.observe(document.body, { attributes: true });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", refreshTheme);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", refreshTheme);
    };
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as {
        type?: unknown;
        token?: unknown;
        height?: unknown;
      } | null;
      if (data?.type !== HTML_VIZ_HEIGHT_MESSAGE || data.token !== token)
        return;
      if (typeof data.height !== "number" || !Number.isFinite(data.height))
        return;
      setHeight(
        Math.max(
          MIN_HEIGHT,
          Math.min(Math.ceil(data.height), HEIGHT_CAP[mode]),
        ),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [mode, token]);

  const streamingDoc = useMemo(
    () => buildStreamingVisualizationDoc(theme, token),
    [theme, token],
  );
  const settledDoc = useMemo(
    () => buildSettledVisualizationDoc(fragment, title, theme, token),
    [fragment, title, theme, token],
  );
  const doc = message.isExecuting ? streamingDoc : settledDoc;

  useEffect(() => {
    if (!message.isExecuting || !loaded || !fragment.trim()) return;
    frameRef.current?.contentWindow?.postMessage(
      {
        type: HTML_VIZ_STREAM_MESSAGE,
        token,
        fragment: trimIncompleteStreamingScript(fragment),
      },
      "*",
    );
  }, [fragment, loaded, message.isExecuting, token]);

  if (tr && (!tr.success || tr.blocked)) {
    return (
      <div className="my-1 text-xs text-red-400">
        {tr.summary || "可视化失败"}
      </div>
    );
  }
  if (!fragment.trim() && !message.isExecuting) {
    return (
      <div className="my-1 text-xs text-zinc-500">
        {tr?.result || "可视化内容不可用"}
      </div>
    );
  }

  return (
    <div className="my-2 min-w-0 w-full bg-transparent">
      <div className="mb-1.5 flex min-w-0 items-baseline gap-2 overflow-hidden whitespace-nowrap text-xs text-zinc-500">
        <span className="shrink-0 font-medium text-zinc-300">{title}</span>
        {message.isExecuting && <span>正在构建…</span>}
        {path && (
          <span className="truncate" title={path}>
            {path}
          </span>
        )}
      </div>
      <iframe
        ref={frameRef}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={title}
        srcDoc={doc}
        onLoad={() => setLoaded(true)}
        className="block w-full border-0"
        style={{
          height: fragment.trim() ? height : 0,
          backgroundColor: theme.background,
          colorScheme: "normal",
        }}
      />
    </div>
  );
}

export default memo(HtmlVisualization);
