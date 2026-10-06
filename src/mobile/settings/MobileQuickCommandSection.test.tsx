// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tauriMock = vi.hoisted(() => ({
  getConnections: vi.fn(),
  quickCommandList: vi.fn(),
  quickCommandAdd: vi.fn(),
  quickCommandUpdate: vi.fn(),
  quickCommandDelete: vi.fn(),
}));

vi.mock('@/lib/tauri', () => tauriMock);

import { MobileQuickCommandSection } from './MobileQuickCommandSection';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  tauriMock.getConnections.mockResolvedValue([]);
  tauriMock.quickCommandList.mockResolvedValue([]);
  // jsdom 没有 ResizeObserver，MobileSheet 打开时会用它把焦点输入框滚回视野
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderSection() {
  await act(async () => {
    root.render(<MobileQuickCommandSection />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickButton(label: string, scope: ParentNode = document): Element {
  const btn = Array.from(scope.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  if (!btn) throw new Error(`找不到按钮：${label}`);
  return btn;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function sheet(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('[role="dialog"]');
  if (!el) throw new Error('新建/编辑快捷命令 sheet 未打开');
  return el;
}

async function setField(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * sheet 内联提示：校验/保存错误只出现在 sheet 里。
 * 之前 message 同时被渲染到页面区（displayError = message ?? loadError），
 * 等于同一句话在 sheet 背后再镜像一份；关闭 sheet 后还留在页面上。
 */
describe('快捷命令 sheet 的内联提示', () => {
  it('校验失败显示在 sheet 内，页面区不再镜像一份', async () => {
    await renderSection();
    await click(clickButton('新建快捷命令'));
    await click(clickButton('保存', sheet()));

    expect(sheet().textContent).toContain('名称不能为空');
    expect(container.textContent).not.toContain('名称不能为空');
  });

  it('保存失败（结构化 AppError）显示在 sheet 内且 sheet 不关闭', async () => {
    tauriMock.quickCommandAdd.mockRejectedValue({
      kind: 'Other',
      message: '磁盘已满',
    });
    await renderSection();
    await click(clickButton('新建快捷命令'));

    const open = sheet();
    await setField(open.querySelector('input[type="text"]')!, '查看磁盘');
    await setField(open.querySelector('textarea')!, 'df -h');
    await click(clickButton('保存', sheet()));

    expect(sheet().textContent).toContain('保存失败：磁盘已满');
  });

  it('切到"仅插入"截断多行时，说明显示在 sheet 内且不算报错', async () => {
    await renderSection();
    await click(clickButton('新建快捷命令'));

    const open = sheet();
    await setField(open.querySelector('textarea')!, 'pwd\ndf -h');
    await click(open.querySelector('[role="switch"]')!);

    const after = sheet();
    expect(after.textContent).toContain('已保留第一行');
    expect(after.querySelector('[role="alert"]')).toBeNull();
  });
});
