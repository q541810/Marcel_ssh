// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MascotPlayground from './MascotPlayground';
import { loadMascotFrames } from '@/lib/mascot/frames';

let root: Root;
let host: HTMLDivElement;
let resizeCallback: ResizeObserverCallback | null = null;
let observed: Element[] = [];
let frameCallback: FrameRequestCallback | null = null;
let nextFrameId = 1;
const frameCallbacks = new Map<number, FrameRequestCallback>();

beforeEach(async () => {
  await loadMascotFrames();
  resizeCallback = null;
  observed = [];
  frameCallback = null;
  nextFrameId = 1;
  frameCallbacks.clear();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameCallback = callback;
    const id = nextFrameId++;
    frameCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frameCallbacks.delete(id); });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
    observe(element: Element): void { observed.push(element); }
    disconnect(): void {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  // jsdom 没有 Pointer Capture；只补接口，事件处理仍走生产组件。
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: () => {},
    hasPointerCapture: () => false,
    releasePointerCapture: () => {},
  });
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

function pointer(target: Element, type: string, x: number, y: number, id = 1): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 104 - y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: true }, pointerType: { value: 'touch' } });
  act(() => { target.dispatchEvent(event); });
}

async function mount(): Promise<{ hit: HTMLElement; actor: HTMLElement; area: HTMLElement }> {
  await act(async () => root.render(<MascotPlayground conversationId="c1" visible />));
  await act(async () => { await Promise.resolve(); });
  const hit = host.querySelector<HTMLElement>('[data-mascot-hit="body"]')!;
  const actor = host.querySelector<HTMLElement>('[data-mascot-actor]')!;
  const area = actor.parentElement!;
  expect(hit).not.toBeNull();
  expect(actor.getAttribute('aria-label')).toBe('玛瑟尔，可以拖动或扔出去');
  return { hit, actor, area };
}

/** jsdom 无布局：给画布与真实身体热区相同的尺寸，再驱动组件注册的真实 ResizeObserver。 */
function layout(area: HTMLElement, hit: HTMLElement, width = 328, left = 9, height = 48): void {
  area.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: 104, width, height: 104, x: 0, y: 0, toJSON: () => ({}) });
  Object.defineProperty(hit, 'offsetWidth', { configurable: true, get: () => 48 });
  Object.defineProperty(hit, 'offsetHeight', { configurable: true, get: () => height });
  // 纯 DOM 测量：外层 absolute 相对活动区左下，内层 perch 把透明边往外挪。
  Object.defineProperty(hit, 'offsetLeft', { configurable: true, get: () => left });
  Object.defineProperty(hit, 'offsetTop', { configurable: true, get: () => 13 });
  // actor = 64×64 画布，hit = 9,13 起的 48×48 身体；不含任何 transform。
  actorRect(area.parentElement!.querySelector<HTMLElement>('[data-mascot-actor]')!, hit);
  const callback: ResizeObserverCallback | null = resizeCallback;
  expect(callback).not.toBeNull();
  act(() => { callback?.([], {} as ResizeObserver); });
}

/** 只模拟 DOM 几何；浏览器里这些值由 CSS 和实际像素尺寸给出。 */
function actorRect(actor: HTMLElement, hit: HTMLElement): void {
  const x = Number.parseFloat(actor.style.transform.match(/translate3d\(([-\d.]+)px/)?.[1] ?? '0');
  const lift = -Number.parseFloat(actor.style.transform.match(/, ([-\d.]+)px/)?.[1] ?? '0');
  actor.getBoundingClientRect = () => ({ left: x, right: x + 64, top: 40 - lift, bottom: 104 - lift, width: 64, height: 64, x, y: 40 - lift, toJSON: () => ({}) });
  hit.getBoundingClientRect = () => ({ left: x + 9, right: x + 57, top: 53 - lift, bottom: 101 - lift, width: 48, height: 48, x: x + 9, y: 53 - lift, toJSON: () => ({}) });
}

describe('玛瑟尔活动区 DOM 接线', () => {
  it('真实身体热区与活动区共同确定初始位置和拖拽偏移', async () => {
    const { hit, actor, area } = await mount();
    expect(hit.style.touchAction).toBe('none');
    // 固定高度的 area 不会在横向缩放时通知；内容列必须也在观察列表里。
    expect(observed).toContain(area.parentElement);
    layout(area, hit);
    // 左边为 -9；328 - 9 - 48 = 271，正好让身体右边贴活动区右边。
    expect(actor.style.transform).toBe('translate3d(271.00px, 0.00px, 0)');
    pointer(hit, 'pointerdown', 290, 10);
    actorRect(actor, hit);
    pointer(hit, 'pointermove', 220, 40);
    actorRect(actor, hit);
    expect(actor.style.transform).toBe('translate3d(201.00px, -22.00px, 0)');
    expect(hit.style.cursor).toBe('grabbing');
    pointer(hit, 'pointerup', 220, 40);
    expect(hit.style.cursor).toBe('');
    expect(area.contains(hit)).toBe(true);
  });

  it('拖拽姿态和松手收势由真实帧循环推进，不依赖 ResizeObserver 救火', async () => {
    const { hit, actor, area } = await mount();
    layout(area, hit);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const frame = (dt: number) => {
      now += dt;
      const pending = [...frameCallbacks.entries()];
      frameCallbacks.clear();
      act(() => { for (const [, callback] of pending) callback(now); });
    };
    pointer(hit, 'pointerdown', 290, 10);
    actorRect(actor, hit);
    pointer(hit, 'pointermove', 240, 20);
    frame(24);
    pointer(hit, 'pointermove', 200, 40);
    expect(frameCallback).not.toBeNull();
    const pose = actor.querySelector<HTMLElement>('[data-mascot-pose]')!;
    expect(pose.style.scale).not.toBe('1 1');
    pointer(hit, 'pointerup', 200, 40);
    for (let i = 0; i < 30; i += 1) frame(16);
    expect(actor.style.transform).toContain(', 0.00px, 0)');
  });

  it('拖拽松手吞掉合成 click；轻点也已经吞掉，不会重复起跳', async () => {
    const { hit, actor, area } = await mount();
    layout(area, hit);
    pointer(hit, 'pointerdown', 290, 10);
    pointer(hit, 'pointermove', 220, 40);
    pointer(hit, 'pointerup', 220, 40);
    const draggedClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { hit.dispatchEvent(draggedClick); });
    expect(draggedClick.defaultPrevented).toBe(true);

    pointer(hit, 'pointerdown', 220, 40);
    pointer(hit, 'pointerup', 220, 40);
    const tapClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { hit.dispatchEvent(tapClick); });
    // 点按的弹跳在 pointerup 里播过了；这里再放一次会跳两下。
    expect(tapClick.defaultPrevented).toBe(true);
    expect(actor.style.position).toBe('absolute');
  });

  it('第二根手指不改变当前手势；取消不抛掷，卸载清理样式与计时器', async () => {
    const { hit, actor, area } = await mount();
    layout(area, hit);
    const initial = actor.style.transform;
    pointer(hit, 'pointerdown', 290, 10, 1);
    pointer(hit, 'pointerdown', 203, 63, 2);
    pointer(hit, 'pointermove', 160, 30, 2);
    expect(actor.style.transform).toBe(initial);
    pointer(hit, 'pointercancel', 160, 30, 1);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { hit.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    act(() => root.unmount());
    expect(actor.style.cssText).toBe('');
  });
});
