import { describe, expect, it } from "vitest";
import {
  buildSettledVisualizationDoc,
  buildStreamingVisualizationDoc,
  HTML_VIZ_CSP,
  HTML_VIZ_STREAM_MESSAGE,
  trimIncompleteStreamingScript,
  type HtmlVisualizationTheme,
} from "./htmlVisualization";

const theme: HtmlVisualizationTheme = {
  background: "#18181b",
  surface: "#27272a",
  text: "#f4f4f5",
  muted: "#a1a1aa",
  border: "#52525b",
  accent: "#818cf8",
  accentText: "#ffffff",
  colorScheme: "dark",
};

describe("htmlVisualization shell", () => {
  it("settled document supplies CSP, theme and fragment", () => {
    const doc = buildSettledVisualizationDoc(
      "<section>hello</section>",
      "Demo",
      theme,
      "call-1",
    );
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("<section>hello</section>");
    expect(doc).toContain("--marcel-viz-accent: #818cf8");
    expect(doc).toContain("--viz-series-1: var(--primary)");
    expect(doc).toContain(".viz-controls");
    expect(doc).toContain(".form-control");
    expect(doc).toContain("--marcel-viz-background: #18181b");
    expect(doc).toContain("background: var(--background) !important");
    expect(doc).toContain("background-color: var(--background) !important");
    expect(doc).toContain("var height = body ? body.scrollHeight : 0");
    expect(doc).not.toContain("Math.max(document.documentElement.scrollHeight");
    expect(doc).toContain("call-1");
  });

  it("installs height reporting before fragment scripts during replay", () => {
    const fragment =
      '<section>visible</section><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js"></script>';
    const doc = buildSettledVisualizationDoc(
      fragment,
      "Replay",
      theme,
      "replay-1",
    );
    const reporterAt = doc.indexOf("marcel-html-viz:height");
    const externalScriptAt = doc.indexOf("chart.js@4.4.1");
    expect(reporterAt).toBeGreaterThan(-1);
    expect(externalScriptAt).toBeGreaterThan(reporterAt);
  });

  it("CSP blocks active network APIs, forms and nested frames", () => {
    expect(HTML_VIZ_CSP).toContain("default-src 'none'");
    expect(HTML_VIZ_CSP).toContain("connect-src blob: data:");
    expect(HTML_VIZ_CSP).toContain("frame-src 'none'");
    expect(HTML_VIZ_CSP).toContain("form-action 'none'");
    expect(HTML_VIZ_CSP).toContain("https://cdn.jsdelivr.net");
    expect(HTML_VIZ_CSP).not.toContain("connect-src https:");
  });

  it("streaming document is fragment-independent and contains reconcile runtime", () => {
    const doc = buildStreamingVisualizationDoc(theme, "stream-1");
    expect(doc).toContain("marcel-viz-stream-root");
    expect(doc).toContain(HTML_VIZ_STREAM_MESSAGE);
    expect(doc).toContain("current.appendChild(added)");
    expect(doc).toContain("sync(root, next)");
  });

  it("drops only a trailing incomplete script", () => {
    expect(
      trimIncompleteStreamingScript("<div>ready</div><script>const x ="),
    ).toBe("<div>ready</div>");
    expect(
      trimIncompleteStreamingScript("<div>ready</div><script>ok()</script>"),
    ).toBe("<div>ready</div><script>ok()</script>");
    expect(
      trimIncompleteStreamingScript("<style>.x{color:red}</style><div>x"),
    ).toBe("<style>.x{color:red}</style><div>x");
  });

  it("drops unsafe theme declarations instead of repairing them", () => {
    const doc = buildSettledVisualizationDoc(
      "<p>x</p>",
      "x",
      { ...theme, accent: "red; } body { display:none" },
      "x",
    );
    expect(doc).not.toContain("body { display:none");
  });
});
