import { useEffect, useState, type ReactNode } from 'react';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';

/**
 * 通用的「高度长出来 / 收回去」出入场壳：条件显示的一整块内容（折叠区、开关打开后才出现的子设置）
 * 用它包住，而不是 `{show && <div/>}` 当场顶出来 —— 后者会让下面所有内容瞬间跳一下。
 *
 * 动画是 `globals.css` 里 `.transient-reveal*` 那一套（grid-template-rows 0fr↔1fr，内容高度不用量，
 * spring-smooth 曲线，「减少动态效果」下压成 1ms 但仍靠 animationend 卸载）。
 * 收起期间子内容仍由调用方照常渲染，需要让它在此期间保持不变。
 *
 * 初始就是显示的（比如进设置页时开关本来就开着）不播进场动画：用户没做任何事，不该有东西在动。
 * 之后任何一次「先隐藏再显示」才播。
 */
/** 进场动画（260ms）的兜底放开时间。 */
const SETTLE_FALLBACK_MS = 400;

export default function Reveal({ show, children }: { show: boolean; children: ReactNode }) {
  const presence = useAnimatedPresence(show);
  const [skipEnter, setSkipEnter] = useState(show);
  // 「安顿好了」= 进场动画播完（或一开始就显示、没有进场动画）。动画期间内层必须 overflow:hidden
  // 才能把高度从 0 长出来；但**安顿之后必须放开**，否则里面的下拉菜单 / 弹出层（绝对定位、会超出这一块）
  // 都被裁掉——比如卡片最后一项是下拉时，列表只露出半截。
  const [settled, setSettled] = useState(show);
  useEffect(() => {
    if (!show) {
      setSkipEnter(false);
      setSettled(false);
    }
  }, [show]);
  // animationend 万一不触发（祖先 display:none 等）也要放开，不然裁切永远在。
  useEffect(() => {
    if (!show || settled) return;
    const timer = setTimeout(() => setSettled(true), SETTLE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [show, settled]);

  if (!presence.mounted) return null;
  const exiting = presence.phase === 'exit';
  const phaseClass = exiting
    ? 'transient-reveal-exit'
    : skipEnter
      ? ''
      : 'transient-reveal-enter';
  const settledClass = settled && !exiting ? 'transient-reveal-settled' : '';
  return (
    <div
      className={`transient-reveal ${phaseClass} ${settledClass}`}
      aria-hidden={exiting || undefined}
      onAnimationEnd={(e) => {
        // 子元素（下拉菜单自己的入场动画等）冒泡上来的不算。
        if (e.target !== e.currentTarget) return;
        if (!exiting) setSettled(true);
        presence.onAnimationEnd(e);
      }}
    >
      <div>{children}</div>
    </div>
  );
}
