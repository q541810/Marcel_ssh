// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImagePreviewProps } from '@/lib/imagePreview';
import ImagePreviewModal from './ImagePreviewModal';

const native = vi.hoisted(() => ({
  read: vi.fn(),
  cleanup: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('@/lib/tauri', () => ({
  sftpPreviewImage: native.read,
  sftpPreviewCleanup: native.cleanup,
}));
vi.mock('@/lib/tauriEvent', () => ({
  subscribeTauriEventReady: native.subscribe,
}));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

let root: Root;
let host: HTMLDivElement;
let trigger: HTMLButtonElement;
let canvasRect: DOMRect;
let notifyResize: () => void;
const disconnect = vi.fn();

function Harness({
  options,
  onClose,
}: {
  options: Partial<ImagePreviewProps>;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <ImagePreviewModal
      source={{ kind: 'local', src: 'blob:screen' }}
      fileName="screen.png"
      {...options}
      open={open}
      onClose={() => {
        setOpen(false);
        onClose();
      }}
    />
  );
}

async function renderPreview(options: Partial<ImagePreviewProps> = {}) {
  const onClose = vi.fn();
  await act(async () =>
    root.render(<Harness options={options} onClose={onClose} />),
  );
  const canvas = document.querySelector<HTMLDivElement>(
    '[aria-label="图片预览"]',
  )!;
  vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(
    () => canvasRect,
  );
  return { onClose, canvas };
}

function image() {
  return document.querySelector<HTMLImageElement>('img')!;
}
function zoom() {
  return document.querySelector('output')?.textContent;
}
function button(label: string) {
  return document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function decoded(width = 1200, height = 800) {
  Object.defineProperties(image(), {
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true },
  });
  await act(async () => image().dispatchEvent(new Event('load')));
}
async function key(keyValue: string, shiftKey = false) {
  await act(async () =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: keyValue,
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  native.read.mockReset();
  native.cleanup.mockReset().mockResolvedValue(undefined);
  native.subscribe.mockReset().mockResolvedValue(vi.fn());
  disconnect.mockReset();
  canvasRect = new DOMRect(0, 0, 600, 400);
  notifyResize = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  trigger = document.createElement('button');
  trigger.textContent = '预览图片';
  document.body.appendChild(trigger);
  trigger.focus();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  trigger.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ImagePreviewModal 共享预览', () => {
  it('本地图片无需 SSH，解码完成后使用原有适应、旋转、翻转和快捷键', async () => {
    await renderPreview();
    expect(native.read).not.toHaveBeenCalled();
    expect(native.subscribe).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('大小:');
    expect(button('放大图片').disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      '正在加载',
    );
    await decoded();
    expect(zoom()).toBe('50%');
    await click('放大图片');
    expect(zoom()).toBe('63%');
    await click('适应窗口');
    await key('r');
    expect(image().style.transform).toContain('rotate(90deg)');
    expect(zoom()).toBe('33%');
    await key('R', true);
    expect(image().style.transform).toContain('rotate(0deg)');
    expect(zoom()).toBe('50%');
    await key('h');
    await key('v');
    expect(image().style.transform).toContain('scaleX(-1) scaleY(-1)');
    await key('1');
    expect(zoom()).toBe('100%');
    await key('ArrowRight');
    expect(image().style.transform).toContain('translate(-50px, 0px)');
    await key('0');
    expect(zoom()).toBe('50%');
    expect(image().style.transform).toContain('translate(0px, 0px)');
  });

  it('滚轮围绕鼠标缩放，拖动松手后不再跟随', async () => {
    const { canvas } = await renderPreview();
    await decoded();
    const wheel = new WheelEvent('wheel', {
      deltaY: -100,
      clientX: 450,
      clientY: 200,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => canvas.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(zoom()).toBe('57%');
    expect(image().style.transform).toContain('translate(-22.5px, 0px)');
    await act(async () =>
      image().dispatchEvent(
        new MouseEvent('mousedown', {
          clientX: 200,
          clientY: 200,
          bubbles: true,
          button: 0,
        }),
      ),
    );
    await act(async () =>
      document.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: 230,
          clientY: 250,
          bubbles: true,
        }),
      ),
    );
    expect(image().style.transform).toContain('translate(7.5px, 50px)');
    await act(async () => document.dispatchEvent(new MouseEvent('mouseup')));
    const transform = image().style.transform;
    await act(async () =>
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: 500, clientY: 500 }),
      ),
    );
    expect(image().style.transform).toBe(transform);
  });

  it('窗口改变时适应图片，手动缩放和暂时隐藏不会被重置', async () => {
    await renderPreview();
    await decoded();
    canvasRect = new DOMRect(0, 0, 300, 200);
    await act(async () => notifyResize());
    expect(zoom()).toBe('25%');
    canvasRect = new DOMRect(0, 0, 0, 0);
    await act(async () => notifyResize());
    expect(zoom()).toBe('25%');
    canvasRect = new DOMRect(0, 0, 600, 400);
    await act(async () => notifyResize());
    await click('放大图片');
    canvasRect = new DOMRect(0, 0, 300, 200);
    await act(async () => notifyResize());
    expect(zoom()).toBe('63%');
  });

  it('blob 失效后使用附件备用内容，关闭不会删除调用方图片', async () => {
    await renderPreview({
      source: {
        kind: 'local',
        src: 'blob:expired',
        fallbackSrc: 'data:image/png;base64,backup',
      },
    });
    const expired = image();
    await act(async () => expired.dispatchEvent(new Event('error')));
    expect(image().getAttribute('src')).toBe('data:image/png;base64,backup');
    expect(expired.isConnected).toBe(false);
    await decoded();
    expect(zoom()).toBe('50%');
    await click('关闭');
    await act(async () => vi.advanceTimersByTime(450));
    expect(image()).toBeNull();
    expect(native.cleanup).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('解码错误明确展示，Escape 只关闭一次并解除焦点与监听', async () => {
    const { onClose } = await renderPreview();
    trigger.focus();
    expect(document.activeElement).toBe(button('关闭'));
    await act(async () => image().dispatchEvent(new Event('error')));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      '图片无法显示',
    );
    expect(document.querySelector('[role="status"]')).toBeNull();
    await key('Escape');
    await key('Escape');
    await act(async () => vi.advanceTimersByTime(450));
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('SFTP 来源仍显示原路径和下载进度，只回收下载的临时文件', async () => {
    let finish: (value: { localPath: string }) => void = () => {};
    native.read.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await renderPreview({
      source: {
        kind: 'sftp',
        sessionId: 'server',
        filePath: '/var/screens/latest.png',
      },
      fileSize: 1024,
    });
    expect(native.read).toHaveBeenCalledWith(
      'server',
      '/var/screens/latest.png',
      expect.any(String),
    );
    expect(document.querySelector('h2')?.textContent).toBe(
      '/var/screens/latest.png',
    );
    const previewId = native.read.mock.calls[0][2] as string;
    const progress = native.subscribe.mock.calls[0][1] as (value: {
      previewId: string;
      written: number;
      total: number;
    }) => void;
    await act(async () => progress({ previewId, written: 512, total: 1024 }));
    expect(document.body.textContent).toContain('50%');
    await act(async () => finish({ localPath: 'preview/one.png' }));
    expect(image().getAttribute('src')).toBe('asset://preview/one.png');
    await decoded();
    await click('关闭');
    await act(async () => vi.advanceTimersByTime(450));
    expect(native.cleanup).toHaveBeenCalledWith('preview/one.png');
    expect(disconnect).toHaveBeenCalled();
  });
});
