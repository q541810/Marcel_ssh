import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import type { PluggableList } from 'unified';
import { markdownRemarkPlugins, markdownRehypePlugins } from '@/lib/markdownPlugins';
import { normalizeMathDelimiters } from '@/lib/mathDelimiters';
import { markdownRenderManager } from '@/lib/markdownRenderManager';
import type { MarkdownTree } from '@/lib/markdownProcessor';
import { openExternalLink } from '@/lib/externalLinks';
import { MarkdownVisibility } from './markdownVisibility';
import { parseFileLink } from '@/lib/fileLink';
import CodeBlock from './CodeBlock';
import FileLinkChip from './FileLinkChip';

const components: Components = {
  pre: CodeBlock,
  a: ({ href, children, node: _node, ...props }) => {
    // agent 用 `remote:` / `local:` 链接指向它碰过的文件：渲染成可点的路径芯片，其余协议走外链
    const file = parseFileLink(href);
    if (file) return <FileLinkChip file={file} label={children} />;
    return (
      <a {...props} href={href} onClick={(event) => {
        event.preventDefault();
        if (href) openExternalLink(href);
      }}>{children}</a>
    );
  },
};

/**
 * react-markdown 默认只放行 http(s)/mailto 等协议，其余一律清成空串——`remote:` / `local:`
 * 也会被清掉。这两种协议由 `a` 组件接管成路径芯片（永远不会作为 href 交给浏览器），
 * 所以放行它们；其它协议仍走默认过滤。
 */
function urlTransform(url: string): string {
  return /^(remote|local):/i.test(url.trim()) ? url : defaultUrlTransform(url);
}

/** Keep react-markdown's HTML escaping and URL filtering for worker-produced trees too. */
const CompiledMarkdown = memo(function CompiledMarkdown({ tree }: { tree: MarkdownTree }) {
  const plugins = useMemo<PluggableList>(() => [() => () => tree], [tree]);
  return <Markdown rehypePlugins={plugins} components={components} urlTransform={urlTransform} />;
});

const SynchronousMarkdown = memo(function SynchronousMarkdown({ content }: { content: string }) {
  return <Markdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={components} urlTransform={urlTransform}>
    {normalizeMathDelimiters(content)}
  </Markdown>;
});

/**
 * `sync`：不经 worker、当帧直接渲染。短文本、会反复重挂载的场景（设置页里的整理助手）用它，
 * 免得每次挂载先露一帧未渲染的原文、再换成排版后的样子（一闪）；长对话列表保持默认的异步渲染。
 */
export default memo(function MarkdownBody({ content, sync = false }: { content: string; sync?: boolean }) {
  const visible = useContext(MarkdownVisibility);
  const owner = useRef(Symbol('markdown'));
  const [rendered, setRendered] = useState<{ tree: MarkdownTree; source: string } | null>(null);
  const [fallback, setFallback] = useState(() => typeof Worker === 'undefined');
  useEffect(() => {
    if (fallback || sync || !visible) return;
    return markdownRenderManager.request(owner.current, content, (tree, source) => {
      if (tree) setRendered({ tree, source });
      else setFallback(true);
    });
  }, [content, fallback, sync, visible]);

  if (fallback || sync) {
    return <SynchronousMarkdown content={content} />;
  }
  return rendered && content.startsWith(rendered.source)
    ? <CompiledMarkdown tree={rendered.tree} />
    : <div className="whitespace-pre-wrap">{content}</div>;
});
