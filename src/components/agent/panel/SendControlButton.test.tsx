// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { SendControlButton } from './SendControlButton';

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

async function render(props: React.ComponentProps<typeof SendControlButton>) {
  await act(async () => {
    root.render(<SendControlButton {...props} />);
  });
  return container.querySelector('button')!;
}

describe('SendControlButton 三态（停止 / 取消压缩 / 发送）', () => {
  const handlers = () => ({
    onSend: vi.fn(),
    onStop: vi.fn(),
    onCancelCompaction: vi.fn(),
  });

  it('空闲：文案「发送」，点击走 onSend', async () => {
    const h = handlers();
    const button = await render({ isRunning: false, isCompacting: false, disabled: false, ...h });
    expect(button.title).toBe('发送');
    expect(button.getAttribute('aria-label')).toBe('发送');

    await act(async () => {
      button.click();
    });
    expect(h.onSend).toHaveBeenCalledTimes(1);
    expect(h.onStop).not.toHaveBeenCalled();
    expect(h.onCancelCompaction).not.toHaveBeenCalled();
  });

  it('运行中：文案「停止」，点击走 onStop（即使内容为空也不禁用）', async () => {
    const h = handlers();
    // 真实组件里 disabled 由 Composer 计算：isRunning 时恒为 false
    const button = await render({ isRunning: true, isCompacting: false, disabled: false, ...h });
    expect(button.title).toBe('停止');

    await act(async () => {
      button.click();
    });
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onSend).not.toHaveBeenCalled();
  });

  it('压缩中：文案「取消压缩」，点击走 onCancelCompaction', async () => {
    const h = handlers();
    // 真实组件里 disabled 由 Composer 计算：isCompacting 时恒为 false（压缩中唯一出路就是这个键）
    const button = await render({ isRunning: false, isCompacting: true, disabled: false, ...h });
    expect(button.title).toBe('取消压缩');

    await act(async () => {
      button.click();
    });
    expect(h.onCancelCompaction).toHaveBeenCalledTimes(1);
    expect(h.onSend).not.toHaveBeenCalled();
  });

  it('空闲且禁用：点击无效果（空内容或未连接）', async () => {
    const h = handlers();
    const button = await render({ isRunning: false, isCompacting: false, disabled: true, ...h });
    expect(button.disabled).toBe(true);

    await act(async () => {
      button.click();
    });
    expect(h.onSend).not.toHaveBeenCalled();
  });
});
