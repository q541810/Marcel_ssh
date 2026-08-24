import type { ComponentType } from "react";
import type { AgentMessage } from "@/lib/types";
import { collectPlatformHints, isMobilePlatform } from "@/platform";
import HtmlVisualization from "./HtmlVisualization";
import MobileVisualizationUnavailable from "./MobileVisualizationUnavailable";

export interface ToolViewProps {
  message: AgentMessage;
}

/**
 * 一个工具的专属展示条目。
 *
 * `desktop` 是该工具的默认展示；`mobile` 只在移动端有不同呈现时才填
 * （如桌面专属能力的历史回放降级说明），省略即两端共用 `desktop`。
 * 平台差异留在条目里，`getToolView` 因此不需要认识任何具体工具名。
 */
interface ToolViewEntry {
  desktop: ComponentType<ToolViewProps>;
  mobile?: ComponentType<ToolViewProps>;
}

/**
 * 专属工具展示注册表。
 *
 * 命中时由专属 view 完整接管该工具消息的展示；未命中才回退到
 * ToolCallCard。这样工具协议、持久化与消息顺序保持统一，视觉产物无需
 * 塞进通用工具卡片，也不在 AgentMessageList 中散落工具名分支。
 */
const TOOL_VIEWS: Record<string, ToolViewEntry> = {
  render_html: {
    desktop: HtmlVisualization,
    mobile: MobileVisualizationUnavailable,
  },
};

export function getToolView(
  toolName: string,
  mobile = isMobilePlatform(collectPlatformHints()),
): ComponentType<ToolViewProps> | undefined {
  const entry = TOOL_VIEWS[toolName];
  if (!entry) return undefined;
  return mobile ? (entry.mobile ?? entry.desktop) : entry.desktop;
}
