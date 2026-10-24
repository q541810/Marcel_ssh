// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentConversation } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { AgentHistoryDrawer } from './AgentHistoryDrawer';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const presence = {
  mounted: true,
  phase: 'enter' as const,
  onAnimationEnd: () => {},
};

/** React 受控输入的原生写入：直接改 .value 不触发 onChange（值追踪去重），必须走原型 setter。 */
function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function conv(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conv-1',
    connectionId: 'c1',
    title: '查磁盘',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    pinned: false,
    ...overrides,
  };
}

type DrawerProps = React.ComponentProps<typeof AgentHistoryDrawer>;

const baseProps = (overrides: Partial<DrawerProps> = {}): DrawerProps => ({
  presence,
  onClose: vi.fn(),
  sessionConversations: [conv()],
  activeConversationId: 'conv-1',
  tasks: {},
  unreadCompletedConversations: [],
  onSelect: vi.fn(async () => {}),
  onArchive: vi.fn(async () => {}),
  onPin: vi.fn(async () => {}),
  onRename: vi.fn(async () => {}),
  archivedConversations: [],
  archivedLoading: false,
  onLoadArchived: vi.fn(async () => {}),
  onUnarchive: vi.fn(async () => {}),
  onDeletePermanently: vi.fn(async () => {}),
  ...overrides,
});

async function render(props: DrawerProps) {
  await act(async () => {
    root.render(<AgentHistoryDrawer {...props} />);
  });
}

describe('AgentHistoryDrawer（原 AgentPanel 内联历史抽屉，行为不变）', () => {
  it('渲染分组列表与标题', async () => {
    const props = baseProps();
    await render(props);

    expect(container.textContent).toContain('历史会话');
    expect(container.textContent).toContain('查磁盘');
    expect(props.onClose).toBeDefined();
  });

  it('点击会话行走 onSelect（含跨标签跳转的编排交给父级）', async () => {
    const onSelect = vi.fn(async () => {});
    await render(baseProps({ onSelect }));

    const row = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('查磁盘'),
    )!;
    await act(async () => {
      row.click();
    });

    expect(onSelect).toHaveBeenCalledWith('conv-1');
  });

  it('重命名：点编辑 → 输入框预填 → Enter 确认 → onRename 收到裁剪后的标题', async () => {
    const onRename = vi.fn(async () => {});
    await render(baseProps({ onRename }));

    const editButton = container.querySelector<HTMLButtonElement>('button[title="重命名会话"]')!;
    await act(async () => {
      editButton.click();
    });

    const input = container.querySelector<HTMLInputElement>('input')!;
    expect(input.value).toBe('查磁盘');

    setNativeValue(input, '  新名字  ');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onRename).toHaveBeenCalledWith('conv-1', '新名字');
  });

  it('空白标题不提交（与原实现一致：trim 后为空就不调用）', async () => {
    const onRename = vi.fn(async () => {});
    await render(baseProps({ onRename }));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="重命名会话"]')!.click();
    });
    const input = container.querySelector<HTMLInputElement>('input')!;
    setNativeValue(input, '   ');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onRename).not.toHaveBeenCalled();
  });

  it('Escape 取消编辑，onRename 不被调用', async () => {
    const onRename = vi.fn(async () => {});
    await render(baseProps({ onRename }));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="重命名会话"]')!.click();
    });
    const input = container.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onRename).not.toHaveBeenCalled();
    expect(container.querySelector('input')).toBeNull();
  });

  it('置顶按钮：onPin 收到 (id, 目标状态)（当前 false → true）', async () => {
    const onPin = vi.fn(async () => {});
    await render(baseProps({ onPin }));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="置顶会话"]')!.click();
    });

    expect(onPin).toHaveBeenCalledWith('conv-1', true);
  });

  it('已置顶的会话：按钮文案变为「取消置顶」，onPin 目标为 false', async () => {
    const onPin = vi.fn(async () => {});
    await render(
      baseProps({
        onPin,
        sessionConversations: [conv({ pinned: true })],
      }),
    );

    expect(container.querySelector('button[title="取消置顶"]')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="取消置顶"]')!.click();
    });
    expect(onPin).toHaveBeenCalledWith('conv-1', false);
  });

  it('归档按钮：onArchive 收到会话 id，且不弹确认（归档可恢复）', async () => {
    const onArchive = vi.fn(async () => {});
    const confirmSpy = vi.spyOn(window, 'confirm');
    await render(baseProps({ onArchive }));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="归档会话（可恢复）"]')!.click();
    });

    expect(onArchive).toHaveBeenCalledWith('conv-1');
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('归档失败：展示后端原因（如任务正在运行），不抛未处理拒绝', async () => {
    const onArchive = vi.fn(async () => {
      throw new Error('该会话正在运行，请先停止任务再归档');
    });
    await render(baseProps({ onArchive }));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="归档会话（可恢复）"]')!.click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      '该会话正在运行，请先停止任务再归档',
    );
  });

  it('已归档视图：进入即加载，列表可恢复，永久删除先确认', async () => {
    const onLoadArchived = vi.fn(async () => {});
    const onUnarchive = vi.fn(async () => {});
    const onDeletePermanently = vi.fn(async () => {});
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render(
      baseProps({
        onLoadArchived,
        onUnarchive,
        onDeletePermanently,
        archivedConversations: [
          conv({
            id: 'conv-old',
            title: '旧会话',
            archivedAt: '2026-10-02T08:00:00.000Z',
          }),
        ],
      }),
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="查看已归档会话"]')!.click();
    });
    expect(onLoadArchived).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('旧会话');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="恢复到会话列表"]')!.click();
    });
    expect(onUnarchive).toHaveBeenCalledWith('conv-old');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="永久删除"]')!.click();
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onDeletePermanently).toHaveBeenCalledWith('conv-old');
    confirmSpy.mockRestore();
  });

  it('归档视图为空时展示空状态', async () => {
    await render(baseProps());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="查看已归档会话"]')!.click();
    });
    expect(container.textContent).toContain('暂无归档会话');
  });

  it('关闭按钮走 onClose', async () => {
    const onClose = vi.fn();
    await render(baseProps({ onClose }));

    const closeButton = container.querySelector<HTMLButtonElement>('button[title="关闭"]')!;
    await act(async () => {
      closeButton.click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
