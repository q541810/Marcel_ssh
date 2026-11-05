import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@/lib/types";
import { getToolView } from "./toolViews";
// 路径芯片会带进会话 store → 终端管理器（xterm 需要浏览器环境），测试里不需要真的终端
vi.mock('@/components/terminal/TerminalInstanceManager', () => ({ terminalInstanceManager: { get: () => undefined } }));

function toolMessage(
  id: string,
  toolName: string,
  overrides: Partial<AgentMessage> = {},
): AgentMessage {
  return {
    id,
    role: "tool",
    content: "",
    timestamp: "",
    toolResult: {
      toolName,
      summary: "",
      result: "",
      success: true,
      blocked: false,
      arguments: {},
      toolCallId: id,
    },
    ...overrides,
  };
}

describe("toolViews", () => {
  it("旧会话里的 present_file / local_present_file（工具已移除）没有专属 view，回退到通用工具卡", () => {
    for (const name of ["present_file", "local_present_file"]) {
      expect(getToolView(name, false)).toBeUndefined();
      expect(getToolView(name, true)).toBeUndefined();
    }
  });

  it("gives render_html its own mobile view while ordinary tools fall back", () => {
    const desktopView = getToolView("render_html", false);
    const mobileView = getToolView("render_html", true);

    expect(desktopView).toBeDefined();
    expect(mobileView).toBeDefined();
    // 手机端有专属容器（一屏封顶 + 全屏查看），不与桌面共用同一个组件。
    expect(mobileView).not.toBe(desktopView);
    expect(getToolView("render_html", true)).toBe(mobileView);
    expect(getToolView("execute_command", false)).toBeUndefined();
    expect(getToolView("execute_command", true)).toBeUndefined();
  });

  it("dedicated visualization view is independent of inline/wide width hints", () => {
    const inline = toolMessage("inline", "render_html");
    const wide = toolMessage("wide", "render_html", {
      toolResult: {
        ...toolMessage("base", "render_html").toolResult!,
        arguments: { mode: "wide" },
      },
    });
    for (const mobile of [false, true]) {
      expect(getToolView(inline.toolResult!.toolName, mobile)).toBe(
        getToolView(wide.toolResult!.toolName, mobile),
      );
    }
  });
});
