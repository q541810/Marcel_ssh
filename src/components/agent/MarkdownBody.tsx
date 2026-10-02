import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import type { PluggableList } from 'unified';
import { markdownRemarkPlugins, markdownRehypePlugins } from '@/lib/markdownPlugins';
import { markdownRenderManager } from '@/lib/markdownRenderManager';
import type { MarkdownTree } from '@/lib/markdownProcessor';
import { openExternalLink } from '@/lib/externalLinks';
import { MarkdownVisibility } from './markdownVisibility';

const components: Components = {
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
    {content}
  </Markdown>;
});

export default memo(function MarkdownBody({ content }: { content: string }) {
  const visible = useContext(MarkdownVisibility);
  const owner = useRef(Symbol('markdown'));
  const [rendered, setRendered] = useState<{ tree: MarkdownTree; source: string } | null>(null);
  const [fallback, setFallback] = useState(() => typeof Worker === 'undefined');
  useEffect(() => {
    if (fallback || !visible) return;
    return markdownRenderManager.request(owner.current, content, (tree, source) => {
      if (tree) setRendered({ tree, source });
      else setFallback(true);
    });
  }, [content, fallback, visible]);

  if (fallback) {
    return <SynchronousMarkdown content={content} />;
  }
  return rendered && content.startsWith(rendered.source)
    ? <CompiledMarkdown tree={rendered.tree} />
    : <div className="whitespace-pre-wrap">{content}</div>;
});
