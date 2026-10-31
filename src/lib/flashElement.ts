/** 落点高亮的时长，要与 globals.css 的 `.jump-flash` 动画时长一致。 */
export const FLASH_MS = 1000;

const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/**
 * 让元素短暂闪一下底色（`.jump-flash`，主题令牌驱动，「减少动态效果」下是静态高亮）。
 * 直接改 class 而不走 React state：目标是消息流里被虚拟化的行，不能为一次视觉提示
 * 让整张列表重渲。重复触发会重启动画。
 */
export function flashElement(el: Element): void {
  const prev = timers.get(el);
  if (prev) clearTimeout(prev);
  el.classList.remove('jump-flash');
  // 强制回流，让同一个类名能重新播放动画
  void (el as HTMLElement).offsetWidth;
  el.classList.add('jump-flash');
  timers.set(
    el,
    setTimeout(() => {
      el.classList.remove('jump-flash');
      timers.delete(el);
    }, FLASH_MS),
  );
}
