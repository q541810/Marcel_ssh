import { describe, expect, it } from 'vitest';
import raw from './marcelFrames.json';
import {
  decodeFrameData,
  decodeRow,
  integerPixelScale,
  keyFrameIndex,
  loadMascotFrames,
  MASCOT_STATES,
} from './frames';

describe('decodeRow', () => {
  it('字符后面的数字是重复次数，没有数字 = 1 次', () => {
    expect(decodeRow('.4K2G')).toBe('....KKG');
    expect(decodeRow('W12')).toBe('W'.repeat(12));
    expect(decodeRow('')).toBe('');
  });
});

describe('marcelFrames.json（由 scripts/mascot/marcel_frames.py 生成）', () => {
  const data = decodeFrameData(raw as never);
  const [w, h] = data.size;

  it('每个状态都有帧序列，且每帧时长为正、帧号有效', () => {
    for (const s of MASCOT_STATES) {
      const seq = data.states[s];
      expect(seq?.length, s).toBeGreaterThan(0);
      for (const [idx, ms] of seq) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(data.frames.length);
        expect(ms).toBeGreaterThan(0);
      }
    }
  });

  it('每帧都是 W×H，且只用调色板里的字符（外加透明 . 和主题外缘 O）', () => {
    const allowed = new Set([...Object.keys(data.palette), '.', 'O']);
    for (const rows of data.frames) {
      expect(rows.length).toBe(h);
      for (const row of rows) {
        expect(row.length).toBe(w);
        for (const ch of row) expect(allowed.has(ch), ch).toBe(true);
      }
    }
  });

  it('人物外框落在画布里', () => {
    const a = data.anchor;
    expect(a.left).toBeGreaterThanOrEqual(0);
    expect(a.top).toBeGreaterThanOrEqual(0);
    expect(a.right).toBeLessThan(w);
    expect(a.bottom).toBeLessThan(h);
    expect(a.right).toBeGreaterThan(a.left);
    expect(a.bottom).toBeGreaterThan(a.top);
  });

  it('按需加载得到同一份数据', async () => {
    const loaded = await loadMascotFrames();
    expect(loaded.frames.length).toBe(data.frames.length);
    expect(loaded.frames[0][0]).toBe(data.frames[0][0]);
  });
});

describe('integerPixelScale', () => {
  it('每格占整数个物理像素，最少 1 倍', () => {
    expect(integerPixelScale(64, 64, 1)).toBe(1);
    expect(integerPixelScale(64, 64, 1.25)).toBe(1);
    expect(integerPixelScale(64, 64, 1.5)).toBe(2);
    expect(integerPixelScale(64, 64, 2.75)).toBe(3);
    expect(integerPixelScale(128, 64, 1)).toBe(2);
    expect(integerPixelScale(16, 64, 1)).toBe(1);
  });
});

describe('keyFrameIndex', () => {
  it('减少动态效果时：完成停在最后一帧（对勾），其余停在第一帧', () => {
    expect(keyFrameIndex('done', 21)).toBe(20);
    expect(keyFrameIndex('running', 8)).toBe(0);
  });
});
