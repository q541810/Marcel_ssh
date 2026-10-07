import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { markdownRehypePlugins, markdownRemarkPlugins } from './markdownPlugins';

// Match react-markdown's pipeline. Raw HTML stays a raw node, never executable HTML.
const processor = unified()
  .use(remarkParse)
  .use(markdownRemarkPlugins)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(markdownRehypePlugins)
  .freeze();

export function parseMarkdown(text: string) {
  // runSync 必须显式带上 file：transformer（如 autolinkRepair）要从 file.value
  // 读原文；只传树的话 file 是空的，插件会被静默跳过。
  return processor.runSync(processor.parse(text), text);
}

export type MarkdownTree = ReturnType<typeof parseMarkdown>;
export interface MarkdownRequest { id: number; text: string }
export type MarkdownResponse = { id: number; tree: MarkdownTree } | { id: number; error: true };
