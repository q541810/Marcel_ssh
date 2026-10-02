import { parseMarkdown, type MarkdownRequest, type MarkdownResponse } from './markdownProcessor';

const scope = self as unknown as {
  onmessage: (event: MessageEvent<MarkdownRequest>) => void;
  postMessage: (message: MarkdownResponse) => void;
};
scope.onmessage = ({ data }) => {
  try {
    scope.postMessage({ id: data.id, tree: parseMarkdown(data.text) });
  } catch {
    // Never echo conversation content or parser diagnostics through error logs.
    scope.postMessage({ id: data.id, error: true });
  }
};
