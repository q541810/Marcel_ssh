// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImagePreviewProps } from '@/lib/imagePreview';
import { resetBackHandlers } from './backHandler';
import MobileImageViewer from './MobileImageViewer';

const native = vi.hoisted(() => ({
  preview: vi.fn(),
  cleanup: vi.fn(async () => {}),
  subscribe: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  sftpPreviewImage: native.preview,
  sftpPreviewCleanup: native.cleanup,
}));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset:${path}`,
}));
vi.mock('@/lib/tauriEvent', () => ({
  subscribeTauriEventReady: native.subscribe,
}));

const localSource = { kind: 'local', src: 'blob:photo' } as const;
const onClose = vi.fn();
let host: HTMLDivElement;
let root: Root;
let trigger: HTMLButtonElement;
let viewport: DOMRect;
const resizes = new Set<() => void>();
let reportProgress:
  | ((progress: { previewId: string; written: number; total: number }) => void)
  | undefined;

function Harness({
  source = localSource,
  fileName = 'photo.png',
  fileSize,
}: Partial<Omit<ImagePreviewProps, 'open' | 'onClose'>>) {
  const [open, setOpen] = useState(true);
  return (
    <MobileImageViewer
      open={open}
      source={source}
      fileName={fileName}
      fileSize={fileSize}
      onClose={() => {
        setOpen(false);
        onClose();
      }}
    />
  );
}

async function renderViewer(props: Partial<ImagePreviewProps> = {}) {
  await act(async () => root.render(<Harness {...props} />));
}

function button(name: string) {
  const found = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${name}"]`,
  );
  if (!found) throw new Error(`Missing viewer button: ${name}`);
  return found;
}

function stage() {
  return document.querySelector<HTMLDivElement>('[aria-label="图片预览"]')!;
}

function image() {
  return document.querySelector<HTMLImageElement>('img')!;
}

function scale() {
  return document.querySelector('output[aria-label="图片缩放比例"]')
    ?.textContent;
}

async function loadImage(width = 1200, height = 800) {
  const img = image();
  Object.defineProperties(img, {
    naturalWidth: { configurable: true, value: width },
    naturalHeight: { configurable: true, value: height },
  });
  await act(async () => img.dispatchEvent(new Event('load')));
}

async function click(name: string) {
  await act(async () => button(name).click());
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTime(ms));
}

type TouchPoint = { clientX: number; clientY: number };
const point = (clientX: number, clientY = 200): TouchPoint => ({
  clientX,
  clientY,
});

async function touch(type: string, points: TouchPoint[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: points });
  await act(async () => stage().dispatchEvent(event));
}

