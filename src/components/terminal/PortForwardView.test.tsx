// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortForwardInfo } from '@/lib/tauri';
import type { PortForwardNote } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const setNote = vi.fn(async () => {});
const start = vi.fn(async () => null);
const stop = vi.fn(async () => {});
const scan = vi.fn(async () => {});

interface HookState {
  forwards: PortForwardInfo[];
  services: { port: number; targetHost: string; process: string }[];
  notes: PortForwardNote[];
  scanned: boolean;
  scanning: boolean;
  error: string | null;
  canRemember: boolean;
  sessionConnected: boolean;
}

const hookState: HookState = {
  forwards: [],
  services: [],
  notes: [],
  scanned: true,
  scanning: false,
  error: null,
  canRemember: true,
  sessionConnected: true,
};

vi.mock('@/hooks/usePortForward', () => ({
  usePortForward: () => ({ ...hookState, start, stop, scan, setNote }),
}));
vi.mock('@/lib/externalLinks', () => ({ openExternalLink: vi.fn() }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: vi.fn(async () => {}) }));

const forward = (over: Partial<PortForwardInfo> = {}): PortForwardInfo => ({
  id: 'f1', sessionId: 's1', remoteHost: 'localhost', remotePort: 3000, localPort: 3000,
  sessionOnline: true, activeConnections: 0, totalConnections: 0, lastError: null, ...over,
});

let container: HTMLDivElement;
let root: Root;

async function render() {
  const { default: PortForwardView } = await import('./PortForwardView');
  await act(async () => {
    root.render(<PortForwardView sessionId="s1" />);
  });
}

function rowTexts(): string[] {
  return [...container.querySelectorAll('ul > li')].map((li) => li.textContent ?? '');
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setNote.mockClear();
  Object.assign(hookState, {
    forwards: [], services: [], notes: [], scanned: true, scanning: false, error: null, canRemember: true,
    sessionConnected: true,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('PortForwardView 备注与置顶', () => {
  it('记住的条目没开转发也显示；置顶排最前，并提示服务器上没在监听', async () => {
    hookState.notes = [
      { id: 'localhost|3000', host: 'localhost', port: 3000, note: '前端', pinned: false },
      { id: 'localhost|8080', host: 'localhost', port: 8080, note: '', pinned: true },
    ];
    await render();
    const rows = rowTexts();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('8080');
    expect(rows[0]).toContain('服务器上暂未发现在监听');
    expect(rows[1]).toContain('3000');
    expect(rows[1]).toContain('前端');
  });

  it('给正在转发的行加备注：回车保存', async () => {
    hookState.forwards = [forward()];
    await render();
    const add = [...container.querySelectorAll('button')].find((b) => b.textContent === '添加备注');
    await act(async () => add?.click());
    const input = container.querySelector('input[placeholder="备注，比如：后台管理"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      typeInto(input, '后台');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(setNote).toHaveBeenCalledWith('localhost', 3000, '后台', false);
  });

  it('扫描到的服务和记住的条目在同一份列表，同目标只出现一次', async () => {
    hookState.forwards = [forward()];
    hookState.notes = [
      { id: 'localhost|3000', host: 'localhost', port: 3000, note: '前端', pinned: false },
    ];
    hookState.services = [
      { port: 3000, targetHost: 'localhost', process: 'node' },
      { port: 22, targetHost: 'localhost', process: 'sshd' },
    ];
    await render();
    const rows = rowTexts();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('3000');
    expect(rows[0]).toContain('前端');
    expect(rows[0]).toContain('node');
    expect(rows[1]).toContain('22');
    expect(rows[1]).toContain('sshd');
    expect(rows[1]).toContain('转发');
  });

  it('点图钉切换置顶', async () => {
    hookState.forwards = [forward()];
    hookState.notes = [{ id: 'localhost|3000', host: 'localhost', port: 3000, note: '前端', pinned: false }];
    await render();
    const pin = container.querySelector('button[aria-label="置顶"]');
    await act(async () => pin?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(setNote).toHaveBeenCalledWith('localhost', 3000, '前端', true);
  });
});