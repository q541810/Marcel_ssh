import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles } from 'lucide-react';
import { fireConfetti, prefersReducedMotion } from '@/lib/confetti';
import { PELICAN_GROUND_RATIO, PELICAN_VIEWBOX } from '@/lib/pelicanPedal';
import PelicanCyclist from './PelicanCyclist';

const UNLOCK_MESSAGE = '您已解锁至尊无敌特效功能的启动权限！';

/** 整场仪式的时间轴（毫秒）：骑进来 → 刹停放炮、横幅亮出 → 骑走。 */
const RIDE_IN_MS = 1700;
const HOLD_MS = 2300;
const RIDE_OUT_MS = 1300;
const TOTAL_MS = RIDE_IN_MS + HOLD_MS + RIDE_OUT_MS;
/** 减少动态效果时没有鹈鹕与礼炮，只留横幅。 */
const REDUCED_TOTAL_MS = 3400;
const BANNER_FADE_MS = 360;

interface Props {
  /** 图标在视口里的位置：鹈鹕在它旁边刹停，地面线取它的下沿。 */
  anchor: DOMRect;
  /** 礼炮响的那一刻（解锁资格就在这一刻到手，界面上的开关也在这时亮出来）。 */
  onCannon: () => void;
  onDone: () => void;
}

interface Layout {
  width: number;
  top: number;
  stopX: number;
  startX: number;
  endX: number;
}

function computeLayout(anchor: DOMRect): Layout {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.round(Math.min(210, Math.max(132, vw * 0.4)));
  const height = (width * PELICAN_VIEWBOX.height) / PELICAN_VIEWBOX.width;
  // 车轮着地线 = 图标下沿，但不能出屏幕
  const ground = Math.min(vh - 20, Math.max(height * PELICAN_GROUND_RATIO + 12, anchor.bottom));
  const top = ground - height * PELICAN_GROUND_RATIO;
  // 在图标右侧刹停；窄屏放不下就贴着右边缘，宁可压住图标一角
  const stopX = Math.min(vw - width - 8, Math.max(8, anchor.right + 14));
  return { width, top, stopX, startX: vw + 24, endX: -width - 48 };
}

/** 发一轮礼炮：左右下角两门对射，中间再补一发朝上的。 */
function fireCannons(stopCenter: { x: number; y: number }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 屏幕越高，炮要打得越有劲，否则竖屏手机上彩带只够到下半屏
  const power = Math.min(1.7, Math.max(1, vh / 650));
  const speed = (lo: number, hi: number) => [lo * power, hi * power] as const;
  const volley = (delay: number, count: number) => {
    window.setTimeout(() => {
      fireConfetti({ x: 12, y: vh + 6, angle: -62, spread: 38, count, speed: speed(900, 1700), life: [1.8, 3], gravity: 1500, drag: 1.5 });
      fireConfetti({ x: vw - 12, y: vh + 6, angle: -118, spread: 38, count, speed: speed(900, 1700), life: [1.8, 3], gravity: 1500, drag: 1.5 });
    }, delay);
  };
  volley(0, 70);
  volley(380, 55);
  window.setTimeout(() => {
    fireConfetti({ x: stopCenter.x, y: stopCenter.y, angle: -90, spread: 70, count: 60, speed: speed(600, 1200), life: [1.6, 2.6], gravity: 1500, drag: 1.8 });
  }, 160);
}

/**
 * 解锁仪式：鹈鹕骑着自行车从右侧驶入，在图标旁刹停，两门礼炮齐鸣、横幅亮出，随后向左骑走。
 * 角色：纯展示 + 一次性时间轴（不持有业务状态；解锁由 `onCannon` 回调交给调用方）。
 * 渲染在 body 的 portal 里，指针事件穿透，不挡任何操作。
 */
