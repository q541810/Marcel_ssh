// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PasswordPrompt from './PasswordPrompt';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn();
const onCancel = vi.fn();

function render(open = true) {
  act(() => {
    root.render(
      <PasswordPrompt
        open={open}
        title="SSH 密码"
        description="连接到 root@example.test:22"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
  });
}

function input(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('input[type="password"]');
  if (!el) throw new Error('找不到密码输入框');
  return el;
}

function submitButton(): HTMLButtonElement {
  const el = Array.from(document.querySelectorAll('button')).find(
    (b) => b.getAttribute('type') === 'submit',
  );
  if (!el) throw new Error('找不到提交按钮');
  return el as HTMLButtonElement;
}

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

/**
 * 「不记住」这个选项被删掉了：输入的凭证一律存进密钥链。
 *
 * 这一组钉住删除本身——那个复选框一旦被谁加回来，"没勾住"的那条路就会重新长出
 * 两个坏结果：每次连接都要重新输、以及重连只报"重连需要密码"。要清凭证用连接
 * 设置里的「清除」，不靠当时不勾。
 */
describe('PasswordPrompt 不再有「记住」选项', () => {
  it('不渲染任何复选框，也不出现「记住」字样', () => {
    render();
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(document.body.textContent ?? '').not.toContain('记住');
  });

  it('提交时只把凭证交出去（没有"要不要记住"这一路参数）', async () => {
    render();
    await type(input(), 's3cret');
    await act(async () => submitButton().click());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]).toEqual(['s3cret']);
  });

  it('空输入时提交按钮不可点', () => {
    render();
    expect(submitButton().disabled).toBe(true);
  });

  it('仍是受控清空：重新打开一次不会带出上次输入', async () => {
    render();
    await type(input(), 's3cret');
    act(() => root.render(
      <PasswordPrompt
        open={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    ));
    render();
    expect(input().value).toBe('');
  });
});
