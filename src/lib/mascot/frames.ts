/**
 * 玛瑟尔（吉祥物）像素帧：类型、解码与按需加载。
 *
 * 数据唯一来源是 `scripts/mascot/marcel_frames.py` 生成的 `marcelFrames.json`——**别手改 JSON**，
 * 改造型 / 动作改脚本后重跑。JSON 走动态 import 单独成块：只有真的要画玛瑟尔时才下载。
 *
 * 帧格式：64×64 个字符，一行一串，行内按「字符+连续个数」压缩（`.4K2G` = 4 个透明 + 1 个 K + 2 个 G，
 * 个数为 1 时省略）。字符 → 颜色见 `palette`；`O` 是主题外缘（播放器按当前主题的强边框色画），`.` 透明。
 */

export const MASCOT_STATES = [
  'idle', 'thinking', 'running', 'approval', 'asking', 'done', 'error', 'offline', 'sleeping',
] as const;
export type MascotState = (typeof MASCOT_STATES)[number];

/** 每个状态的中文名（无障碍标签、调试用）。 */
export const MASCOT_STATE_LABEL: Record<MascotState, string> = {
  idle: '闲着',
  thinking: '思考中',
  running: '执行命令中',
  approval: '等你确认',
  asking: '有问题要问你',
  done: '完成了',
  error: '出错了',
  offline: '没有连接',
  sleeping: '睡着了',
};

export interface MascotFrameData {
  size: [number, number];
  /**
   * 人物外框（画布坐标）：`bottom` / `right` 是描边最底行 / 最右列，「坐」在横线上、贴右对齐时用；
   * `left` / `top` 是人物 48×48 区域的左上角，点击热区用（气泡、飞出的爆米花不算身体）。
   */
  anchor: { bottom: number; right: number; left: number; top: number };
  palette: Record<string, string>;
  /** 解码后的帧：每帧 H 行、每行 W 个字符。 */
  frames: string[][];
  /** 每个状态一串 [帧序号, 停留毫秒]。 */
  states: Record<MascotState, [number, number][]>;
}

interface RawFrameData extends Omit<MascotFrameData, 'frames'> {
  frames: string[][];
}

/** 解一行 RLE：字符后面跟的数字是重复次数，没有数字 = 1 次。 */
export function decodeRow(encoded: string): string {
  let out = '';
  let i = 0;
  while (i < encoded.length) {
    const ch = encoded[i++];
    let digits = '';
    while (i < encoded.length && encoded[i] >= '0' && encoded[i] <= '9') digits += encoded[i++];
    out += ch.repeat(digits ? Number(digits) : 1);
  }
  return out;
}

export function decodeFrameData(raw: RawFrameData): MascotFrameData {
  return { ...raw, frames: raw.frames.map((rows) => rows.map(decodeRow)) };
}

let loading: Promise<MascotFrameData> | null = null;
let loaded: MascotFrameData | null = null;

/** 已加载就同步给出（首帧不闪），否则返回 null 并由调用方 await `loadMascotFrames`。 */
export function peekMascotFrames(): MascotFrameData | null {
  return loaded;
}

export function loadMascotFrames(): Promise<MascotFrameData> {
  loading ??= import('./marcelFrames.json')
    .then((m) => {
      loaded = decodeFrameData((m.default ?? m) as unknown as RawFrameData);
      return loaded;
    })
    .catch((err) => {
      loading = null; // 下次再试，别把一次失败永久缓存
      throw err;
    });
  return loading;
}

/**
 * 「减少动态效果」时停在哪一帧：完成 = 最后一帧（对勾已经弹出），其余 = 第一帧（基础姿势）。
 */
export function keyFrameIndex(state: MascotState, seqLength: number): number {
  return state === 'done' ? Math.max(0, seqLength - 1) : 0;
}

/**
 * 每个格子占几个**屏幕物理像素**：像素画只能整数倍放大，否则系统缩放 125% / 150% 时
 * 格子会一胖一瘦。按目标 CSS 尺寸 × 设备像素比取整，最少 1 倍。
 */
export function integerPixelScale(targetCssPx: number, canvasPx: number, dpr: number): number {
  return Math.max(1, Math.round((targetCssPx * dpr) / canvasPx));
}