export default function UnlockCeremony({ anchor, onCannon, onDone }: Props) {
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const layout = useMemo(() => computeLayout(anchor), [anchor]);
  const riderRef = useRef<HTMLDivElement>(null);
  const [riding, setRiding] = useState(true);
  const [bannerVisible, setBannerVisible] = useState(false);
  const [bannerLeaving, setBannerLeaving] = useState(false);
  // 回调走 ref：仪式期间父组件重渲染不应重启时间轴
  const cannonRef = useRef(onCannon);
  const doneRef = useRef(onDone);
  useEffect(() => {
    cannonRef.current = onCannon;
    doneRef.current = onDone;
  }, [onCannon, onDone]);

  // 先把鹈鹕放到屏幕外右侧，避免首帧在原位闪一下
  useLayoutEffect(() => {
    const rider = riderRef.current;
    if (rider) rider.style.transform = `translateX(${layout.startX}px)`;
  }, [layout.startX]);

  useEffect(() => {
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    let anim: Animation | undefined;

    if (reduced) {
      // 没有鹈鹕与礼炮：横幅淡入，资格照给
      at(0, () => {
        cannonRef.current();
        setBannerVisible(true);
      });
      at(REDUCED_TOTAL_MS - BANNER_FADE_MS, () => setBannerLeaving(true));
      at(REDUCED_TOTAL_MS, () => doneRef.current());
      return () => timers.forEach((t) => window.clearTimeout(t));
    }

    const rider = riderRef.current;
    if (rider && typeof rider.animate === 'function') {
      const inEnd = RIDE_IN_MS / TOTAL_MS;
      const holdEnd = (RIDE_IN_MS + HOLD_MS) / TOTAL_MS;
      anim = rider.animate(
        [
          { transform: `translateX(${layout.startX}px)`, offset: 0, easing: 'cubic-bezier(0.16, 0.7, 0.3, 1)' },
          { transform: `translateX(${layout.stopX}px)`, offset: inEnd },
          { transform: `translateX(${layout.stopX}px)`, offset: holdEnd, easing: 'cubic-bezier(0.55, 0.05, 0.85, 0.45)' },
          { transform: `translateX(${layout.endX}px)`, offset: 1 },
        ],
        { duration: TOTAL_MS, fill: 'forwards' },
      );
    }

    // 刹停瞬间：车轮定格、礼炮齐鸣、横幅亮出
    at(RIDE_IN_MS, () => {
      setRiding(false);
      setBannerVisible(true);
      fireCannons({
        x: layout.stopX + layout.width / 2,
        y: layout.top + 30,
      });
      cannonRef.current();
    });
    // 重新蹬起来，横幅同时淡出
    at(RIDE_IN_MS + HOLD_MS - BANNER_FADE_MS, () => setBannerLeaving(true));
    at(RIDE_IN_MS + HOLD_MS, () => setRiding(true));
    at(TOTAL_MS + 60, () => doneRef.current());

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      anim?.cancel();
    };
  }, [reduced, layout]);

  // 横幅落在视口顶部（像系统通知横幅）：图标和鹈鹕都在页面上半部，放中间会盖住主角；
  // 手机上让出刘海 / 状态栏
  const bannerTop = 'calc(env(safe-area-inset-top, 0px) + 12px)';

  return createPortal(
    <>
      {!reduced && (
        <div
          ref={riderRef}
          aria-hidden="true"
          className="pointer-events-none fixed left-0"
          style={{ top: layout.top, width: layout.width, zIndex: 100001, willChange: 'transform' }}
        >
          <PelicanCyclist riding={riding} className="block w-full" />
        </div>
      )}
      {bannerVisible && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 flex justify-center px-4"
          style={{ top: bannerTop, zIndex: 100002 }}
        >
          <div
            className={`supreme-banner ${bannerLeaving ? 'supreme-banner-leaving' : ''} flex max-w-[min(92vw,520px)] items-center gap-3 rounded-2xl border border-amber-300/40 bg-surface/80 px-5 py-4 text-read font-medium leading-snug text-fg shadow-raised shadow-black/50 backdrop-blur-xl`}
          >
            <Sparkles className="h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
            <span>{UNLOCK_MESSAGE}</span>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
