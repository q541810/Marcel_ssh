// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MarcelSprite from './MarcelSprite';
import { loadMascotFrames } from '@/lib/mascot/frames';

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  await loadMascotFrames(); // 预先加载，组件首帧就能同步拿到数据
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MarcelSprite', () => {
  it('画布不可用（2D 上下文缺方法）时不抛错，不把外层一起带崩', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await act(async () => root.render(<MarcelSprite state="running" size={64} />));
    expect(host.querySelector('canvas')?.getAttribute('aria-label')).toBe('玛瑟尔：执行命令中');
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('「坐」模式按人物外框把透明边挪出去，戳一下的热区只盖住身体', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const onPoke = vi.fn();
    await act(async () => root.render(<MarcelSprite state="idle" size={64} perch onPoke={onPoke} />));
    const canvas = host.querySelector('canvas')!;
    // 1 倍：64 格画布 = 64px；人物描边最底行在第 60 行、最右列在第 56 列
    expect(canvas.style.width).toBe('64px');
    expect(canvas.style.marginBottom).toBe('-3px');
    expect(canvas.style.marginRight).toBe('-7px');
    const hit = host.querySelector('[aria-hidden="true"]') as HTMLDivElement;
    expect(hit.style.left).toBe('9px');
    expect(hit.style.top).toBe('13px');
    await act(async () => hit.click());
    expect(onPoke).toHaveBeenCalledTimes(1);
  });
});
