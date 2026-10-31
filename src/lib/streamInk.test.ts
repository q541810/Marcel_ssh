import { describe, expect, it } from 'vitest';
import { appendStreamingTail, inkTextLength, wrapInkRange, type InkNode } from './streamInk';

const text = (value: string): InkNode => ({ type: 'text', value });
const el = (tagName: string, children: InkNode[], properties: Record<string, unknown> = {}): InkNode => ({
  type: 'element',
  tagName,
  properties,
  children,
});
const root = (children: InkNode[]): InkNode => ({ type: 'root', children });

function inkSpans(node: InkNode): { text: string; cls: string }[] {
  const out: { text: string; cls: string }[] = [];
  const walk = (n: InkNode) => {
    const cls = n.properties?.className;
    if (Array.isArray(cls) && cls.some((c) => c === 'ink-a' || c === 'ink-b')) {
      out.push({
        text: (n.children ?? []).map((c) => c.value ?? '').join(''),
        cls: (cls as string[]).find((c) => c === 'ink-a' || c === 'ink-b') ?? '',
      });
      return;
    }
    (n.children ?? []).forEach(walk);
  };
  walk(node);
  return out;
}

describe('inkTextLength', () => {
  it('按码点计数，中文 / emoji 都算一个字', () => {
    expect(inkTextLength(text('你好abc'))).toBe(5);
    expect(inkTextLength(text('🙂🙂'))).toBe(2);
    expect(inkTextLength(el('p', [text('ab'), el('strong', [text('cd')])]))).toBe(4);
  });
});

describe('wrapInkRange', () => {
  it('只包指定区间，区间外保持纯文本，并顺带返回总长度', () => {
    const tree = root([el('p', [text('前面静止')])]);
    const result = wrapInkRange(tree, { start: 2, end: 4 });
    expect(result.length).toBe(4);
    expect(inkSpans(result.tree)).toEqual([{ text: '静止', cls: 'ink-a' }]);
  });

  it('一段字只包一层 span（不是逐字）', () => {
    const tree = root([el('p', [text('一二三四五六七八九十')])]);
    const spans = inkSpans(wrapInkRange(tree, { start: 0, end: 10 }).tree);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('一二三四五六七八九十');
  });

  it('even=false 用另一个动画名（交替以便重新起播）', () => {
    const tree = root([el('p', [text('ab')])]);
    expect(inkSpans(wrapInkRange(tree, { start: 0, end: 2 }, false).tree)[0].cls).toBe('ink-b');
  });

  it('不拆 code / a / katex 子树，但照常推进计数', () => {
    const tree = root([
      el('p', [text('看'), el('code', [text('const x')]), text('结尾')]),
      el('span', [text('E=mc2')], { className: ['katex'] }),
    ]);
    const result = wrapInkRange(tree, { start: 0, end: 99 });
    const spans = inkSpans(result.tree);
    expect(spans.map((s) => s.text).join('')).toBe('看结尾');
    expect(result.length).toBe(15);
  });

  it('结构共享：没被动画覆盖的子树保持同一引用', () => {
    const kept = el('h2', [text('标题')]);
    const tree = root([kept, el('p', [text('正文正文')])]);
    const result = wrapInkRange(tree, { start: 2, end: 4 });
    expect((result.tree as InkNode).children?.[0]).toBe(kept);
    expect((result.tree as InkNode).children?.[1]).not.toBe(tree.children?.[1]);
  });

  it('range=null 时只量长度、不包 span，并保持引用不变', () => {
    const tree = root([el('p', [text('短')])]);
    const result = wrapInkRange(tree, null);
    expect(result.tree).toBe(tree);
    expect(result.length).toBe(1);
  });
});

describe('appendStreamingTail', () => {
  it('把未解析的尾巴接进最后一个文本节点，只克隆尾路径', () => {
    const kept = el('h2', [text('标题')]);
    const tree = root([kept, el('p', [text('前缀')])]);
    const result = appendStreamingTail(tree, '新字');
    expect(result.children?.[0]).toBe(kept);
    expect(result.children?.[1]).not.toBe(tree.children?.[1]);
    expect(inkTextLength(result)).toBe(6);
    expect(inkTextLength(tree)).toBe(4);
  });

  it('没有文本节点时补一个段落，空尾巴保持引用', () => {
    const tree = root([]);
    expect(appendStreamingTail(tree, '')).toBe(tree);
    expect(inkTextLength(appendStreamingTail(tree, '新'))).toBe(1);
  });

  it('尾巴接在墨晕 span 外面，不并进动画节点（否则下一拍不会重播）', () => {
    const inked = wrapInkRange(root([el('p', [text('旧字')])]), { start: 0, end: 2 }).tree;
    const next = appendStreamingTail(inked, '新尾巴');
    expect(inkSpans(next)).toEqual([{ text: '旧字', cls: 'ink-a' }]);
    expect(inkTextLength(next)).toBe(5);
    expect(inkTextLength(inked)).toBe(2);
  });
});
