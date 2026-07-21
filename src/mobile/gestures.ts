/** Scale so the (possibly rotated) image fits inside the container, never upscaling past 1. */
export function fitScale(
  imageWidth: number,
  imageHeight: number,
  containerWidth: number,
  containerHeight: number,
  rotationDeg = 0,
): number {
  if (
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    containerWidth <= 0 ||
    containerHeight <= 0
  ) {
    return 1;
  }
  const rotated = rotationDeg % 180 !== 0;
  const w = rotated ? imageHeight : imageWidth;
  const h = rotated ? imageWidth : imageHeight;
  return Math.min(containerWidth / w, containerHeight / h, 1);
}

export interface ZoomView {
  scale: number;
  /** Translation in container px, relative to container center. */
  translateX: number;
  translateY: number;
}

export interface ZoomAtInput {
  /** Anchor point in container px, relative to container center. */
  anchorX: number;
  anchorY: number;
  factor: number;
  minScale: number;
  maxScale: number;
}

/** Zoom around an anchor point so the content under the anchor stays put. */
export function zoomAt(view: ZoomView, input: ZoomAtInput): ZoomView {
  const nextScale = Math.min(
    input.maxScale,
    Math.max(input.minScale, view.scale * input.factor),
  );
  if (nextScale === view.scale) return view;
  const ratio = nextScale / view.scale;
  return {
    scale: nextScale,
    translateX: input.anchorX - (input.anchorX - view.translateX) * ratio,
    translateY: input.anchorY - (input.anchorY - view.translateY) * ratio,
  };
}

/**
 * Clamp translation so scaled content never leaves a gap at container edges.
 * Axes where content is smaller than the container snap to center (0).
 */
export function clampPan(
  translateX: number,
  translateY: number,
  contentWidth: number,
  contentHeight: number,
  containerWidth: number,
  containerHeight: number,
  scale: number,
): { x: number; y: number } {
  const maxX = Math.max(0, (contentWidth * scale - containerWidth) / 2);
  const maxY = Math.max(0, (contentHeight * scale - containerHeight) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, translateX)) + 0,
    y: Math.min(maxY, Math.max(-maxY, translateY)) + 0,
  };
}

const DOUBLE_TAP_FIT_EPSILON = 0.01;

/** Double-tap toggles between fit scale and a zoomed-in scale. */
export function doubleTapTargetScale(
  currentScale: number,
  fit: number,
  zoomed: number,
): number {
  return Math.abs(currentScale - fit) <= DOUBLE_TAP_FIT_EPSILON ? zoomed : fit;
}

export interface PinchState {
  distance: number;
  centerX: number;
  centerY: number;
}

/** Distance and midpoint of a two-finger touch. */
export function pinchOf(
  a: { x: number; y: number },
  b: { x: number; y: number },
): PinchState {
  return {
    distance: Math.hypot(b.x - a.x, b.y - a.y),
    centerX: (a.x + b.x) / 2,
    centerY: (a.y + b.y) / 2,
  };
}
