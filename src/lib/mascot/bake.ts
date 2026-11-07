import type { MascotFrameData } from '@/lib/mascot/frames';

/**
 * 把一帧像素数据烘成 64×64 的小画布（1 格 = 1 像素），按（帧号 + 外缘色）缓存。
 * 角色：纯功能。播放器（MarcelSprite）与关于页的变身动画（PixelMorphCanvas）共用这一份，
 * 保证变身落地那一帧与之后的播放逐像素一致。
 */
const bakeCache = new Map<string, HTMLCanvasElement>();
const BAKE_CACHE_LIMIT = 400;

export function bakeMascotFrame(data: MascotFrameData, index: number, rim: string): HTMLCanvasElement {
  const key = `${index}|${rim}`;
  const hit = bakeCache.get(key);
  if (hit) return hit;
  const [w, h] = data.size;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (ctx) {
    const rows = data.frames[index];
    for (let y = 0; y < h; y++) {
      const row = rows[y];
      let x = 0;
      while (x < w) {
        const ch = row[x];
        let end = x + 1;
        while (end < w && row[end] === ch) end++;
        if (ch !== '.') {
          const color = ch === 'O' ? rim : data.palette[ch];
          if (color) {
            ctx.fillStyle = color;
            ctx.fillRect(x, y, end - x, 1);
          }
        }
        x = end;
      }
    }
  }
  if (bakeCache.size >= BAKE_CACHE_LIMIT) bakeCache.clear(); // 只在频繁换主题时才会撑到；整体清掉重烤即可
  bakeCache.set(key, c);
  return c;
}

/** 描边外那一圈外缘的颜色：跟主题的强边框色走。 */
export function readMascotRim(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--color-edge-strong').trim();
  return v || 'rgba(128,128,128,0.6)';
}
