// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const clipboardMocks = vi.hoisted(() => ({
  writeText: vi.fn(async (_text: string) => {}),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: clipboardMocks.writeText,
}));

import { describeError } from '@/lib/errors';
import ErrorScreen from './ErrorScreen';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function sampleError(): Error {
  const error = new TypeError("Cannot read properties of undefined (reading 'map')");
  error.stack = "TypeError: Cannot read properties of undefined (reading 'map')\n    at MessageList (src/x.tsx:1:1)";
  return error;
}

async function render(props: { error: unknown; onClose?: () => void }) {
  await act(async () => {
    root.render(<ErrorScreen {...props} />);
  });
  return container;
}

describe('describeError', () => {
  it('Error 实例：取 stack（含消息与调用栈）', () => {
    const error = sampleError();
    expect(describeError(error)).toContain("Cannot read properties of undefined (reading 'map')");
    expect(describeError(error)).toContain('at MessageList');
  });

  it('字符串原样返回，其他值回落 JSON 形状（不产生 "[object Object]"）', () => {
    expect(describeError('磁盘满了')).toBe('磁盘满了');
    expect(describeError({ kind: 'IoError', message: '坏了' })).toContain('IoError');
  });
});

describe('ErrorScreen（崩溃兜底界面）', () => {
  it('渲染标题、错误原文与交流群反馈引导', async () => {
    await render({ error: sampleError() });

    expect(container.textContent).toContain('出错了');
    expect(container.textContent).toContain("Cannot read properties of undefined (reading 'map')");
    expect(container.textContent).toContain('1101255501');
    expect(container.textContent).toContain('复制错误信息');
  });

  it('复制：经 Tauri 剪贴板写入错误原文，按钮给出已复制反馈', async () => {
    await render({ error: sampleError() });

    const copyButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('复制错误信息'),
    )!;
    await act(async () => {
      copyButton.click();
    });

    expect(clipboardMocks.writeText).toHaveBeenCalledTimes(1);
    const written = clipboardMocks.writeText.mock.calls[0][0] as string;
    expect(written).toContain("Cannot read properties of undefined (reading 'map')");
    expect(container.textContent).toContain('已复制');
  });

  it('Tauri 剪贴板失败：回落 navigator.clipboard 后仍报告已复制', async () => {
    clipboardMocks.writeText.mockRejectedValueOnce(new Error('plugin unavailable'));
    const fallback = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: fallback },
      configurable: true,
    });

    await render({ error: sampleError() });
    const copyButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('复制错误信息'),
    )!;
    await act(async () => {
      copyButton.click();
    });

    expect(fallback).toHaveBeenCalledWith(expect.stringContaining('Cannot read properties'));
    expect(container.textContent).toContain('已复制');
    delete (navigator as unknown as Record<string, unknown>).clipboard;
  });

  it('两条复制路都失败：按钮进入失败态而不是静默', async () => {
    clipboardMocks.writeText.mockRejectedValueOnce(new Error('plugin unavailable'));
    const fallback = vi.fn(async () => {
      throw new Error('clipboard unavailable');
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: fallback },
      configurable: true,
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await render({ error: sampleError() });
    const copyButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('复制错误信息'),
    )!;
    await act(async () => {
      copyButton.click();
    });

    expect(container.textContent).toContain('复制失败');
    errSpy.mockRestore();
    delete (navigator as unknown as Record<string, unknown>).clipboard;
  });

  it('真实崩溃模式：主按钮是「重新加载」', async () => {
    await render({ error: sampleError() });

    const primary = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('重新加载'),
    );
    expect(primary).toBeDefined();
    expect(container.textContent).not.toContain('关闭预览');
  });

  it('预览模式（调试页）：主按钮变为「关闭预览」并回调 onClose', async () => {
    const onClose = vi.fn();
    await render({ error: sampleError(), onClose });

    expect(container.textContent).toContain('关闭预览');
    const closeButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('关闭预览'),
    )!;
    await act(async () => {
      closeButton.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
