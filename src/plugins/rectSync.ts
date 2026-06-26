export interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function getElementRect(el: HTMLElement): SlotRect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}
