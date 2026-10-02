import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { parseMarkdown } from './markdownProcessor';
import { markdownRemarkPlugins, markdownRehypePlugins } from './markdownPlugins';

function synchronous(text: string) {
  return renderToStaticMarkup(<Markdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins}>{text}</Markdown>);
}
function compiled(text: string) {
  const tree = parseMarkdown(text);
  return renderToStaticMarkup(<Markdown rehypePlugins={[() => () => tree]} />);
}

describe('worker Markdown parity and safety', () => {
  it.each([
    '',
    '# Title\n\n**Bold** and `code`.\n\n- one\n- two',
    '| A | B |\n| - | - |\n| 1 | 2 |',
    '```typescript\nconst answer = 42;\n```\n\n$$E = mc^2$$',
    '```js\nconst unfinished = ',
    '$$\\frac{1',
    '[reference][id]\n\n[id]: https://example.com "Title"',
    '- [x] task\n\n~~deleted~~ https://example.com',
    '<script>alert(1)</script>\n<img src=x onerror=alert(1)>',
    '[bad](javascript:alert%281%29) ![bad](data:text/html,x)',
    '[bad](vbscript:bad) [ok](https://example.com) [mail](mailto:a@example.com)',
    '$\\href{javascript:alert(1)}{bad}$',
  ])('matches the existing renderer for %j', (text) => {
    expect(compiled(text)).toBe(synchronous(text));
  });

  it('escapes raw HTML and retains react-markdown URL filtering', () => {
    const output = compiled('<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)');
    expect(output).not.toContain('<script>');
    expect(output).toContain('&lt;script&gt;');
    expect(output).not.toContain('href="javascript:');
  });
});
