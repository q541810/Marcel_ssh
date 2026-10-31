// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FileTreeSidebar from './FileTreeSidebar';
import type { TreeCache } from './fileTreeModel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const cache: TreeCache = {
  '/': {
    status: 'loaded',
    dirs: [
      { name: 'etc', path: '/etc', isSymlink: false },
      { name: 'home', path: '/home', isSymlink: false },
    ],
  },
  '/etc': { status: 'loaded', dirs: [] },
  '/home': { status: 'loaded', dirs: [{ name: 'u', path: '/home/u', isSymlink: false }] },
};

let container: HTMLDivElement;
let root: Root;
const handlers = {
  onToggleExpand: vi.fn(),
  onNavigate: vi.fn(),
  onRetry: vi.fn(),
  onContextMenu: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
};

function render(opts: {
  expanded?: string[];
  selectedPath?: string;
  homePath?: string | null;
  contextPath?: string | null;
  dropHoverPath?: string | null;
} = {}) {
  act(() => {
    root.render(
      <FileTreeSidebar
        cache={cache}
        expanded={new Set(opts.expanded ?? ['/'])}
        selectedPath={opts.selectedPath ?? '/'}
        homePath={opts.homePath}
        contextPath={opts.contextPath}
        dropHoverPath={opts.dropHoverPath}
        {...handlers}
      />,
    );
  });
}

const row = (path: string, shortcut = false) =>
  Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
    (el) =>
      el.getAttribute('data-tree-path') === path &&
      (el.dataset.rowKey?.startsWith('home:') ?? false) === shortcut,
  )!;

function key(el: HTMLElement, k: string, init: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  Object.values(handlers).forEach((h) => h.mockReset());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('FileTreeSidebar 语义与键盘', () => {
  it('role=tree / treeitem，带 aria-expanded / aria-selected / data-tree-path', () => {
    render({ expanded: ['/', '/home'], selectedPath: '/home' });
    expect(container.querySelector('[role="tree"]')).not.toBeNull();
    expect(row('/').getAttribute('aria-expanded')).toBe('true');
    expect(row('/home').getAttribute('aria-selected')).toBe('true');
    expect(row('/home').getAttribute('aria-expanded')).toBe('true');
    expect(row('/home/u').getAttribute('aria-level')).toBe('3');
  });

  it('已加载且没有子目录的叶子：不带 aria-expanded、箭头隐藏', () => {
    render();
    const etc = row('/etc');
    expect(etc.hasAttribute('aria-expanded')).toBe(false);
    expect(etc.querySelector('button')!.className).toContain('text-transparent');
    // 没加载过的节点先当作有子目录
    expect(row('/home').hasAttribute('aria-expanded')).toBe(true);
  });

  it('漫游 tabindex：只有当前目录那一行可 Tab 停靠', () => {
    render({ selectedPath: '/etc' });
    const stops = Array.from(container.querySelectorAll('[role="treeitem"]')).filter(
      (el) => el.getAttribute('tabindex') === '0',
    );
    expect(stops).toHaveLength(1);
    expect(stops[0].getAttribute('data-tree-path')).toBe('/etc');
  });

  it('上下键移动焦点；右键展开 / 进入首个子节点；左键收起 / 回父节点', () => {
    render({ expanded: ['/'], selectedPath: '/' });
    key(row('/'), 'ArrowDown');
    expect(document.activeElement).toBe(row('/etc'));
    key(row('/etc'), 'ArrowDown');
    expect(document.activeElement).toBe(row('/home'));

    // 右：未展开 → 请求展开
    key(row('/home'), 'ArrowRight');
    expect(handlers.onToggleExpand).toHaveBeenCalledWith('/home');

    // 已展开再按右 → 焦点到第一个子节点
    render({ expanded: ['/', '/home'], selectedPath: '/' });
    key(row('/home'), 'ArrowRight');
    expect(document.activeElement).toBe(row('/home/u'));

    // 左：子节点 → 父节点；已展开的父节点 → 收起
    key(row('/home/u'), 'ArrowLeft');
    expect(document.activeElement).toBe(row('/home'));
    handlers.onToggleExpand.mockClear();
    key(row('/home'), 'ArrowLeft');
    expect(handlers.onToggleExpand).toHaveBeenCalledWith('/home');
  });

  it('Enter 导航，F2 重命名，Delete 删除；根目录不响应 F2 / Delete', () => {
    render({ expanded: ['/'] });
    key(row('/etc'), 'Enter');
    expect(handlers.onNavigate).toHaveBeenCalledWith('/etc');
    key(row('/etc'), 'F2');
    expect(handlers.onRename).toHaveBeenCalledWith('/etc');
    key(row('/etc'), 'Delete');
    expect(handlers.onDelete).toHaveBeenCalledWith('/etc');

    handlers.onRename.mockClear();
    handlers.onDelete.mockClear();
    key(row('/'), 'F2');
    key(row('/'), 'Delete');
    expect(handlers.onRename).not.toHaveBeenCalled();
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it('右键只触发菜单回调、不导航', () => {
    render();
    act(() => {
      row('/etc').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }),
      );
    });
    expect(handlers.onContextMenu).toHaveBeenCalledWith('/etc', 40, 60);
    expect(handlers.onNavigate).not.toHaveBeenCalled();
  });

  it('右键菜单打开时目标行高亮；拖拽悬停的行有落点高亮', () => {
    render({ contextPath: '/etc', dropHoverPath: '/home' });
    expect(row('/etc').className).toContain('bg-state-mid');
    expect(row('/home').className).toContain('ring-indigo-400');
  });

  it('主目录快捷项：置顶、只导航、不响应 F2 / Delete，且不与树里同路径节点撞行', () => {
    render({ homePath: '/home/u', expanded: ['/', '/home'] });
    const items = Array.from(container.querySelectorAll('[role="treeitem"]'));
    expect(items[0].getAttribute('data-row-key')).toBe('home:/home/u');
    expect(items[0].textContent).toContain('主目录');
    key(row('/home/u', true), 'F2');
    key(row('/home/u', true), 'Delete');
    expect(handlers.onRename).not.toHaveBeenCalled();
    expect(handlers.onDelete).not.toHaveBeenCalled();
    key(row('/home/u', true), 'Enter');
    expect(handlers.onNavigate).toHaveBeenCalledWith('/home/u');
  });

  it('主目录就是根目录时不放快捷项', () => {
    render({ homePath: '/' });
    expect(container.querySelectorAll('[data-row-key^="home:"]')).toHaveLength(0);
  });

  it('当前目录变化时把对应行滚进视野', () => {
    const scroll = vi.fn();
    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scroll;
    render({ expanded: ['/', '/home'], selectedPath: '/home/u' });
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });
});
