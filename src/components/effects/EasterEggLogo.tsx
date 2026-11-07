import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_LOGO, APP_NAME } from '@/lib/constants';
import { fireConfetti, prefersReducedMotion } from '@/lib/confetti';
import { createLogoBounce, jumpEnergy, type LogoBounce } from '@/lib/logoBounce';
import { integerPixelScale, loadMascotFrames, peekMascotFrames, type MascotFrameData } from '@/lib/mascot/frames';
import MarcelSprite from '@/components/mascot/MarcelSprite';
import PixelMorphCanvas from '@/components/mascot/PixelMorphCanvas';
import { useTapSequence } from '@/hooks/useTapSequence';
import { useSupremeEffectsStore } from '@/stores/supremeEffectsStore';
import UnlockCeremony from './UnlockCeremony';

/** 连点多少下触发彩蛋；相邻两下间隔不超过 CLICK_GAP_MS 才算「连续」。 */
const REQUIRED_CLICKS = 10;
const CLICK_GAP_MS = 1500;
/** 变身那一刻炸开的像素碎片颜色：取像素小人调色板里的亮色（白灰 + 黄红绿蓝青橙紫）。 */
const CHIP_PALETTE_KEYS = 'WPLyrgbcov';

/**
 * 图标的三个外观：原图 → （第一次被戳）变身动画 → 像素小人。
 * 只往前走、不回头：像素小人再被戳不会再变，也不会变回去（离开关于页再回来才重新是原图）。
 */
type Look =
  | { kind: 'logo' }
  | { kind: 'morphing'; data: MascotFrameData; size: number; box: { left: number; top: number } }
  | { kind: 'pixel'; data: MascotFrameData; size: number; box: { left: number; top: number } };

/**
 * 关于页的应用图标：按下收缩、松开弹跳；**第一次被戳就变成像素小人**（故障 → 压碎 → 闪白 → 扫描成像，
 * 再炸一把像素碎片），之后再戳不再变；连点十下，鹈鹕骑车登场、礼炮齐鸣，解锁「至尊无敌特效」。
 * 桌面与移动端的关于页共用这一个组件，样式差异只通过 `className`（作用在图片上）表达。
 *
 * 角色：manager —— 协调点击计数、弹簧动画、变身、解锁仪式与解锁状态五件事；
 * 各自的逻辑都在独立模块里（useTapSequence / logoBounce / PixelMorphCanvas + pixelMorph /
 * UnlockCeremony / supremeEffectsStore）。变身与十连击互不依赖：第一下既触发变身也计入十连击。
 */
