import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Plugin, Transformer } from 'unified';

/**
 * GFM 字面自动链接吞全角标点的修复。
 *
 * micromark-extension-gfm-autolink-literal 的裸 URL 只在 EOF 与空白处结束，
 * 全角标点（，。（）等）被当作 URL 字符吞掉，一路吃到下一个 ASCII 空白——中文
 * 输出里 URL 后直接跟标点是常态，链接因此大面积损坏；若 URL 还包在 `**加粗**`
 * 里，闭合 ** 被吞进链接，加粗配不上对、开头的 ** 裸露成字面文本。
 *
 * 修法是「解析 → 定点改写源码 → 重解析」：解析后按被污染链接的 position 定位
 * 源码区间，在首个全角标点处截断、按 GFM 规则把 URL 尾部的 ASCII 标点移回正文，
 * 改写成显式链接语法（`[url](<url>)`）再解析一遍——显式链接让加粗边界自然恢复
 * 配对（`**<https://x/>**（说明）`）。检测基于第一遍解析结果，所以行内代码、
 * 代码块与作者显式写的 `[text](url)` 天然不在修复范围；截断只认全角标点，
 * URL 路径里的 CJK 字符（如百科词条）原样保留。
 */

/** 触发截断的全角标点。只收中文正文里会紧跟 URL 的标点，宁缺勿滥。 */
const CJK_PUNCT = /[、。，：；！？（）【】《》「」『』〔〕｛｝～…—·]/;

/** GFM 会从 URL 尾部裁掉的 ASCII 标点（与 autolink-literal 的 trail 清单一致）。 */
const URL_TRAIL = new Set(['!', '"', "'", '*', ',', '.', ':', ';', '?', '_', '~']);

interface SourceEdit {
  start: number;
  end: number;
  value: string;
}

interface MdastLink {
  type: string;
  url: string;
  children: Array<{ type: string; value?: string }>;
  position?: { start: { offset?: number }; end: { offset?: number } };
}
type MdastNode = { type: string; children?: MdastNode[] };

function repairEdit(source: string, start: number, end: number): SourceEdit | null {
  const raw = source.slice(start, end);
  const cut = raw.search(CJK_PUNCT);
  if (cut <= 0) return null;
  let prefix = raw.slice(0, cut);
  let tail = raw.slice(cut);
  // 截断后 prefix 尾部的这些 ASCII 标点属于「边界尾巴」而不是 URL，移回正文
  // （`**` 因此回到文本层，加粗得以恢复配对）。
  for (;;) {
    const last = prefix.slice(-1);
    if (last === ')') {
      const opens = (prefix.match(/\(/g) ?? []).length;
      const closes = (prefix.match(/\)/g) ?? []).length;
      // 括号已配平 → 这个 ) 是 URL 的一部分（如 Wikipedia 词条），不裁
      if (closes <= opens) break;
    } else if (last === ';') {
      // 字符引用（&amp; 之类）整体移回，其余 ; 是 URL 的一部分
      if (!/&[A-Za-z0-9]+$/.test(prefix)) break;
      const ampersand = prefix.lastIndexOf('&');
      tail = `${prefix.slice(ampersand)}${tail}`;
      prefix = prefix.slice(0, ampersand);
      continue;
    } else if (!URL_TRAIL.has(last)) {
      break;
    }
    tail = `${last}${tail}`;
    prefix = prefix.slice(0, -1);
    if (!prefix) return null;
  }
  // 这些字符若不转义，链接文本会与上下文配对（外层 **、代码反引号等）
  const text = prefix.replace(/[`*~[\]\\]/g, '\\$&');
  // www. 开头的字面链接渲染时没有协议，目的地补上；尖括号目的地让括号免转义
  const destination = prefix.startsWith('www.') ? `http://${prefix}` : prefix;
  // 紧贴的 ! 会被读成图片语法，一并转义
  const bang = source[start - 1] === '!';
  return {
    start: bang ? start - 1 : start,
    end,
    value: `${bang ? '\\!' : ''}[${text}](<${destination}>)${tail}`,
  };
}

function collectEdits(source: string, node: MdastNode, edits: SourceEdit[]): void {
  if (node.type === 'link') {
    const link = node as unknown as MdastLink;
    const start = link.position?.start.offset;
    const end = link.position?.end.offset;
    // 邮箱字面链接不吞全角标点，不参与；显式 [text](url) 的文本 ≠ url，也不会命中
    if (
      typeof start === 'number' &&
      typeof end === 'number' &&
      link.url.startsWith('http') &&
      link.children.length === 1 &&
      link.children[0].type === 'text' &&
      (link.children[0].value === link.url || link.url === `http://${link.children[0].value}`) &&
      link.children[0].value !== undefined &&
      CJK_PUNCT.test(link.children[0].value)
    ) {
      const edit = repairEdit(source, start, end);
      if (edit) edits.push(edit);
    }
  }
  for (const child of node.children ?? []) collectEdits(source, child, edits);
}

// 重解析用的裸管线：不带本修复（否则递归），但要与主管线同源的解析构造
// （GFM + 数学），否则修复过的消息里表格/公式会退化为纯文本。
const reparseSource = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();

export const remarkRepairCjkAutolinks: Plugin<[]> = () => {
  const transformer: Transformer = (tree, file) => {
    const source = String(file.value);
    if (!CJK_PUNCT.test(source)) return undefined;
    const edits: SourceEdit[] = [];
    collectEdits(source, tree as MdastNode, edits);
    if (edits.length === 0) return undefined;
    let repaired = source;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      repaired = repaired.slice(0, edit.start) + edit.value + repaired.slice(edit.end);
    }
    return reparseSource.runSync(reparseSource.parse(repaired));
  };
  return transformer;
};
