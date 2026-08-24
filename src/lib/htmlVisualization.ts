import type { AgentMessage } from "@/lib/types";

export type HtmlVisualizationMode = "inline" | "wide";

export interface HtmlVisualizationTheme {
  background: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentText: string;
  colorScheme: "light" | "dark";
}

const THEME_FALLBACKS: Omit<HtmlVisualizationTheme, "colorScheme"> = {
  background: "#18181b",
  surface: "rgb(255 255 255 / 6%)",
  text: "#f4f4f5",
  muted: "rgb(244 244 245 / 55%)",
  border: "rgb(255 255 255 / 12%)",
  accent: "#818cf8",
  accentText: "#ffffff",
};

export function resolveVisualizationTheme(): HtmlVisualizationTheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: keyof typeof THEME_FALLBACKS) =>
    style.getPropertyValue(`--marcel-viz-${name}`).trim() ||
    THEME_FALLBACKS[name];
  return {
    // The visualization shares the agent panel base color so the sandboxed
    // iframe never exposes a compositor fallback between document paints.
    background: read("background"),
    surface: read("surface"),
    text: read("text"),
    muted: read("muted"),
    border: read("border"),
    accent: read("accent"),
    accentText: read("accentText"),
    colorScheme:
      style.colorScheme.includes("light") && !style.colorScheme.includes("dark")
        ? "light"
        : "dark",
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function visualizationPresentation(message: AgentMessage) {
  const args = message.toolResult?.arguments ?? {};
  const meta = message.toolResult?.metadata ?? {};
  return {
    title: asString(meta.title) ?? asString(args.title) ?? "Visualization",
    fragment: asString(meta.fragment) ?? asString(args.fragment) ?? "",
    mode: (meta.mode === "wide" || args.mode === "wide"
      ? "wide"
      : "inline") as HtmlVisualizationMode,
    path: asString(meta.path),
  };
}

export const HTML_VIZ_HEIGHT_MESSAGE = "marcel-html-viz:height";
export const HTML_VIZ_STREAM_MESSAGE = "marcel-html-viz:stream";

const RESOURCE_ORIGINS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://esm.sh",
  "https://fonts.bunny.net",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://unpkg.com",
];

const RESOURCE_SOURCES = ["blob:", "data:", ...RESOURCE_ORIGINS].join(" ");

export const HTML_VIZ_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${RESOURCE_SOURCES}`,
  `style-src 'unsafe-inline' ${RESOURCE_SOURCES}`,
  `img-src ${RESOURCE_SOURCES}`,
  `font-src ${RESOURCE_SOURCES}`,
  `media-src ${RESOURCE_SOURCES}`,
  "worker-src blob:",
  "connect-src blob: data:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const BASE_CSS = `
:root {
  background: transparent !important;
  --background: var(--marcel-viz-background, transparent);
  --foreground: var(--marcel-viz-text, light-dark(rgb(26 28 31), rgb(240 242 245)));
  --card: var(--marcel-viz-surface, light-dark(rgb(0 0 0 / 4%), rgb(255 255 255 / 6%)));
  --card-foreground: var(--foreground);
  --muted-foreground: var(--marcel-viz-muted, light-dark(rgb(26 28 31 / 55%), rgb(240 242 245 / 55%)));
  --border: var(--marcel-viz-border, light-dark(rgb(0 0 0 / 10%), rgb(255 255 255 / 12%)));
  --primary: var(--marcel-viz-accent, light-dark(rgb(99 102 241), rgb(129 140 248)));
  --primary-foreground: var(--marcel-viz-accentText, white);
  --viz-series-1: var(--primary);
  --viz-series-2: light-dark(rgb(226 116 26), rgb(245 152 66));
  --viz-series-3: light-dark(rgb(16 148 82), rgb(72 196 130));
  --viz-series-4: light-dark(rgb(146 94 220), rgb(176 132 240));
  --viz-series-5: light-dark(rgb(212 66 84), rgb(240 110 126));
  --viz-series-6: light-dark(rgb(160 138 22), rgb(206 182 70));
  --radius: 8px;
  --font-size-base: 14px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--background) !important; background-color: var(--background) !important; }
body { color: var(--foreground); font: 400 var(--font-size-base)/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; overflow-x: hidden; }
h1, h2, h3 { margin: 0 0 .5em; font-weight: 500; line-height: 1.3; }
h1 { font-size: 1.3em; } h2 { font-size: 1.15em; } h3 { font-size: 1em; }
p { margin: 0 0 .75em; } a { color: var(--primary); }
canvas, svg, img, video { max-width: 100%; }
svg text { fill: var(--foreground); font-size: 12px; }
.text-small { font-size: 12px; color: var(--muted-foreground); }
.card { background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
.btn { appearance: none; display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: transparent; color: var(--foreground); font: inherit; cursor: pointer; transition: transform 100ms ease-out, background-color 180ms ease-out, color 180ms ease-out, border-color 180ms ease-out; }
.btn:hover { background: color-mix(in oklab, var(--foreground) 6%, transparent); }
.btn:active { transform: scale(.975); }
.btn-primary, .btn[aria-pressed='true'], .btn[aria-selected='true'], .btn.is-selected { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.btn-ghost { border-color: transparent; } .btn:disabled { opacity: .5; cursor: default; }
.viz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.viz-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.viz-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin-bottom: 12px; }
.viz-stat .viz-stat-label, .viz-stat > :first-child { font-size: 12px; color: var(--muted-foreground); }
.viz-stat-value { font-size: 1.4em; font-weight: 500; line-height: 1.2; }
.viz-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; background: color-mix(in oklab, var(--primary) 14%, transparent); color: var(--primary); font-size: 12px; }
.form-label { display: block; font-size: 12px; color: var(--muted-foreground); margin-bottom: 4px; }
.form-control, .form-select { width: 100%; padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: transparent; color: var(--foreground); font: inherit; }
.form-check { display: flex; align-items: center; gap: 6px; } .form-check input, input[type='range'] { accent-color: var(--primary); }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--border); }
th { font-weight: 500; color: var(--muted-foreground); font-size: 12px; } .table-responsive { overflow-x: auto; }
`;

function safeCssValue(value: string): string {
  const trimmed = value.trim();
  return /[;{}<>]/u.test(trimmed) ? "" : trimmed;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function themeCss(theme: HtmlVisualizationTheme): string {
  const vars = Object.entries(theme)
    .filter(([name]) => name !== "colorScheme")
    .map(([name, value]) => `--marcel-viz-${name}: ${safeCssValue(value)};`)
    .join(" ");
  return `:root { ${vars} color-scheme: ${theme.colorScheme}; }`;
}

function heightReporter(token: string): string {
  return `
