import { create as createQr } from 'qrcode';

/** 二维码四周的空白（以模块为单位）。扫码器靠它找到边界，规范要求至少 4 个。 */
export const QUIET_ZONE = 4;

/**
 * 每模块最少占多少个**设备像素**。低于 3 个时扫码器基本不可靠：
 * 同步码这种长内容会到 v27（125 模块 + 静区 = 133），曾经按固定的 168 CSS px 画，
 * 每格只剩 1.26 px，`crispEdges` 取整后同一张码里有的格子 1 px、有的 2 px，
 * 相机采样必然错位（实测 168px 下 0/9 次能解出）。尺寸足够时再往上加没有收益。
 */
export const MIN_MODULE_PX = 3;

export interface QrMatrix {
  /** 含静区在内的总模块数（= 模块数 + 2 × 静区）。渲染时 `viewBox` 用 `0 0 size size`。 */
  size: number;
  /** 不含静区的模块数（21 / 25 / … / 125）。只用于文案与测试。 */
  moduleCount: number;
  /** 深色模块逐行合并成的 SVG path（坐标**不含**静区偏移，已按静区平移好）。 */
  path: string;
}

/**
 * 把文本编码成二维码矩阵并拼成一条 SVG path（纯前端、同步、不经 innerHTML）。
 * 编码失败（内容超过二维码容量）返回 null，由调用方退回"只显示文字"。
 */
export function buildQrMatrix(text: string): QrMatrix | null {
  try {
    const qr = createQr(text, { errorCorrectionLevel: 'M' });
    const moduleCount = qr.modules.size;
    const parts: string[] = [];
    for (let row = 0; row < moduleCount; row += 1) {
      let col = 0;
      while (col < moduleCount) {
        if (!qr.modules.get(row, col)) {
          col += 1;
          continue;
        }
        const start = col;
        while (col < moduleCount && qr.modules.get(row, col)) col += 1;
        parts.push(
          `M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${col - start}v1h-${col - start}z`,
        );
      }
    }
    return {
      size: moduleCount + QUIET_ZONE * 2,
      moduleCount,
      path: parts.join(''),
    };
  } catch {
    return null;
  }
}

/**
 * 把一个 CSS 尺寸换算成"整数个设备像素每格"的渲染参数。
 *
 * 二维码必须画在整数格上：格子边界落在半像素上会被抗锯齿糊成灰，扫码器就分不清黑白。
 * 所以在**设备像素**坐标系里选整数 `modulePx`，再把总尺寸换回 CSS px
 * （CSS 上允许小数，落到屏幕上仍是整数设备像素）。
 *
 * `modulePx` 取 `maxSize × dpr ÷ size` 的整数部分，但**不低于** [`MIN_MODULE_PX`]——
 * 位置不够时宁可超出可用宽度，也不能画一张扫不出来的码。
 *
 * `fits` 说明这块地方到底够不够：`false` 时调用方**不要**把它画进来
 * （该改用放大弹层，或者干脆给一句"这里画不下"），因为硬塞进来的那张图扫不出来，
 * 比不显示更糟——用户会对着它反复试，然后得出"这功能坏了"的结论。
 */
export function qrRenderPlan(
  matrix: QrMatrix,
  maxSize: number,
  dpr: number,
): { modulePx: number; cssSize: number; fits: boolean } {
  const ratio = dpr > 0 ? dpr : 1;
  const fit = Math.floor((maxSize * ratio) / matrix.size);
  const modulePx = Math.max(MIN_MODULE_PX, fit);
  return {
    modulePx,
    cssSize: (matrix.size * modulePx) / ratio,
    fits: fit >= MIN_MODULE_PX,
  };
}

/**
 * 按整数倍放大 path 的坐标，让一条 path 直接落在设备像素网格上。
 *
 * 不用 `transform: scale()`：SVG 的缩放是浮点矩阵，`crispEdges` 只能让最终栅格化"尽量"对齐，
 * 而这里每个格子从源头就是整数坐标，渲染器没有四舍五入的余地。
 */
export function scaledPath(matrix: QrMatrix, modulePx: number): string {
  if (modulePx === 1) return matrix.path;
  return matrix.path.replace(
    /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g,
    (_, x: string, y: string, w: string) =>
      `M${Number(x) * modulePx} ${Number(y) * modulePx}h${Number(w) * modulePx}v${modulePx}h-${Number(w) * modulePx}z`,
  );
}
