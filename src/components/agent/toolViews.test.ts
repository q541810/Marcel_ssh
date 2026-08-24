import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@/lib/types";
import { getToolView } from "./toolViews";

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
  it("uses platform-specific render_html views while ordinary tools fall back", () => {
    const desktopView = getToolView("render_html", false);
    const mobileView = getToolView("render_html", true);

    expect(desktopView).toBeDefined();
    expect(mobileView).toBeDefined();
    expect(mobileView).not.toBe(desktopView);
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
    expect(getToolView(inline.toolResult!.toolName, false)).toBe(
      getToolView(wide.toolResult!.toolName, false),
    );
  });
});