export default function EasterEggLogo({ className }: { className: string }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bounceRef = useRef<LogoBounce | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pressedRef = useRef(false);
  const morphStartedRef = useRef(false);
  const aliveRef = useRef(true);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [look, setLook] = useState<Look>({ kind: 'logo' });
  const unlock = useSupremeEffectsStore((s) => s.unlock);

  useEffect(() => {
    aliveRef.current = true;
    // 先把像素帧数据拉下来：第一下戳的时候要立刻有反应，不能让用户等一次网络 / 解析
    loadMascotFrames().catch(() => {});
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const el = buttonRef.current;
    if (!el) return;
    const bounce = createLogoBounce(el, prefersReducedMotion);
    bounceRef.current = bounce;
    return () => {
      bounce.dispose();
      bounceRef.current = null;
    };
  }, []);

  const tap = useTapSequence(REQUIRED_CLICKS, CLICK_GAP_MS, () => {
    const el = buttonRef.current;
    // 仪式进行中不重复触发（连点是顺手的事，别叠出两只鹈鹕）
    if (!el) return;
    setAnchor((current) => current ?? el.getBoundingClientRect());
  });

  const handlePointerDown = useCallback(() => {
    pressedRef.current = true;
    bounceRef.current?.press();
  }, []);

  /** 按下后指针移出 / 被系统取消：没点成，松手但不起跳。 */
  const handleAbort = useCallback(() => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    bounceRef.current?.release(0);
  }, []);

  /** 第一下被戳：变成像素小人。减少动态效果时不演，直接换。 */
  const beginMorph = useCallback(() => {
    if (morphStartedRef.current) return;
    const img = imgRef.current;
    if (!img) return;
    morphStartedRef.current = true;
    const size = Math.min(img.offsetWidth, img.offsetHeight);
    const box = { left: img.offsetLeft, top: img.offsetTop };
    const start = (data: MascotFrameData) => {
      if (!aliveRef.current) return;
      setLook(prefersReducedMotion() ? { kind: 'pixel', data, size, box } : { kind: 'morphing', data, size, box });
    };
    const ready = peekMascotFrames();
    if (ready) {
      start(ready);
      return;
    }
    loadMascotFrames().then(start, (err) => {
      // 没加载出来：保持原图，下次再戳重试，别把用户的点击吞成「没反应」之外的任何怪事
      console.error('Failed to load mascot frames:', err);
      morphStartedRef.current = false;
    });
  }, []);

  const handleClick = useCallback(() => {
    pressedRef.current = false;
    const count = tap();
    bounceRef.current?.release(jumpEnergy(count));
    beginMorph();
  }, [tap, beginMorph]);

  /** 变身那一刻：从图标中心炸开一把像素碎片（块大小跟小人的格子走，看起来是「小人碎下来的像素」）。 */
  const burstChips = useCallback((data: MascotFrameData, size: number) => {
    const el = imgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cell = integerPixelScale(size, data.size[1], dpr) / dpr;
    const colors = [...CHIP_PALETTE_KEYS].map((k) => data.palette[k]).filter(Boolean);
    const base = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, pixel: true, scale: Math.max(0.6, (cell * 2) / 8.5), colors };
    fireConfetti({ ...base, angle: -90, spread: 360, count: 46, speed: [260, 640], life: [0.9, 1.6], gravity: 900, drag: 2.2 });
    fireConfetti({ ...base, angle: -90, spread: 60, count: 18, speed: [520, 900], life: [1, 1.7], gravity: 1300, drag: 1.6 });
  }, []);

  const handleMorphDone = useCallback(() => {
    // 落地：像素小人轻轻蹦一下（和按下起跳是同一套弹簧）
    bounceRef.current?.release(1.3);
    setLook((cur) => (cur.kind === 'morphing' ? { ...cur, kind: 'pixel' } : cur));
  }, []);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        // 纯彩蛋：不进 Tab 顺序，免得键盘用户 Tab 到一个没有用途的按钮
        tabIndex={-1}
        onPointerDown={handlePointerDown}
        onPointerCancel={handleAbort}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') handleAbort();
        }}
        onClick={handleClick}
        className="block cursor-pointer select-none rounded-3xl border-0 bg-transparent p-0 outline-none [-webkit-tap-highlight-color:transparent] touch-manipulation"
        style={{ transformOrigin: '50% 100%' }}
      >
        <div className="relative">
          <img
            ref={imgRef}
            src={APP_LOGO}
            alt={`${APP_NAME} logo`}
            className={className}
            draggable={false}
            // 变身后原图只隐藏、不撤掉：它撑着版面，像素小人叠在它的位置上，页面不会跳
            style={look.kind === 'logo' ? undefined : { visibility: 'hidden' }}
          />
          {look.kind !== 'logo' && (
            <div
              className="pointer-events-none absolute flex items-center justify-center"
              style={{ left: look.box.left, top: look.box.top, width: look.size, height: look.size }}
            >
              <MarcelSprite
                state="idle"
                size={look.size}
                style={look.kind === 'morphing' ? { visibility: 'hidden' } : undefined}
              />
              {look.kind === 'morphing' && imgRef.current && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <PixelMorphCanvas
                    logo={imgRef.current}
                    data={look.data}
                    size={look.size}
                    onSwap={() => burstChips(look.data, look.size)}
                    onDone={handleMorphDone}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </button>
      {anchor && (
        <UnlockCeremony
          anchor={anchor}
          onCannon={unlock}
          onDone={() => setAnchor(null)}
        />
      )}
    </>
  );
}
