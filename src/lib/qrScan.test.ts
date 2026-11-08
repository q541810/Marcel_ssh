import { describe, expect, it } from 'vitest';
import {
  acceptScannedSyncCode,
  cameraErrorMessage,
  decodeQrFromImageData,
  maskSyncCode,
} from './qrScan';
import { buildQrMatrix, MIN_MODULE_PX, qrRenderPlan, scaledPath } from '@/components/settings/sync/qrMatrix';

/**
 * 这套测试刻意不 mock：真的把同步码编成二维码 → 按 `QrCode` 实际使用的整数格方案栅格化成位图
 * → 再用 jsQR 解回来。它就是"手机能不能扫出来"的可执行版本，尺寸方案一旦退回按 CSS 缩放就会红。
 */

/** 按真实 SFTP 同步码的形状造一条长码（1100 字符上下，v27 / 133 模块）。 */
function longSftpSyncCode(): string {
  const connection = {
    id: '5b0ea82a-fa93-43d4-ae88-bd5b3bda15c0',
    name: 'jinye',
    host: '103.212.186.170',
    port: 45,
    username: 'root',
    authMethod: 'Password',
    keyPath: null,
    keyId: null,
    group: null,
    lastConnected: null,
    useJump: false,
    host_placeholder: 'x'.repeat(120),
    remotePlatform: 'linux',
  };
  const payload = {
    storage: { kind: 'sftp', connectionId: connection.id, root: 'marcel-sync' },
    secret: 'x'.repeat(24),
    rk: 'k3j9m2p4q7r1s5t8u0v6w2x4y7z1a3b5',
    sftpConnection: {
      connection,
      hostKey: {
        host: '103.212.186.170',
        port: 45,
        entry: {
          algorithm: 'ssh-ed25519',
          fingerprint_sha256: 'SHA256:+FIIcHDga+VvJ/J1TrSZvXfq9eAKjBpzkv+rc7Hunqw',
          first_seen: '2026-10-19T06:53:26.802573800+00:00',
          last_seen: '2026-10-19T06:53:26.802573800+00:00',
        },
      },
    },
  };
  return `MSYNC1-${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

const SHORT_CODE = 'MSYNC1-aGVsbG8td29ybGQtdGhpcy1pcy1hLXNob3J0LXN5bmMtY29kZQ';

/**
 * 把 path 画成 RGBA 位图。坐标就是 `QrCode` 喂给 SVG 的设备像素坐标，
 * 所以这里产出的位图与屏幕上真实渲染出来的格子一一对应。
 */
function rasterize(matrix: ReturnType<typeof buildQrMatrix>, modulePx: number) {
  const device = matrix!.size * modulePx;
  const data = new Uint8ClampedArray(device * device * 4).fill(255);
  const path = scaledPath(matrix!, modulePx);
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

/**
 * 模拟手机拍照：先把位图放大（传感器分辨率高于屏幕），再叠一层镜头模糊。
 *
 * 为什么测试里非得有这一步：一张"完美无瑕"的位图，哪怕每格只有 2 个像素，解码器也能解出来——
 * 但手机拍到的是经过镜头、对焦、屏幕子像素混合之后的画面，格子细到 2 个像素时就已经糊成一片了。
 * 早先的 168px 内联二维码就是栽在这里（每格 1.26 像素，实测 0/9）。
 */
function captureBlur(
  img: { data: Uint8ClampedArray; width: number; height: number },
  upscale = 2,
  passes = 2,
) {
  const n = Math.max(1, Math.round(img.width * upscale));
  const data = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y += 1) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / n));
    for (let x = 0; x < n; x += 1) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / n));
      const s = (sy * img.width + sx) * 4;
      const d = (y * n + x) * 4;
      data[d] = img.data[s];
      data[d + 1] = img.data[s + 1];
      data[d + 2] = img.data[s + 2];
      data[d + 3] = 255;
    }
  }
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  let current = data;
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Uint8ClampedArray(current);
    for (let y = 1; y < n - 1; y += 1) {
      for (let x = 1; x < n - 1; x += 1) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            sum += current[((y + dy) * n + (x + dx)) * 4] * kernel[(dy + 1) * 3 + (dx + 1)];
          }
        }
        const i = (y * n + x) * 4;
        next[i] = next[i + 1] = next[i + 2] = sum / 16;
      }
    }
    current = next;
  }
  return { data: current, width: n, height: n };
}

describe('decodeQrFromImageData', () => {
  it('短同步码：按整数格栅格化后能解回原文', () => {
    const matrix = buildQrMatrix(SHORT_CODE);
    expect(matrix).not.toBeNull();
    const { data, width, height } = rasterize(matrix, 4);
    expect(decodeQrFromImageData(data, width, height)).toBe(SHORT_CODE);
  });

  it('长 SFTP 同步码：每格 4 个设备像素时，即使模拟镜头模糊也能解出', () => {
    const code = longSftpSyncCode();
    const matrix = buildQrMatrix(code);
    expect(matrix).not.toBeNull();
    // 真实形状确实是高版本二维码（这正是当年 168px 装不下的原因）
    expect(matrix!.moduleCount).toBeGreaterThanOrEqual(100);

    const shot = captureBlur(rasterize(matrix, 4));
    expect(decodeQrFromImageData(shot.data, shot.width, shot.height)).toBe(code);
  });

  it('空白帧 / 尺寸非法的帧一律返回 null，不抛错', () => {
    const blank = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    expect(decodeQrFromImageData(blank, 64, 64)).toBeNull();
    expect(decodeQrFromImageData(blank, 0, 64)).toBeNull();
    expect(decodeQrFromImageData(new Uint8ClampedArray(10), 64, 64)).toBeNull();
  });
});

describe('qrRenderPlan 与真实渲染的一致性', () => {
  it('可用宽度够时每格恰好 4 个设备像素；高分屏下能塞下更多', () => {
    const matrix = buildQrMatrix(longSftpSyncCode())!;
    // 宽度刚好等于 模块数 × 4：每格 4 个设备像素
    const exact = matrix.size * 4;
    expect(qrRenderPlan(matrix, exact, 1).modulePx).toBe(4);
    // 同样的 300px 在高分屏上是 600 个设备像素，能分到的格子更大
    expect(qrRenderPlan(matrix, 300, 2).modulePx).toBeGreaterThan(
      qrRenderPlan(matrix, 300, 1).modulePx,
    );
  });

  it('可用宽度不够时 fits 为 false，modulePx 仍不低于 MIN_MODULE_PX', () => {
    const matrix = buildQrMatrix(longSftpSyncCode())!;
    for (const maxSize of [300, 160, 40, 1, 0]) {
      const plan = qrRenderPlan(matrix, maxSize, 1);
      expect(plan.modulePx).toBeGreaterThanOrEqual(MIN_MODULE_PX);
      expect(plan.fits).toBe(false);
    }
    // 133 个模块要 399px 才够每格 3 个设备像素——这正是设置行装不下的原因
    expect(qrRenderPlan(matrix, matrix.size * MIN_MODULE_PX, 1).fits).toBe(true);
    expect(matrix.size * MIN_MODULE_PX).toBeGreaterThan(320);
  });
});

describe('acceptScannedSyncCode', () => {
  it('同步码通过，并把首尾空白裁掉', () => {
    expect(acceptScannedSyncCode(`  ${SHORT_CODE}\n`)).toEqual({ ok: true, code: SHORT_CODE });
  });

  it('别的二维码被挡下并说清楚', () => {
    const verdict = acceptScannedSyncCode('https://example.com/hello');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('不是玛瑟尔的同步码');
  });

  it('将来版本的同步码提示去升级', () => {
    const verdict = acceptScannedSyncCode('MSYNC2-abcdefghijklmnopqrstuvwxyz');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('升级');
  });

  it('只扫到一小截（被遮挡）时提示重扫', () => {
    const verdict = acceptScannedSyncCode('MSYNC1-ab');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('重新扫');
  });

  it('空内容提示对准取景框', () => {
    const verdict = acceptScannedSyncCode('   ');
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('取景框');
  });
});

describe('maskSyncCode', () => {
  it('只留前 12 位和后 4 位', () => {
    const masked = maskSyncCode(SHORT_CODE);
    expect(masked).toBe(`${SHORT_CODE.slice(0, 12)}…${SHORT_CODE.slice(-4)}`);
    expect(masked).not.toContain(SHORT_CODE.slice(20, -4));
  });

  it('太短的码原样返回（本来就没什么可藏的）', () => {
    expect(maskSyncCode('MSYNC1-short')).toBe('MSYNC1-short');
  });
});

describe('cameraErrorMessage', () => {
  it('把常见的 getUserMedia 失败翻成人话，每条都说清楚用户能做什么', () => {
    expect(cameraErrorMessage({ name: 'NotAllowedError' })).toContain('相机权限被拒绝');
    expect(cameraErrorMessage({ name: 'SecurityError' })).toContain('相机权限被拒绝');
    expect(cameraErrorMessage({ name: 'NotFoundError' })).toContain('没找到可用的相机');
    expect(cameraErrorMessage({ name: 'OverconstrainedError' })).toContain('没找到可用的相机');
    expect(cameraErrorMessage({ name: 'NotReadableError' })).toContain('被别的应用占用');
    expect(cameraErrorMessage(new Error('boom'))).toContain('打不开相机');
    // 每条都要给出退路：手动粘贴永远可用
    for (const err of [
      { name: 'NotAllowedError' },
      { name: 'NotFoundError' },
      new Error('boom'),
    ]) {
      expect(cameraErrorMessage(err)).toContain('手动粘贴同步码');
    }
  });
});
