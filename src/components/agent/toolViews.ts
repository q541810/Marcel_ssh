import type { ComponentType } from "react";
import type { AgentMessage } from "@/lib/types";
import { collectPlatformHints, isMobilePlatform } from "@/platform";
import HtmlVisualization from "./HtmlVisualization";
import MobileHtmlVisualization from "./MobileHtmlVisualization";
import MemoryToolView from "./MemoryToolView";
import QuestionRecord from "./QuestionRecord";
import AskParentExchange from "./AskParentExchange";
import PresentFileView from "./PresentFileCard";

export interface ToolViewProps {
  message: AgentMessage;
  /** 在已展开的工具分组里：与通用工具卡一样缩进一格。独占一行的 view（图表）可以不理。 */
  grouped?: boolean;
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
  /**
   * 滚出视口后仍保持挂载（受 `maxRetainedViews` 限额）。只给重建代价大的 view
   * （iframe 可视化）开：轻量卡片占了限额会把真正需要保活的图表挤掉。
   */
  retain?: boolean;
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
    // 手机：高度压在一屏内、内部不滚动，放不下的走全屏查看器。
    mobile: MobileHtmlVisualization,
    retain: true,
  },
  // 工具卡同一副骨架：「已记住 · 标题 · 作用域」，展开后有 撤销 / 编辑；两端同一个组件。
  memory: {
    desktop: MemoryToolView,
  },
  // 交付文件卡片：一张卡片，打开 / 在文件管理中显示；本机版同一个组件。
  present_file: { desktop: PresentFileView },
  local_present_file: { desktop: PresentFileView },
  // 提问记录：内联卡片作答后原地收成一行「已回答：…」，带跳回上文的按钮。
  ask_user: {
    desktop: QuestionRecord,
  },
  // 子对话里的 ask_parent：一问一答两个气泡（不是工具卡）。
  ask_parent: {
    desktop: AskParentExchange,
  },
};

/** 这个工具的专属 view 是否需要滚出视口后保活（见 `ToolViewEntry.retain`）。 */
export function isRetainedToolView(toolName: string): boolean {
  return TOOL_VIEWS[toolName]?.retain === true;
}

export function getToolView(
  toolName: string,
  mobile = isMobilePlatform(collectPlatformHints()),
): ComponentType<ToolViewProps> | undefined {
  const entry = TOOL_VIEWS[toolName];
  if (!entry) return undefined;
  return mobile ? (entry.mobile ?? entry.desktop) : entry.desktop;
}
