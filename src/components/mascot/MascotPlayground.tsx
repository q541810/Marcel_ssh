import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion } from '@/lib/mascot/useReducedMotion';
import { createLogoBounce, type LogoBounce } from '@/lib/logoBounce';
import {
  MASCOT_PLAYGROUND_HEIGHT,
  MascotPlayground,
  type MascotBounds,
} from '@/lib/mascot/playground';
import { MascotPerch, PERCH_SIZE } from './MascotPerch';
import { useMascotMood } from './useMascotMood';

interface Props {
  conversationId: string;
  visible: boolean;
  /** 「回到底部」出现时给它留位；仍归同一行的布局管。 */
  accessory?: ReactNode;
}

/** 活动区的固定高度：画布按整数像素缩放，真实身体边界由 measure 读取。 */
export { MASCOT_PLAYGROUND_HEIGHT };

/**
 * 输入框上方的小活动区（manager）：量边界、接指针、调度 rAF / 待机计时器。
 *
 * 分工（改之前先看这里）：
 * - **位置**：`actor` 的 translate —— 横向 1:1 跟手，纵向 40% 跟手，越界橡皮筋。
 * - **姿态**：`[data-mascot-pose]` 上的 translate / scale / rotate —— 身体内部的轻微被拽偏移，
 *   不拿走热区的坐标；落地压扁也在这里。
 * - **按压**：同一层上的 transform 弹簧（`logoBounce`）—— 按下立即压缩、松手回弹。
 *   scale/rotate 与 transform 是两组独立属性，可以叠加而互不覆盖。
 * - **朝向**：画布自身镜像（`facing`），DOM 尺寸不动，热区不会跟着飘。
 */
