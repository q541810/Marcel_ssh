import type { MarkdownRequest, MarkdownResponse, MarkdownTree } from './markdownProcessor';

interface ParserWorker {
  onmessage: ((event: MessageEvent<MarkdownResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage: (request: MarkdownRequest) => void;
  terminate: () => void;
}
interface Request extends MarkdownRequest {
  owner: symbol;
  deliver: (tree: MarkdownTree | null, source: string) => void;
}

/** One in-flight parse and one latest pending snapshot per mounted message. */
export class MarkdownRenderManager {
  private cache = new Map<string, MarkdownTree>();
  private cachedCharacters = 0;
  private worker: ParserWorker | null = null;
  private failed = false;
  private sequence = 0;
  private current = new Map<symbol, Request>();
  private pending = new Map<symbol, Request>();
  private running: Request | null = null;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly createWorker: () => ParserWorker) {}

  request(owner: symbol, text: string, deliver: Request['deliver']): () => void {
    clearTimeout(this.idle);
    const cached = this.cache.get(text);
    if (cached) {
      this.current.delete(owner);
      this.pending.delete(owner);
      this.cache.delete(text);
      this.cache.set(text, cached);
      deliver(cached, text);
      if (!this.current.size) this.idle = setTimeout(() => this.dispose(), 5000);
      return () => {};
    }
    if (this.failed) {
      deliver(null, text);
      return () => {};
    }
    const request = { owner, text, deliver, id: ++this.sequence };
    this.current.set(owner, request);
    this.pending.set(owner, request);
    this.pump();
    return () => {
      if (this.current.get(owner) !== request) return;
      this.current.delete(owner);
      this.pending.delete(owner);
      // An effect cleanup may be immediately followed by the next streamed snapshot.
      if (this.current.size === 0) this.idle = setTimeout(() => this.dispose(), 5000);
    };
  }

  dispose() {
    clearTimeout(this.idle);
    clearTimeout(this.timeout);
    this.worker?.terminate();
    this.worker = null;
    this.running = null;
    this.current.clear();
    this.pending.clear();
  }

  private fail() {
    const requests = [...this.current.values()];
    this.failed = true;
    this.dispose();
    requests.forEach((request) => request.deliver(null, request.text));
  }

  private pump() {
    if (this.running || this.pending.size === 0 || this.failed) return;
    if (!this.worker) {
      try {
        this.worker = this.createWorker();
        this.worker.onmessage = ({ data }) => this.receive(data);
        this.worker.onerror = (event) => { event.preventDefault(); this.fail(); };
        this.worker.onmessageerror = () => this.fail();
      } catch {
        this.fail();
        return;
      }
    }
    const next = this.pending.values().next().value as Request;
    this.pending.delete(next.owner);
    this.running = next;
    this.timeout = setTimeout(() => this.fail(), 15000);
    try {
      this.worker.postMessage({ id: next.id, text: next.text });
    } catch {
      this.fail();
    }
  }

  private receive(response: MarkdownResponse) {
    const running = this.running;
    if (!running || response.id !== running.id) return;
    clearTimeout(this.timeout);
    this.running = null;
    const latest = this.current.get(running.owner);
    // Append-only streams can display completed prefixes while the next snapshot parses.
    // Replacements/rollback must never resurrect an obsolete response.
    if (latest && (latest.text === running.text || latest.text.startsWith(running.text))) {
      // Keep only settled snapshots; virtual scrolling should not reparse recently read text.
      // Bound both entries and source size rather than retaining an entire conversation's ASTs.
      if ('tree' in response && latest.text === running.text && running.text.length <= 150000) {
        if (this.cache.has(running.text)) this.cachedCharacters -= running.text.length;
        this.cache.delete(running.text);
        this.cache.set(running.text, response.tree);
        this.cachedCharacters += running.text.length;
        while (this.cache.size > 24 || this.cachedCharacters > 150000) {
          const oldest = this.cache.keys().next().value!;
          this.cache.delete(oldest);
          this.cachedCharacters -= oldest.length;
        }
      }
      latest.deliver('tree' in response ? response.tree : null, running.text);
    }
    this.pump();
  }
}

export const markdownRenderManager = new MarkdownRenderManager(
  () => new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' }),
);