async function tap(x = 300, y = 200) {
  await touch('touchstart', [point(x, y)]);
  await touch('touchend', []);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetBackHandlers();
  resizes.clear();
  viewport = new DOMRect(0, 0, 600, 400);
  native.subscribe.mockImplementation(async (_event, handler) => {
    reportProgress = handler;
    return vi.fn();
  });
  native.preview.mockResolvedValue({ localPath: '/previews/remote.png' });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      return this.getAttribute('aria-label') === '图片预览'
        ? viewport
        : new DOMRect(0, 0, 0, 0);
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      notify: () => void;
      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {
        resizes.add(this.notify);
      }
      disconnect() {
        resizes.delete(this.notify);
      }
    },
  );
  trigger = document.createElement('button');
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
  resetBackHandlers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('MobileImageViewer', () => {
  it('本地图片等待解码后可缩放、旋转、复位，未知大小不显示为零', async () => {
    await renderViewer();
    const dialog = document.querySelector('[role="dialog"]')!;
    const label = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(label)?.textContent).toBe('photo.png');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(stage().getAttribute('aria-busy')).toBe('true');
    expect(button('放大图片').disabled).toBe(true);
    expect(document.body.textContent).not.toContain('0 B');
    expect(document.activeElement).toBe(button('关闭'));

    await loadImage();
    expect(stage().getAttribute('aria-busy')).toBe('false');
    expect(scale()).toBe('50%');
    expect(document.body.textContent).toContain('1200×800');
    await click('放大图片');
    expect(scale()).toBe('63%');
    await click('缩小图片');
    expect(scale()).toBe('50%');
    await click('旋转');
    expect(image().style.transform).toContain('rotate(90deg)');
    expect(scale()).toBe('33%');
    await click('放大图片');
    await click('适应窗口');
    expect(scale()).toBe('33%');

    await click('关闭');
    await advance(450);
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.querySelector('img')).toBeNull();
    expect(native.preview).not.toHaveBeenCalled();
    expect(native.cleanup).not.toHaveBeenCalled();
  });

  it('捏合后剩下一根手指从当前位置平移，不跳回捏合前的起点', async () => {
    await renderViewer();
    await loadImage();
    await touch('touchstart', [point(250), point(350)]);
    await touch('touchmove', [point(200), point(400)]);
    expect(scale()).toBe('100%');
    await touch('touchend', [point(400)]);
    await touch('touchmove', [point(450, 240)]);
    expect(image().style.transform).toContain('translate(50px, 40px) scale(1)');
    await touch('touchend', []);
    await advance(350);
    expect(button('关闭')).toBeTruthy();
  });

  it('双击以触点放大，单击继续隐藏和显示工具栏', async () => {
    await renderViewer();
    await loadImage();
    await tap(400);
    await advance(120);
    await tap(400);
    expect(scale()).toBe('125%');
    expect(image().style.transform).toContain('translate(-150px, 0px)');
    await advance(350);
    expect(button('关闭')).toBeTruthy();

    await tap();
    await advance(350);
    expect(document.querySelector('button[aria-label="关闭"]')).toBeNull();
    expect(document.activeElement).toBe(stage());
    const label = document
      .querySelector('[role="dialog"]')!
      .getAttribute('aria-labelledby')!;
    expect(document.getElementById(label)?.textContent).toBe('photo.png');
    await tap();
    await advance(350);
    expect(button('关闭')).toBeTruthy();
  });

  it('切图清空旧图几何与待执行的单击，旧图片事件不会覆盖新图', async () => {
    await renderViewer();
    await loadImage();
    await click('旋转');
    await tap();
    const previousImage = image();
    await renderViewer({
      source: { kind: 'local', src: 'blob:second' },
      fileName: 'second.png',
    });
    expect(scale()).toBe('—');
    expect(button('旋转').disabled).toBe(true);
    await act(async () => previousImage.dispatchEvent(new Event('load')));
    await advance(350);
    expect(button('关闭')).toBeTruthy();
    expect(stage().getAttribute('aria-busy')).toBe('true');
    await loadImage(400, 200);
    expect(image().getAttribute('src')).toBe('blob:second');
    expect(image().style.transform).toContain('rotate(0deg)');
    expect(scale()).toBe('100%');
    expect(native.cleanup).not.toHaveBeenCalled();
  });

  it('图片解码失败可切换备用来源，完全损坏时显示错误并仍可关闭', async () => {
    await renderViewer({
      source: {
        kind: 'local',
        src: 'blob:expired',
        fallbackSrc: 'data:image/png;base64,valid',
      },
    });
    await act(async () => image().dispatchEvent(new Event('error')));
    expect(image().getAttribute('src')).toBe('data:image/png;base64,valid');
    expect(stage().getAttribute('aria-busy')).toBe('true');
    await loadImage();
    expect(scale()).toBe('50%');

    await renderViewer({ source: { kind: 'local', src: 'blob:broken' } });
    await act(async () => image().dispatchEvent(new Event('error')));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      '图片无法显示',
    );
    expect(document.querySelector('img')).toBeNull();
    expect(stage().getAttribute('aria-busy')).toBe('false');
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await advance(450);
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('横竖屏变化重新适应窗口，用户放大后只校准边界', async () => {
    await renderViewer();
    await loadImage();
    viewport = new DOMRect(0, 0, 400, 600);
    await act(async () => resizes.forEach((notify) => notify()));
    expect(scale()).toBe('33%');
    await click('放大图片');
    expect(scale()).toBe('42%');
    viewport = new DOMRect(0, 0, 500, 300);
    await act(async () => resizes.forEach((notify) => notify()));
    expect(scale()).toBe('42%');
    await click('适应窗口');
    expect(scale()).toBe('38%');
  });

  it('系统返回只关闭一层，清掉延时单击且不重新唤起输入框', async () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    await renderViewer();
    await loadImage();
    const focus = vi.spyOn(textarea, 'focus');
    await tap();
    expect(
      document.querySelectorAll('[data-region="mobile-image-viewer"]'),
    ).toHaveLength(1);
    await act(async () => expect(window.__marcelHandleBack?.()).toBe(true));
    await advance(450);
    expect(onClose).toHaveBeenCalledOnce();
    expect(window.__marcelHandleBack?.()).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(resizes.size).toBe(0);
    textarea.remove();
  });

  it('SFTP 进度保留，切到本地来源后迟到下载只回收自己的临时文件', async () => {
    let resolveDownload!: (value: { localPath: string }) => void;
    native.preview.mockReturnValue(
      new Promise<{ localPath: string }>((resolve) => {
        resolveDownload = resolve;
      }),
    );
    await renderViewer({
      source: { kind: 'sftp', sessionId: 'ssh', filePath: '/remote.png' },
      fileSize: 400,
    });
    const previewId = native.preview.mock.calls[0][2] as string;
    await act(async () =>
      reportProgress?.({ previewId, written: 100, total: 400 }),
    );
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      '25%',
    );
    expect(document.querySelector('img')).toBeNull();

    await renderViewer({ source: localSource });
    expect(image().getAttribute('src')).toBe('blob:photo');
    await act(async () => resolveDownload({ localPath: '/previews/late.png' }));
    expect(native.cleanup).toHaveBeenCalledWith('/previews/late.png');
    expect(image().getAttribute('src')).toBe('blob:photo');
    await loadImage();
    expect(scale()).toBe('50%');
    await click('关闭');
    await advance(450);
    expect(native.cleanup).toHaveBeenCalledTimes(1);
  });
});