(function () {
  var token = ${JSON.stringify(token)};
  var last = -1;
  function report() {
    // documentElement.scrollHeight includes the iframe viewport itself in
    // Chromium/WebView2. body.scrollHeight tracks the actual fragment and
    // can shrink again after a streaming update.
    var body = document.body;
    var height = body ? body.scrollHeight : 0;
    if (height === last) return;
    last = height;
    parent.postMessage({ type: ${JSON.stringify(HTML_VIZ_HEIGHT_MESSAGE)}, token: token, height: height }, '*');
  }
  var observer = new ResizeObserver(report);
  if (document.body) observer.observe(document.body);
  addEventListener('load', report);
  report();
})();`;
}

function documentShell(
  title: string,
  theme: HtmlVisualizationTheme,
  body: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${HTML_VIZ_CSP}">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}${themeCss(theme)}</style>
</head>
<body>${body}</body>
</html>`;
}

export function buildSettledVisualizationDoc(
  fragment: string,
  title: string,
  theme: HtmlVisualizationTheme,
  token: string,
): string {
  return documentShell(
    title,
    theme,
    // Install height reporting before parsing model-authored markup. External
    // scripts inside the fragment can block the HTML parser while loading;
    // placing the reporter after them left replayed frames stuck at 48px and
    // made the persisted visualization look missing after app restart.
    `<script>${heightReporter(token)}</script>${fragment}`,
  );
}

function streamRuntime(token: string): string {
  return `
(function () {
  var root = document.getElementById('marcel-viz-stream-root');
  var token = ${JSON.stringify(token)};
  function syncAttrs(current, next) {
    for (var i = current.attributes.length - 1; i >= 0; i--) {
      var name = current.attributes[i].name;
      if (!next.hasAttribute(name)) current.removeAttribute(name);
    }
    for (var j = 0; j < next.attributes.length; j++) {
      var attr = next.attributes[j];
      if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    }
  }
  function executable(node) {
    var script = document.createElement('script');
    for (var i = 0; i < node.attributes.length; i++) {
      script.setAttribute(node.attributes[i].name, node.attributes[i].value);
    }
    script.textContent = node.textContent;
    return script;
  }
  function sync(current, next) {
    var wanted = next.childNodes;
    for (var i = 0; i < wanted.length; i++) {
      var target = wanted[i];
      var live = current.childNodes[i];
      if (!live) {
        var added = target.nodeName === 'SCRIPT' ? executable(target) : target.cloneNode(true);
        if (added.nodeType === 1 && added.nodeName !== 'SCRIPT' && added.nodeName !== 'STYLE') {
          added.classList.add('marcel-viz-enter');
        }
        current.appendChild(added);
        continue;
      }
      if (live.nodeType !== target.nodeType || live.nodeName !== target.nodeName) {
        current.replaceChild(target.nodeName === 'SCRIPT' ? executable(target) : target.cloneNode(true), live);
        continue;
      }
      if (live.nodeType === 3 || live.nodeType === 8) {
        if (live.nodeValue !== target.nodeValue) live.nodeValue = target.nodeValue;
        continue;
      }
      if (live.nodeType === 1 && live.nodeName !== 'SCRIPT') {
        syncAttrs(live, target);
        sync(live, target);
      }
    }
    while (current.childNodes.length > wanted.length) current.removeChild(current.lastChild);
  }
  addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== ${JSON.stringify(HTML_VIZ_STREAM_MESSAGE)} || data.token !== token) return;
    if (typeof data.fragment !== 'string') return;
    var next = document.createElement('div');
    next.innerHTML = data.fragment;
    sync(root, next);
  });
})();`;
}

export function buildStreamingVisualizationDoc(
  theme: HtmlVisualizationTheme,
  token: string,
): string {
  return documentShell(
    "Streaming visualization",
    theme,
    `<script>${heightReporter(token)}</script>
<div id="marcel-viz-stream-root"></div>
<style>
.marcel-viz-enter { animation: marcel-viz-enter .32s cubic-bezier(.2,.7,.3,1) both; }
@keyframes marcel-viz-enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
</style>
<script>${streamRuntime(token)}</script>`,
  );
}

const LAST_SCRIPT_OPEN = /<script\b[^>]*>?(?![\s\S]*<script\b)/iu;

/** Drop a trailing half-generated script; complete scripts run once when appended. */
export function trimIncompleteStreamingScript(fragment: string): string {
  const opener = LAST_SCRIPT_OPEN.exec(fragment);
  if (!opener) return fragment;
  const rest = fragment.slice(opener.index + opener[0].length);
  return /<\/script\s*>/iu.test(rest)
    ? fragment
    : fragment.slice(0, opener.index);
}
