// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const items: ContextMenuItem[] = [
  { label: '复制最后一条回复', description: '只复制模型说的最后一段话', onClick: vi.fn() },
  { label: '复制整个任务', description: '含工具调用与返回，不含思考过程', onClick: vi.fn() },
];

async function render(props: Partial<React.ComponentProps<typeof ContextMenu>> = {}) {
  await act(async () => {
    root.render(<ContextMenu x={10} y={20} items={items} onClose={vi.fn()} {...props} />);
  });
  return document.body.querySelector('[role="menu"]') as HTMLElement;
}
const buttons = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menu"] button'));

describe('ContextMenu 关闭', () => {
  it('在别处再点右键会关掉自己，即使那处的右键处理器 stopPropagation（否则两张菜单叠在一起）', async () => {
    // 右键不产生 click，只产生 contextmenu；文件链接芯片的右键处理器还会 stopPropagation，
    // 所以必须在捕获阶段监听，才不会旧菜单留着、新菜单又开出来。
    const onClose = vi.fn();
    await render({ onClose });
    const other = document.createElement('button');
    other.addEventListener('contextmenu', (e) => e.stopPropagation());
    document.body.append(other);
    other.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    other.remove();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// jsdom 不做布局，量不出宽高与圆角；下面钉住的是各自的「原因」。
describe('ContextMenu 版式', () => {
  it('每一项都是块级：菜单宽度取最宽一项，而不是各项并排之和', async () => {
    // <button> 默认 inline-block，fixed 菜单按收缩宽度排版时会把它们并排在一行，菜单就被
    // 撑成各项宽度之和（带说明文字的两项曾因此撑出一条比内容宽近一倍的菜单）。
    await render();
    expect(buttons()).toHaveLength(2);
    for (const button of buttons()) expect(button.classList.contains('block')).toBe(true);
  });

  it('菜单整体圆角裁切，菜单项是内缩的圆角块：悬停高亮不戳出外轮廓', async () => {
    // 新观感：容器 p-1 内缩 + 菜单项 rounded-md（内圆角 < 外圆角），高亮是独立的小圆角块。
    const el = await render();
    expect(el.classList.contains('overflow-hidden')).toBe(true);
    expect(el.classList.contains('rounded-xl')).toBe(true);
    expect(el.classList.contains('surface-glass')).toBe(true);
    for (const button of buttons()) {
      expect(button.classList.contains('rounded-md')).toBe(true);
    }
  });
});
