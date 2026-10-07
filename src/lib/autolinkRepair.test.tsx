import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseMarkdown } from './markdownProcessor';
import { remarkRepairCjkAutolinks } from './autolinkRepair';

/** parseMarkdown（worker 路径）渲染出的 HTML。 */
function compiled(text: string) {
  const tree = parseMarkdown(text);
  return renderToStaticMarkup(<Markdown rehypePlugins={[() => () => tree]} />);
}

/** react-markdown 直接挂修复插件（市场详情面板的路径）渲染出的 HTML。 */
function marketStyle(text: string) {
  return renderToStaticMarkup(
    <Markdown remarkPlugins={[remarkGfm, remarkRepairCjkAutolinks]}>{text}</Markdown>,
  );
}

describe('修复 GFM 字面自动链接吞全角标点', () => {
  it('URL 包在 **加粗** 里且后面跟全角括号：加粗恢复、链接干净、被吞的字回到正文', () => {
    const html = compiled('访问地址：**https://feiyu.yegou.work/**（HTTP 会自动 301 跳转到 HTTPS）');
    expect(html).toContain(
      '<strong><a href="https://feiyu.yegou.work/">https://feiyu.yegou.work/</a></strong>',
    );
    expect(html).toContain('（HTTP 会自动 301 跳转到 HTTPS）');
    expect(html).not.toContain('**');
    expect(html).not.toContain('href="https://feiyu.yegou.work/**');
  });

  it('URL 后直接跟全角标点：链接在标点处截断，标点及其后内容留在正文', () => {
    for (const [text, tail] of [
      ['访问 https://example.com/（说明） 即可', '（说明） 即可'],
      ['访问 https://example.com/，后续内容', '，后续内容'],
      ['访问 https://example.com/。下一段', '。下一段'],
    ] as const) {
      const html = compiled(text);
      expect(html).toContain('<a href="https://example.com/">https://example.com/</a>');
      expect(html).toContain(tail);
      expect(html).not.toContain('href="https://example.com/%EF');
    }
  });

  it('括号配平的 URL 不被误裁（Wikipedia 词条形态），尾部的独立括号才裁', () => {
    const balanced = compiled('见 https://example.com/Go_(programming)（说明）');
    expect(balanced).toContain('href="https://example.com/Go_(programming)"');
    expect(balanced).toContain('（说明）');

    const stray = compiled('见 https://example.com/a)（说明）');
    expect(stray).toContain('href="https://example.com/a"');
    expect(stray).toContain(')（说明）');
  });

  it('URL 尾部的 GFM 边界标点（如句点）移回正文，不进链接', () => {
    const html = compiled('见 https://example.com/page.（说明）');
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('.（说明）');
  });

  it('www. 开头的字面链接：显示文本不带协议、目的地补协议', () => {
    const html = compiled('见 www.example.com/（说明）');
    expect(html).toContain('<a href="http://www.example.com/">www.example.com/</a>（说明）');
  });

  it('紧贴 URL 的 ! 只按正文渲染，不会被修复改写成图片语法', () => {
    const html = compiled('!https://example.com/（说明）');
    expect(html).not.toContain('<img');
    expect(html).toContain('<a href="https://example.com/">');
    expect(html).toContain('（说明）');
  });

  it('链接文本里的 URL 特殊字符经转义后原样可见（不与上下文跨边界配对）', () => {
    const html = compiled('见 **https://example.com/docs/*.html**（说明）');
    expect(html).toContain('href="https://example.com/docs/*.html"');
    expect(html).toContain('https://example.com/docs/*.html');
    expect(html).toContain('<strong>');
    expect(html).toContain('（说明）');
  });

  it('行内代码与代码块里的 URL 不受影响', () => {
    const inline = compiled('跑 `curl https://example.com/（注释）` 试试');
    expect(inline).toContain('<code>curl https://example.com/（注释）</code>');
    expect(inline).not.toContain('<a ');

    const block = compiled('```\ncurl https://example.com/（注释）\n```');
    expect(block).toContain('curl https://example.com/（注释）');
    expect(block).not.toContain('<a ');
  });

  it('作者显式写的 [text](全角 URL) 是本意，修复插件对其是纯粹的 no-op', () => {
    const text = '[文档](https://example.com/（a）)';
    const withoutRepair = renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>);
    expect(compiled(text)).toBe(withoutRepair);
  });

  it('尖括号自动链接本就不吞标点，保持不变', () => {
    const html = compiled('<https://example.com/>（说明）');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('（说明）');
  });

  it('邮箱字面链接本就不吞标点，保持不变', () => {
    const html = compiled('邮箱 a@b.com，后续内容');
    expect(html).toContain('href="mailto:a@b.com"');
    expect(html).toContain('，后续内容');
  });

  it('URL 未跟全角标点时完全不干预', () => {
    const html = compiled('见 https://example.com/page 后续');
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain(' 后续');
  });

  it('同一条消息里修复与数学公式互不干扰', () => {
    const html = compiled('地址 https://example.com/（说明）\n\n$E = mc^2$');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('（说明）');
    expect(html).toContain('mc^2');
  });

  it('表格单元格里的 URL 同样被修复', () => {
    const html = compiled('| 地址 |\n| --- |\n| https://example.com/（说明） |');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('（说明）');
  });

  it('加粗紧贴 URL 前面的形态也正常', () => {
    const html = compiled('**加粗**https://example.com/（说明）');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('（说明）');
  });

  it('worker 路径与 react-markdown 直挂插件路径产出一致', () => {
    for (const text of [
      '访问地址：**https://feiyu.yegou.work/**（HTTP 会自动 301 跳转到 HTTPS）',
      '访问 https://example.com/（说明） 即可',
      '见 www.example.com/（说明）',
      '!https://example.com/（说明）',
      '| 地址 |\n| --- |\n| https://example.com/（说明） |',
      // 数学用例不进 parity：worker 路径返回的 HAST 已烘焙 katex，而市场路径
      // 本来就不挂 katex——这个差异与本修复无关，由 markdownProcessor.test 锁。
    ]) {
      expect(compiled(text), text).toBe(marketStyle(text));
    }
  });
});
