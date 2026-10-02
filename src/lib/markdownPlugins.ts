import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';

// Shared by the worker and the synchronous fallback; security/formatting must not diverge.
export const markdownRemarkPlugins: PluggableList = [remarkGfm, remarkMath];
export const markdownRehypePlugins: PluggableList = [
  rehypeHighlight,
  [rehypeKatex, { errorColor: '#f87171' }],
];
