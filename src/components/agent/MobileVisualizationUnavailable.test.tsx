import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MobileVisualizationUnavailable from "./MobileVisualizationUnavailable";

describe("MobileVisualizationUnavailable", () => {
  it("shows a desktop-only notice without loading visualization markup", () => {
    const html = renderToStaticMarkup(<MobileVisualizationUnavailable />);

    expect(html).toContain("交互可视化仅支持桌面端");
    expect(html).not.toContain("iframe");
  });
});
