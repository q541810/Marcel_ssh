// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsActionsProvider } from '@/components/settings/SettingsActionsContext';
import type { AppSettings } from '@/lib/types';
import { MobileArchiveSection } from './MobileArchiveSection';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const update = vi.fn();

beforeEach(() => {
  update.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderSection(archiveRetentionDays: number) {
  const settings = { archiveRetentionDays } as unknown as AppSettings;
  await act(async () => {
    root.render(
      <SettingsActionsProvider
        value={{
          settings,
          update,
          setPreview: vi.fn(),
          saving: false,
          saveError: null,
          validationErrors: [],
          registerValidator: vi.fn(),
          clearValidationErrors: vi.fn(),
        }}
      >
        <MobileArchiveSection />
      </SettingsActionsProvider>,
    );
  });
}

function input(): HTMLInputElement {
  return container.querySelector(
    'input[aria-label="归档保留天数"]',
  ) as HTMLInputElement;
}

async function type(value: string) {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressEnter() {
  await act(async () => {
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  });
}

describe('MobileArchiveSection', () => {
  it('显示当前保留天数', async () => {
    await renderSection(30);
    expect(input().value).toBe('30');
  });

  it('提交新天数时写回设置', async () => {
    await renderSection(30);
    await type('45');
    await pressEnter();
    expect(update).toHaveBeenCalledWith({ archiveRetentionDays: 45 });
  });

  it('清空后提交回落默认 30 天', async () => {
    await renderSection(45);
    await type('');
    await pressEnter();
    expect(update).toHaveBeenCalledWith({ archiveRetentionDays: 30 });
  });

  it('填 0 时提示已关闭自动清理', async () => {
    await renderSection(0);
    expect(container.textContent).toContain('已关闭自动清理');
  });
});
