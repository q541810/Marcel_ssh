import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import type { PluggableList } from 'unified';
import { markdownRemarkPlugins, markdownRehypePlugins } from '@/lib/markdownPlugins';
import { normalizeMathDelimiters } from '@/lib/mathDelimiters';
import { markdownRenderManager } from '@/lib/markdownRenderManager';
import type { MarkdownTree } from '@/lib/markdownProcessor';
import { openExternalLink } from '@/lib/externalLinks';
import { appendStreamingTail, inkTextLength, wrapInkRange, type InkRange } from '@/lib/streamInk';
import { MarkdownVisibility } from './markdownVisibility';
import CodeBlock from './CodeBlock';

const components: Components = {
  pre: CodeBlock,
  a: ({ href, children, node: _node, ...props }) => (
    <a {...props} href={href} onClick={(event) => {
      event.preventDefault();
      if (href) openExternalLink(href);
    }}>{children}</a>
  ),
};

/** Keep react-markdown's HTML escaping and URL filtering for worker-produced trees too. */
const CompiledMarkdown = memo(function CompiledMarkdown({ tree }: { tree: MarkdownTree }) {
  const plugins = useMemo<PluggableList>(() => [() => () => tree], [tree]);
  return <Markdown rehypePlugins={plugins} components={components} />;
});

const SynchronousMarkdown = memo(function SynchronousMarkdown({ content }: { content: string }) {
  return <Markdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={components}>
    {normalizeMathDelimiters(content)}
  </Markdown>;
});

type Rendered = { tree: MarkdownTree; source: string; ink: InkRange | null; even: boolean };

/**
 * `sync`：不经 worker、当帧直接渲染。短文本、会反复重挂载的场景（设置页里的整理助手）用它，
 * 免得每次挂载先露一帧未渲染的原文、再换成排版后的样子（一闪）；长对话列表保持默认的异步渲染。
 *
 * `live`：这条消息正在被流式写入（调用方只给尾部那条消息传）。只有 live 时才给新到的字挂晕染；
 * 历史消息重挂载永远静止，不会「整段重新长一遍」。到达多少就显示多少——不做任何显示限速。
 */
export default memo(function MarkdownBody({
  content,
  sync = false,
  live = false,
}: {
  content: string;
  sync?: boolean;
  live?: boolean;
}) {
  const visible = useContext(MarkdownVisibility);
  const owner = useRef(Symbol('markdown'));
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [fallback, setFallback] = useState(() => typeof Worker === 'undefined');
  /** 上一次交付的原文与渲染字符数：两者之差就是「这次新到的字」。 */
  const lastSource = useRef('');
  const lastLength = useRef(0);
  const liveRef = useRef(live);
  liveRef.current = live;
  const parity = useRef(0);

  useEffect(() => {
    if (fallback || sync || !visible) return;
    return markdownRenderManager.request(owner.current, content, (tree, source) => {
      if (!tree) {
        setFallback(true);
        return;
      }
      const length = inkTextLength(tree);
      const previousSource = lastSource.current;
      const previousLength = lastLength.current;
      lastSource.current = source;
      lastLength.current = length;
      const appended = previousSource.length > 0
        && source.length > previousSource.length
        && source.startsWith(previousSource);
      // 只给这一批新到的字挂晕染；不是追加（或不是直播消息）就整棵静止。
      const ink = liveRef.current && appended && length > previousLength
        ? { start: previousLength, end: length }
        : null;
      if (ink) parity.current += 1;
      setRendered({ tree, source, ink, even: parity.current % 2 === 0 });
    });
  }, [content, fallback, sync, visible]);

  // 墨晕树只跟「已解析的那份快照」变：每次重算会把 span 拆了重建，
  // 复用到的新 span 元素若 class 没变就不会重新起播，看起来就是「晕染没了」。
  const inked = useMemo(
    () => (rendered?.ink ? wrapInkRange(rendered.tree, rendered.ink, rendered.even).tree : rendered?.tree ?? null),
    [rendered],
  );

  // 解析还没追上的尾巴接在墨晕之后：只克隆尾路径，整棵树其余部分保持原引用。
  const tree = useMemo(() => {
    if (!inked || !rendered || !content.startsWith(rendered.source)) return null;
    return appendStreamingTail(inked, content.slice(rendered.source.length));
  }, [inked, rendered, content]);

  if (fallback || sync) {
    return <SynchronousMarkdown content={content} />;
  }
  if (tree) return <CompiledMarkdown tree={tree} />;
  return <div className="whitespace-pre-wrap">{content}</div>;
});
