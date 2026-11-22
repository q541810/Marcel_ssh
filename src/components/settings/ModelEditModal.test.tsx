// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModelEditModal, { type ModelDraft } from './ModelEditModal';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
function input(element: HTMLInputElement, value: string) {
  act(() => {
    native.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function fields(): HTMLInputElement[] { return [...document.body.querySelectorAll<HTMLInputElement>('input')]; }

describe('新增模型自动填充', () => {
  it('列表带入模型名时立即填表，保存保留推荐', async () => {
    const saved: ModelDraft[] = [];
    await act(async () => root.render(<ModelEditModal open onClose={() => {}} onSave={(d) => saved.push(d)} presetModelName="kimi-k3" />));
    await act(async () => {});
    const name = fields().find((el) => el.value === 'kimi-k3')!;
    const context = fields().find((el) => el.type === 'number')!;
    expect(context.value).toBe('1048576');
    expect(document.body.textContent).toContain('已自动填充：');
    for (const label of ['上下文窗口', '视觉', '思考档位']) {
      expect(document.body.textContent).toContain(label);
    }
    const save = [...document.body.querySelectorAll('button')].find((el) => el.textContent === '保存')!;
    await act(async () => save.click());
    expect(saved[0]).toMatchObject({ modelName: 'kimi-k3', contextWindow: 1048576, vision: true, reasoningEfforts: ['low', 'high', 'max'] });
    expect(name).not.toBeNull();
  });

  it('手动输入停止 1.2 秒才填，用户修改不被覆盖', async () => {
    await act(async () => root.render(<ModelEditModal open onClose={() => {}} onSave={() => {}} />));
    await act(async () => {});
    const name = fields()[0];
    input(name, 'kimi-k3');
    const context = fields().find((el) => el.type === 'number')!;
    expect(context.value).toBe('0');
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(context.value).toBe('1048576');
    input(context, '123456');
    input(name, 'kimi-k3-256k');
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(context.value).toBe('123456');
    input(name, 'unknown');
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(document.body.textContent).not.toContain('已自动填充');
  });

  it('完全不匹配的模型不填也不提示', async () => {
    await act(async () => root.render(<ModelEditModal open onClose={() => {}} onSave={() => {}} />));
    await act(async () => {});
    input(fields()[0], 'some-totally-unknown-model');
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(document.body.textContent).not.toContain('已自动填充');
    expect(fields().find((el) => el.type === 'number')!.value).toBe('0');
  });

  it('填了思考档位时自动展开「更多」，让用户看得到', async () => {
    await act(async () => root.render(<ModelEditModal open onClose={() => {}} onSave={() => {}} />));
    await act(async () => {});
    input(fields()[0], 'kimi-k3');
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(document.body.textContent).toContain('思考强度档位');
    expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('low\nhigh\nmax');
  });

  it('失焦后立刻保存不会用上一帧的旧草稿', async () => {
    const saved: ModelDraft[] = [];
    await act(async () => root.render(<ModelEditModal open onClose={() => {}} onSave={(d) => saved.push(d)} />));
    await act(async () => {});
    input(fields()[0], 'kimi-k3');
    act(() => fields()[0].blur());
    const save = [...document.body.querySelectorAll('button')].find((el) => el.textContent === '保存')!;
    await act(async () => save.click());
    expect(saved[0].contextWindow).toBe(1048576);
    expect(saved[0].vision).toBe(true);
  });

  it('手快立即保存也会把尚未到时的推荐带入本次保存', async () => {
    const saved: ModelDraft[] = [];
    await act(async () => root.render(<ModelEditModal open onClose={() => {}} onSave={(d) => saved.push(d)} />));
    await act(async () => {});
    input(fields()[0], 'kimi-k3');
    const save = [...document.body.querySelectorAll('button')].find((el) => el.textContent === '保存')!;
    await act(async () => save.click());
    expect(saved[0].reasoningEfforts).toEqual(['low', 'high', 'max']);
    expect(saved[0].contextWindow).toBe(1048576);
  });
});