export default function MascotPlaygroundView({ conversationId, visible, accessory }: Props) {
  const { state, poke } = useMascotMood(conversationId);
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<1 | -1>(1);
  const [dragging, setDragging] = useState(false);
  const reducedMotion = useReducedMotion();
  const areaRef = useRef<HTMLDivElement>(null);
  const actorRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MascotPlayground | null>(null);
  const facingRef = useRef<1 | -1>(1);
  const draggingRef = useRef(false);
  const latest = useRef({ state, visible, reducedMotion, poke });
  latest.current = { state, visible, reducedMotion, poke };

  useEffect(() => {
    const area = areaRef.current;
    const actor = actorRef.current;
    if (!ready || !area || !actor) return;
    const hit = actor.querySelector<HTMLElement>('[data-mascot-hit="body"]');
    const poseElement = actor.querySelector<HTMLElement>('[data-mascot-pose]');
    if (!hit || !poseElement) return;
    const engine = new MascotPlayground({
      bounds: { minX: 0, maxX: 0, maxY: 0 },
      bodySize: { width: hit.offsetWidth, height: hit.offsetHeight },
      reducedMotion: latest.current.reducedMotion,
    });
    engineRef.current = engine;
    // 按压 / 起跳弹簧归活动区：只有它知道这一次是点按还是拖拽。
    const bounce: LogoBounce = createLogoBounce(poseElement, () => latest.current.reducedMotion);
    let disposed = false;
    let raf = 0;
    let wanderTimer = 0;
    let previousFrame = 0;
    let pageVisible = !document.hidden;
    let activePointer: number | null = null;
    let suppressClick = false;
    let measured = false;
    let measureFrame = 0;
    let geometryReady = false;
    let geometryKey = '';
    let bounds: MascotBounds = { minX: 0, maxX: 0, maxY: 0 };

    const localPoint = (event: PointerEvent) => {
      const rect = area.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: rect.bottom - event.clientY };
    };
    const render = () => {
      const { pose } = engine.snapshot;
      actor.style.transform = `translate3d(${pose.x.toFixed(2)}px, ${(-pose.lift).toFixed(2)}px, 0)`;
      poseElement.style.translate = `${pose.offsetX.toFixed(2)}px 0`;
      poseElement.style.scale = `${pose.scaleX} ${pose.scaleY}`;
      poseElement.style.rotate = `${pose.rotation}deg`;
      if (engine.snapshot.dragging !== draggingRef.current) {
        draggingRef.current = engine.snapshot.dragging;
        setDragging(engine.snapshot.dragging);
      }
      if (pose.facing !== facingRef.current) {
        facingRef.current = pose.facing;
        setFacing(pose.facing);
      }
    };
    const wake = () => {
      if (!raf && !disposed && pageVisible && latest.current.visible) {
        previousFrame = 0;
        raf = requestAnimationFrame(tick);
      }
    };
    const tick = (now: number) => {
      raf = 0;
      if (disposed) return;
      const dt = previousFrame ? (now - previousFrame) / 1000 : 1 / 60;
      previousFrame = now;
      engine.step(dt);
      render();
      if (engine.snapshot.mode !== 'idle') wake();
      else previousFrame = 0;
    };
    const scheduleWander = () => {
      window.clearTimeout(wanderTimer);
      wanderTimer = 0;
      if (!pageVisible || !latest.current.visible || latest.current.reducedMotion) return;
      // 只负责到点叫一次；是否适合动、要蹦几步由运动模型决定。
      wanderTimer = window.setTimeout(() => {
        wanderTimer = 0;
        if (engine.wander(performance.now(), latest.current.state === 'idle')) wake();
        scheduleWander();
      }, 2000);
    };
    const measure = () => {
      // 只量静止布局：hit 本身会被 pose 缩放，actor 会随拖拽移动。
      // 从这两个正在动的矩形反推边界，会把位置误差越攒越大。
      const canvas = actor.querySelector('canvas');
      const areaRect = area.getBoundingClientRect();
      const canvasWidth = canvas ? Number.parseFloat(canvas.style.width) : 0;
      const canvasHeight = canvas ? Number.parseFloat(canvas.style.height) : 0;
      if (!geometryReady && (!canvas || hit.offsetWidth === 0 || canvasWidth === 0)) {
        if (!measureFrame) measureFrame = requestAnimationFrame(() => { measureFrame = 0; measure(); });
        return;
      }
      if (!canvas) return;
      geometryReady = true;
      const key = `${areaRect.width}:${canvasWidth}:${canvasHeight}:${hit.offsetWidth}:${hit.offsetHeight}:${hit.offsetLeft}:${hit.offsetTop}`;
      if (key === geometryKey) return;
      geometryKey = key;
      // actor 的宽度必须被 canvas 撑住，不能让绝对定位的孩子退化成 0 或拉满整行。
      actor.style.width = `${canvasWidth}px`;
      actor.style.height = `${canvasHeight}px`;
      const left = hit.offsetLeft;
      const bottom = canvasHeight - (hit.offsetTop + hit.offsetHeight);
      bounds = {
        minX: -left,
        maxX: Math.max(-left, areaRect.width - left - hit.offsetWidth),
        maxY: Math.max(0, areaRect.height - bottom - hit.offsetHeight),
      };
      if (!measured) {
        engine.resize({ ...bounds, minX: bounds.maxX });
        measured = true;
      }
      engine.resize(bounds);
      render();
    };
    const sync = () => {
      const active = pageVisible && latest.current.visible;
      engine.setEnabled(active, performance.now());
      engine.setReducedMotion(latest.current.reducedMotion);
      if (active) {
        wake();
        scheduleWander();
      } else {
        window.clearTimeout(wanderTimer);
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const down = (event: PointerEvent) => {
      if (activePointer !== null || event.button !== 0 || !event.isPrimary || !latest.current.visible) return;
      measure();
      if (engine.snapshot.dragging || activePointer !== null) return;
      // 按下就压缩（响应在按下而不是抬起）。
      bounce.press();
      if (!engine.pointerDown(event.pointerId, localPoint(event), performance.now())) return;
      activePointer = event.pointerId;
      hit.setPointerCapture(event.pointerId);
      hit.style.cursor = 'grabbing';
      hit.style.touchAction = 'none';
      window.clearTimeout(wanderTimer);
      render();
      wake();
    };
    const move = (event: PointerEvent) => {
      if (!engine.pointerMove(event.pointerId, localPoint(event), performance.now())) return;
      event.preventDefault();
      render();
      wake();
    };
    const finish = (event: PointerEvent, cancelled = false) => {
      if (event.pointerId !== activePointer) return;
      if (cancelled) {
        engine.pointerCancel(event.pointerId, performance.now());
        suppressClick = true;
        bounce.release(0);
      } else {
        suppressClick = engine.pointerUp(event.pointerId, performance.now());
        // 点按 = 弹回原位并起跳；拖拽 = 只回弹，不再额外跳。
        if (suppressClick) bounce.release(0);
        else {
          bounce.release(1);
          latest.current.poke();
        }
      }
      activePointer = null;
      hit.style.cursor = '';
      if (hit.hasPointerCapture(event.pointerId)) hit.releasePointerCapture(event.pointerId);
      render();
      wake();
      scheduleWander();
    };
    const up = (event: PointerEvent) => finish(event);
    const cancel = (event: PointerEvent) => finish(event, true);
    // 点按已经在 pointerup 里播过起跳，浏览器随后补发的 click 一律吃掉，
    // 免得 MarcelSprite 的 onClick 再放一次。
    const click = (event: MouseEvent) => {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const visibility = () => {
      pageVisible = !document.hidden;
      if (!pageVisible && activePointer !== null) {
        engine.pointerCancel(activePointer, performance.now());
        activePointer = null;
        suppressClick = true;
        bounce.release(0);
        hit.style.cursor = '';
      }
      sync();
    };

    actor.style.position = 'absolute';
    actor.style.left = '0';
    actor.style.bottom = '0';
    actor.style.width = 'fit-content';
    hit.style.cursor = 'grab';
    hit.style.touchAction = 'none';
    actor.setAttribute('aria-label', '玛瑟尔，可以拖动或扔出去');
    hit.addEventListener('pointerdown', down);
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerup', up);
    hit.addEventListener('pointercancel', cancel);
    hit.addEventListener('click', click, true);
    document.addEventListener('visibilitychange', visibility);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(area);
    observer?.observe(hit);
    // area 高度固定时窗口左右缩放不会触发它的 ResizeObserver；观察内容列才能跟上宽度。
    const column = area.parentElement;
    if (column) observer?.observe(column);
    measure();
    sync();

    return () => {
      disposed = true;
      engine.dispose();
      engineRef.current = null;
      bounce.dispose();
      if (raf) cancelAnimationFrame(raf);
      if (measureFrame) cancelAnimationFrame(measureFrame);
      window.clearTimeout(wanderTimer);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      hit.removeEventListener('pointerdown', down);
      hit.removeEventListener('pointermove', move);
      hit.removeEventListener('pointerup', up);
      hit.removeEventListener('pointercancel', cancel);
      hit.removeEventListener('click', click, true);
      actor.removeAttribute('aria-label');
      actor.style.cssText = '';
      hit.style.cursor = '';
      hit.style.touchAction = '';
      poseElement.style.removeProperty('translate');
      poseElement.style.removeProperty('scale');
      poseElement.style.removeProperty('rotate');
    };
  }, [ready]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setEnabled(visible && !document.hidden, performance.now());
    engine.setReducedMotion(reducedMotion);
  }, [visible, reducedMotion]);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3">
      <div className="agent-content-column relative flex items-end justify-end gap-2">
        <div ref={areaRef} className="relative min-w-0 flex-1 self-stretch" style={{ height: MASCOT_PLAYGROUND_HEIGHT }}>
          <div ref={actorRef} data-mascot-actor className="pointer-events-auto select-none">
            <MascotPerch
              state={state}
              size={PERCH_SIZE}
              onPoke={poke}
              externalMotion
              facing={facing}
              reaction={dragging ? 'drag' : null}
              onReady={() => setReady(true)}
            />
          </div>
        </div>
        {accessory}
      </div>
    </div>
  );
}
