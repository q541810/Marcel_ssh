import jsQR from 'jsqr';
import { isPlausibleSyncCode, SYNC_CODE_PREFIX } from './syncModel';

/**
 * 手机端「扫码加入同步」的解码与判定。纯函数，不碰 DOM 与相机——相机那一层在
 * `src/mobile/MobileQrScanner.tsx`，这里只负责"这一帧里有没有二维码"和"这串东西是不是我们的同步码"。
 *
 * 之所以分出来：判定逻辑（前缀、长度、打码展示）要能被单测直接钉住，
 * 而真实解码路径也用同一套函数在 Node 里跑（不 mock），出问题先在这里暴露。
 */

/**
 * 从一帧 RGBA 位图里解出一个二维码。没有就返回 `null`。
 *
 * `data` 是 `ImageData.data` 那种 RGBA 平铺数组（每像素 4 字节）。
 * jsQR 不解成中文会抛，这里一律当"没扫到"处理——扫到一半的帧抛错不是用户的问题。
 */
export function decodeQrFromImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  if (width <= 0 || height <= 0) return null;
  if (data.length < width * height * 4) return null;
  try {
    const result = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
    const text = result?.data?.trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

export type ScannedCodeVerdict =
  | { ok: true; code: string }
  | { ok: false; reason: string };

/**
 * 扫到的文字是不是一个能用的同步码。
 *
 * 手机镜头很容易先扫到别的二维码（Wi-Fi、公众号、网址），所以要挡住并说清楚，
 * 而不是把一串莫名其妙的文字填进输入框、等用户点了「加入」才报错。
 * 真正的真伪仍由后端解码判定（见 `isPlausibleSyncCode` 的注释）。
 */
export function acceptScannedSyncCode(raw: string): ScannedCodeVerdict {
  const code = raw.trim();
  if (!code) return { ok: false, reason: '没有扫到内容，把二维码放进取景框中间再试一次。' };
  if (!code.startsWith(SYNC_CODE_PREFIX)) {
    // 「MSYNC2-」这种将来的版本，明确提示去升级，而不是笼统说"不是同步码"。
    if (/^MSYNC\d+-/.test(code)) {
      return {
        ok: false,
        reason: '这张码来自更新版本的应用，请先把这台设备上的应用升级到最新版。',
      };
    }
    return { ok: false, reason: '这不是玛瑟尔的同步码，换一张再扫。' };
  }
  if (!isPlausibleSyncCode(code)) {
    return { ok: false, reason: '这张同步码不完整，可能被遮挡了一角，重新扫一次试试。' };
  }
  return { ok: true, code };
}

/**
 * 确认卡片上的打码展示：只留前 12 位和后 4 位。
 *
 * 同步码等同于钥匙，扫完先让用户确认"是这个"就够了，没必要把整串再摊在屏幕上。
 */
export function maskSyncCode(code: string): string {
  const text = code.trim();
  if (text.length <= 20) return text;
  return `${text.slice(0, 12)}…${text.slice(-4)}`;
}

/**
 * 把 `getUserMedia` 的失败原因翻成用户能照着做的话。
 *
 * 相机打不开的原因五花八门（没权限、没相机、被别的应用占着、非安全上下文），
 * 但用户能做的动作只有三件：去系统设置给权限、关掉占用的应用重试、或者改用手动粘贴。
 * 所以每条都要说清楚**能做的那件事**，别丢一句 "NotFoundError" 了事。
 */
export function cameraErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '相机权限被拒绝了。可以在系统设置里给这个应用打开相机，或者返回上一页手动粘贴同步码。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '没找到可用的相机。可以返回上一页手动粘贴同步码。';
    case 'NotReadableError':
      return '相机被别的应用占用了，先关掉那个应用再重试。';
    default:
      return '打不开相机。可以重试，或者返回上一页手动粘贴同步码。';
  }
}
