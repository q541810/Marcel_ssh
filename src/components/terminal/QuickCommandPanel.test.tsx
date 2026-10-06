// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tauriMock = vi.hoisted(() => ({
  quickCommandList: vi.fn(),
  quickCommandAdd: vi.fn(),
  quickCommandUpdate: vi.fn(),
  quickCommandDelete: vi.fn(),
  sshSendInput: vi.fn(),
}));

vi.mock('@/lib/tauri', () => tauriMock);

import QuickCommandPanel from './QuickCommandPanel';
import { useQuickCommandStore } from '@/stores/quickCommandStore';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  tauriMock.quickCommandList.mockResolvedValue([]);
  useQuickCommandStore.setState({
    commands: [],
    loading: false,
    error: null,
    executingId: null,
    lastSessionKey: null,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderPanel() {
  await act(async () => {
    root.render(<QuickCommandPanel sessionId="s1" sessionKey="cfg1" />);
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

/** 弹窗是通过 createPortal 挂到 document.body 的 */
function modalPanel(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('.modal-panel-enter');
  if (!el) throw new Error('新建/编辑快捷指令弹窗未打开');
  return el;
}

async function setField(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
}

/**
 * 新建/编辑弹窗的报错必须落在弹窗里。
 *
 * 之前所有校验/保存错误都写进面板级 message，渲染在列表区——而弹窗是带
 * `backdrop-blur-sm` 遮罩的 portal，等于把提示画在模糊层后面，用户根本读不到。
 */
describe('快捷指令弹窗的内联提示', () => {
  it('校验失败（名称为空）显示在弹窗内，且不再重复渲染到弹窗背后', async () => {
    await renderPanel();
    await click(clickButton('新建'));
    await setField(modalPanel().querySelector('select')!, 'global');
    await click(clickButton('保存', modalPanel()));

    const panel = modalPanel();
    expect(panel.textContent).toContain('名称不能为空');
    expect(panel.querySelector('[role="alert"]')).not.toBeNull();
    // 全文档只出现一次：没有同时留在弹窗背后的 message 栏里
    expect(document.body.textContent!.split('名称不能为空').length - 1).toBe(1);
  });

  it('保存失败（结构化 AppError）显示在弹窗内且弹窗保持打开', async () => {
    tauriMock.quickCommandAdd.mockRejectedValue({
      kind: 'Other',
      message: '磁盘已满',
    });
    await renderPanel();
    await click(clickButton('新建'));

    const panel = modalPanel();
    await setField(panel.querySelector('select')!, 'global');
    await setField(
      panel.querySelector('input[placeholder="例如：查看磁盘"]')!,
      '查看磁盘',
    );
    await setField(panel.querySelector('textarea')!, 'df -h');
    await click(clickButton('保存', modalPanel()));

    expect(modalPanel().textContent).toContain('保存失败：磁盘已满');
    expect(tauriMock.quickCommandAdd).toHaveBeenCalledTimes(1);
  });

  it('切到"仅插入"截断多行时，说明显示在弹窗内且不算报错', async () => {
    await renderPanel();
    await click(clickButton('新建'));

    const panel = modalPanel();
    await setField(panel.querySelector('textarea')!, 'pwd\ndf -h');
    await click(panel.querySelector('[role="switch"]')!);

    const after = modalPanel();
    expect(after.textContent).toContain('已保留第一行');
    expect(after.querySelector('[role="alert"]')).toBeNull();
  });

  it('保存成功后弹窗关闭，校验提示不残留', async () => {
    tauriMock.quickCommandAdd.mockResolvedValue({
      id: 'q1',
      scope: 'global',
      sessionKey: null,
      name: '查看磁盘',
      commands: ['df -h'],
      intervalMs: 300,
      insertOnly: false,
    });
    await renderPanel();
    await click(clickButton('新建'));

    const panel = modalPanel();
    await setField(panel.querySelector('select')!, 'global');
    await click(clickButton('保存', modalPanel()));
    expect(modalPanel().textContent).toContain('名称不能为空');

    await setField(
      modalPanel().querySelector('input[placeholder="例如：查看磁盘"]')!,
      '查看磁盘',
    );
    await setField(modalPanel().querySelector('textarea')!, 'df -h');
    await click(clickButton('保存', modalPanel()));

    expect(document.body.querySelector('.modal-panel-enter')).toBeNull();
    expect(document.body.textContent).not.toContain('名称不能为空');
  });
});
