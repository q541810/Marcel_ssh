// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MobileQrScanner from './MobileQrScanner';
import { buildQrMatrix, scaledPath } from '@/components/settings/sync/qrMatrix';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = 'MSYNC1-aGVsbG8td29ybGQtdGhpcy1pcy1hLXNob3J0LXN5bmMtY29kZQ';

/**
 * 相机与画布的替身。
 *
 * jsdom 没有 getUserMedia、没有 video 解码、没有 canvas 2d。这里造一条能跑通的假链路：
 * 假的流（记录 stop 被调了几次）、假的 video（有 videoWidth 就够）、假的 canvas
 * （getContext 返回一个把预设位图吐给解码器的 2d 上下文）。
 * 位图是**真的**按 `QrCode` 的整数格方案栅格化出来的，所以 jsQR 也真的在解。
 */
let stopCalls: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
let frameProvider: (() => { data: Uint8ClampedArray; width: number; height: number } | null) | null;
let originalMediaDevices: PropertyDescriptor | undefined;

function rasterize(text: string, modulePx = 4) {
  const matrix = buildQrMatrix(text)!;
  const device = matrix.size * modulePx;
  const data = new Uint8ClampedArray(device * device * 4).fill(255);
  const path = scaledPath(matrix, modulePx);
  const re = /M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    const x0 = Number(m[1]);
    const y0 = Number(m[2]);
    const w = Number(m[3]);
    const h = Number(m[4]);
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) {
        const i = (y * device + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
    }
  }
  return { data, width: device, height: device };
}

beforeEach(() => {
  stopCalls = vi.fn();
  frameProvider = null;
  const stream = {
    getTracks: () => [{ stop: stopCalls }],
  };
  getUserMedia = vi.fn().mockResolvedValue(stream);
  originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });

  // video：给一个非零的 videoWidth / videoHeight，让 tick 认为有画面。
  // 这两个属性在 HTMLVideoElement.prototype 上（不是 HTMLMediaElement），挂错地方读出来永远是 0。
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
    configurable: true,
    get: () => 200,
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
    configurable: true,
    get: () => 200,
  });
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined) as never;

  // canvas：drawImage 不用真的画，getImageData 直接吐帧
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    drawImage: () => {},
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const frame = frameProvider?.();
      if (!frame) {
        return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
      }
      return { data: frame.data, width: frame.width, height: frame.height };
    },
  }) as never;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalMediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  } else {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  }
});

let root: Root;
let host: HTMLDivElement;

function mount(props: Partial<Parameters<typeof MobileQrScanner>[0]> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const onClose = props.onClose ?? vi.fn();
  const onAccept = props.onAccept ?? vi.fn();
  act(() => {
    root.render(<MobileQrScanner open onClose={onClose} onAccept={onAccept} />);
  });
  return { onClose, onAccept };
}

/** 让 rAF / setTimeout 链跑几轮，把"逐帧解码"推进到能出结果。 */
async function pump(ms = 800) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function text() {
  return document.body.textContent ?? '';
}

function findButton(label: string) {
  const buttons = [...document.body.querySelectorAll('button')];
  const found = buttons.find((b) => (b.textContent ?? '').includes(label));
  if (!found) throw new Error(`没找到按钮：${label}`);
  return found;
}

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('MobileQrScanner', () => {
  it('打开就请求后置相机，扫到同步码后进确认态并立刻放掉相机', async () => {
    frameProvider = () => rasterize(CODE, 4);
    const { onAccept } = mount();
    await pump();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });

    // 扫到之后先确认再填入：此时还没有把码交给调用方
    expect(text()).toContain('扫到了同步码');
    expect(onAccept).not.toHaveBeenCalled();
    expect(text()).toContain('MSYNC1-aGVs');
    // 确认卡片上是打码的，不把整串钥匙摊在屏幕上
    expect(text()).not.toContain(CODE);

    // 相机必须马上停掉，不能等用户点确认
    expect(stopCalls).toHaveBeenCalled();

    await act(async () => {
      findButton('使用这个同步码').click();
    });
    expect(onAccept).toHaveBeenCalledWith(CODE);
  });

  it('相机权限被拒：说清楚原因、提示手动粘贴，并且可以重试', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    getUserMedia.mockRejectedValueOnce(denied);
    mount();
    await pump(50);

    expect(text()).toContain('相机权限被拒绝了');
    expect(text()).toContain('手动粘贴');
    expect(findButton('重试')).toBeTruthy();

    // 重试会再问一次相机，第二次给权限就正常进扫描态
    frameProvider = null;
    getUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop: stopCalls }] });
    await act(async () => {
      findButton('重试').click();
    });
    await pump(50);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain('相机权限被拒绝了');
  });

  it('扫到别的二维码：挡下来并说清楚，不填进输入框', async () => {
    frameProvider = () => rasterize('https://example.com/not-our-code', 4);
    const { onAccept } = mount();
    await pump();

    expect(text()).toContain('不是玛瑟尔的同步码');
    expect(onAccept).not.toHaveBeenCalled();
    expect(stopCalls).toHaveBeenCalled();
  });

  it('关闭时（点关闭 / 卸载）一定释放相机', async () => {
    frameProvider = null;
    const { onClose } = mount();
    await pump(50);
    expect(stopCalls).not.toHaveBeenCalled();

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click();
    });
    // useAnimatedClose 在卸载兜底里才真正调 onClose；stopStream 是同步的
    expect(stopCalls).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled(); // 退出动画还没播完
  });

  it('切到后台时关掉相机（Android 在后台会掐摄像头，回来是一块黑屏）', async () => {
    frameProvider = null;
    mount();
    await pump(50);
    expect(stopCalls).not.toHaveBeenCalled();

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(stopCalls).toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  it('没有 mediaDevices（非安全上下文 / 旧内核）：给明确提示而不是白屏', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    mount();
    await pump(50);
    expect(text()).toContain('不允许使用相机');
  });
});
