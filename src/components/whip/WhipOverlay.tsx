import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

interface WhipOverlayProps {
  active: boolean;
  crackSpeed: number;
  phrases: string[];
  showCrackText: boolean;
  onDismiss: () => void;
}

interface WhipPoint {
  x: number;
  y: number;
  px: number;
  py: number;
}

interface CrackText {
  id: number;
  text: string;
  left: number;
  top: number;
  rotate: number;
}

const P = {
  segments: 28,
  segmentLength: 25,
  taper: 0.6,
  gravity: 1.2,
  dropGravity: 0.95,
  damping: 0.96,
  constraintIters: 20,
  maxStretchRatio: 1.2,
  baseTargetAngle: -1.12,
  handleAimByMouseX: 0.4,
  handleAimByMouseY: 0.2,
  handleAimClamp: 2,
  handleSpring: 0.7,
  handleAngularDamping: 0.078,
  basePoseSegments: 2,
  basePoseStiffStart: 0.9,
  basePoseStiffEnd: 0.8,
  handleMaxBendDeg: 16,
  tipMaxBendDeg: 130,
  bendRigidityStart: 0.8,
  bendRigidityEnd: 0.12,
  wallBounce: 0.42,
  wallFriction: 0.86,
  crackCooldownMs: 260,
  firstCrackGraceMs: 350,
  lineWidthHandle: 7,
  lineWidthTip: 5,
  outlineWidth: 3,
  handleExtraWidth: 5,
  handleThickSegments: 2,
  arcWidth: 260,
  arcHeight: 185,
} as const;

const SOUND_PATHS = [
  '/whip/sounds/A.mp3',
  '/whip/sounds/B.mp3',
  '/whip/sounds/C.mp3',
  '/whip/sounds/D.mp3',
  '/whip/sounds/E.mp3',
];

const CRACK_TEXT_LIFETIME_MS = 1600;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrapPi = (value: number) => {
  let next = value;
  while (next > Math.PI) next -= Math.PI * 2;
  while (next < -Math.PI) next += Math.PI * 2;
  return next;
};

function segmentLength(index: number) {
  const t = index / (P.segments - 1);
  return P.segmentLength * (1 - t * (1 - P.taper));
}

function spawnWhip(mx: number, my: number): WhipPoint[] {
  return Array.from({ length: P.segments }, (_, i) => {
    const t = i / (P.segments - 1);
    const x = mx + t * P.arcWidth;
    const y = my - Math.sin(t * Math.PI * 0.75) * P.arcHeight;
    return { x, y, px: x, py: y };
  });
}

function catmullPoint(points: WhipPoint[], index: number) {
  const n = points.length;
  if (index < 0) {
    if (n >= 2) return { x: 2 * points[0].x - points[1].x, y: 2 * points[0].y - points[1].y };
    return points[0];
  }
  if (index >= n) {
    if (n >= 2) {
      const a = points[n - 2];
      const b = points[n - 1];
      return { x: 2 * b.x - a.x, y: 2 * b.y - a.y };
    }
    return points[n - 1];
  }
  return points[index];
}

function whipSegmentBezier(points: WhipPoint[], index: number) {
  const p0 = catmullPoint(points, index - 1);
  const p1 = points[index];
  const p2 = points[index + 1];
  const p3 = catmullPoint(points, index + 2);
  return {
    cp1x: p1.x + (p2.x - p0.x) / 6,
    cp1y: p1.y + (p2.y - p0.y) / 6,
    cp2x: p2.x - (p3.x - p1.x) / 6,
    cp2y: p2.y - (p3.y - p1.y) / 6,
    x2: p2.x,
    y2: p2.y,
  };
}

export function WhipOverlay({ active, crackSpeed, phrases, showCrackText, onDismiss }: WhipOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textIdRef = useRef(0);
  const crackSpeedRef = useRef(crackSpeed);
  const phrasesRef = useRef(phrases);
  const showCrackTextRef = useRef(showCrackText);
  const onDismissRef = useRef(onDismiss);
  const [crackTexts, setCrackTexts] = useState<CrackText[]>([]);

  useEffect(() => {
    crackSpeedRef.current = crackSpeed;
    phrasesRef.current = phrases;
    showCrackTextRef.current = showCrackText;
    onDismissRef.current = onDismiss;
  }, [crackSpeed, phrases, showCrackText, onDismiss]);

  useEffect(() => {
    if (!active) setCrackTexts([]);
  }, [active]);

  const showRandomCrackText = () => {
    if (!showCrackTextRef.current) return;
    const available = phrasesRef.current.filter(Boolean);
    if (available.length === 0) return;
    const id = textIdRef.current++;
    const text = available[Math.floor(Math.random() * available.length)];
    const left = 18 + Math.random() * 64;
    const top = 18 + Math.random() * 42;
    const rotate = (Math.random() > 0.5 ? 1 : -1) * (8 + Math.random() * 14);

    setCrackTexts((prev) => [...prev.slice(-4), { id, text, left, top, rotate }]);
    window.setTimeout(() => {
      setCrackTexts((prev) => prev.filter((item) => item.id !== id));
    }, CRACK_TEXT_LIFETIME_MS);
  };

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let frame = 0;
    let dropping = false;
    let lastCrackTime = 0;
    let whipSpawnTime = Date.now();
    let handleAngle: number = P.baseTargetAngle;
    let handleAngularVelocity = 0;
    let mouseX = window.innerWidth * 0.5;
    let mouseY = window.innerHeight * 0.62;
    let prevMouseX = mouseX;
    let prevMouseY = mouseY;
    let whip: WhipPoint[] | null = spawnWhip(mouseX, mouseY);

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = Math.max(1, canvas.clientWidth);
      height = Math.max(1, canvas.clientHeight);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const playCrackSound = () => {
      const path = SOUND_PATHS[Math.floor(Math.random() * SOUND_PATHS.length)];
      const audio = new Audio(path);
      audio.volume = 0.8;
      audio.play().catch(() => {});
    };

    const updateHandleAim = () => {
      if (dropping) return;
      const delta = clamp(
        (mouseX - prevMouseX) * P.handleAimByMouseX + (mouseY - prevMouseY) * P.handleAimByMouseY,
        -P.handleAimClamp,
        P.handleAimClamp,
      );
      const target = P.baseTargetAngle + delta;
      const error = wrapPi(target - handleAngle);
      handleAngularVelocity += error * P.handleSpring;
      handleAngularVelocity *= P.handleAngularDamping;
      handleAngle = wrapPi(handleAngle + handleAngularVelocity);
    };

    const applyBasePose = () => {
      if (!whip || dropping) return;
      const dx = Math.cos(handleAngle);
      const dy = Math.sin(handleAngle);
      const guided = Math.min(P.basePoseSegments, whip.length - 1);
      for (let i = 1; i <= guided; i++) {
        const t = (i - 1) / Math.max(guided - 1, 1);
        const stiff = lerp(P.basePoseStiffStart, P.basePoseStiffEnd, t);
        const prev = whip[i - 1];
        const point = whip[i];
        const len = segmentLength(i - 1);
        point.x = lerp(point.x, prev.x + dx * len, stiff);
        point.y = lerp(point.y, prev.y + dy * len, stiff);
      }
    };

    const applyBendLimits = () => {
      if (!whip || whip.length < 3) return;
      for (let i = 1; i < whip.length - 1; i++) {
        const a = whip[i - 1];
        const b = whip[i];
        const c = whip[i + 1];
        const v1x = a.x - b.x;
        const v1y = a.y - b.y;
        const v2x = c.x - b.x;
        const v2y = c.y - b.y;
        const l1 = Math.hypot(v1x, v1y) || 0.0001;
        const l2 = Math.hypot(v2x, v2y) || 0.0001;
        const n1x = v1x / l1;
        const n1y = v1y / l1;
        const n2x = v2x / l2;
        const n2y = v2y / l2;
        const angle = Math.acos(clamp(n1x * n2x + n1y * n2y, -1, 1));
        const t = i / (whip.length - 2);
        const maxBend = lerp(P.handleMaxBendDeg, P.tipMaxBendDeg, t) * Math.PI / 180;
        if (Math.PI - angle <= maxBend) continue;
        const sign = n1x * n2y - n1y * n2x >= 0 ? 1 : -1;
        const targetAngle = Math.atan2(n1y, n1x) + sign * (Math.PI - maxBend);
        const rigidity = lerp(P.bendRigidityStart, P.bendRigidityEnd, t);
        c.x = lerp(c.x, b.x + Math.cos(targetAngle) * l2, rigidity);
        c.y = lerp(c.y, b.y + Math.sin(targetAngle) * l2, rigidity);
      }
    };

    const capSegmentStretch = () => {
      if (!whip || whip.length < 2) return;
      for (let i = 0; i < whip.length - 1; i++) {
        const a = whip[i];
        const b = whip[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.0001;
        const maxLen = segmentLength(i) * P.maxStretchRatio;
        if (dist <= maxLen) continue;
        const k = maxLen / dist;
        b.x = a.x + dx * k;
        b.y = a.y + dy * k;
      }
    };

    const applyWallCollisions = () => {
      if (!whip || dropping) return;
      for (let i = 1; i < whip.length; i++) {
        const point = whip[i];
        let vx = point.x - point.px;
        let vy = point.y - point.py;
        let hit = false;
        if (point.x < 0) {
          point.x = 0;
          if (vx < 0) vx = -vx * P.wallBounce;
          vy *= P.wallFriction;
          hit = true;
        } else if (point.x > width) {
          point.x = width;
          if (vx > 0) vx = -vx * P.wallBounce;
          vy *= P.wallFriction;
          hit = true;
        }
        if (point.y < 0) {
          point.y = 0;
          if (vy < 0) vy = -vy * P.wallBounce;
          vx *= P.wallFriction;
          hit = true;
        } else if (point.y > height) {
          point.y = height;
          if (vy > 0) vy = -vy * P.wallBounce;
          vx *= P.wallFriction;
          hit = true;
        }
        if (hit) {
          point.px = point.x - vx;
          point.py = point.y - vy;
        }
      }
    };

    const update = () => {
      if (!whip) return;
      updateHandleAim();
      const gravity = dropping ? P.dropGravity : P.gravity;
      for (let i = dropping ? 0 : 1; i < whip.length; i++) {
        const point = whip[i];
        const vx = (point.x - point.px) * P.damping;
        const vy = (point.y - point.py) * P.damping;
        point.px = point.x;
        point.py = point.y;
        point.x += vx;
        point.y += vy + gravity;
      }
      if (!dropping) {
        whip[0].x = mouseX;
        whip[0].y = mouseY;
        whip[0].px = mouseX;
        whip[0].py = mouseY;
      }

      capSegmentStretch();
      applyWallCollisions();
      applyBasePose();
      for (let iter = 0; iter < P.constraintIters; iter++) {
        for (let i = 0; i < whip.length - 1; i++) {
          const a = whip[i];
          const b = whip[i + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.0001;
          const diff = (dist - segmentLength(i)) / dist * 0.5;
          const ox = dx * diff;
          const oy = dy * diff;
          if (i === 0 && !dropping) {
            b.x -= ox * 2;
            b.y -= oy * 2;
          } else {
            a.x += ox;
            a.y += oy;
            b.x -= ox;
            b.y -= oy;
          }
        }
        applyBendLimits();
        if (!dropping) applyBasePose();
        capSegmentStretch();
        applyWallCollisions();
      }

      const tip = whip[whip.length - 1];
      const tipVelocity = Math.hypot(tip.x - tip.px, tip.y - tip.py);
      const now = Date.now();
      if (!dropping && tipVelocity > crackSpeedRef.current && now - whipSpawnTime >= P.firstCrackGraceMs && now - lastCrackTime > P.crackCooldownMs) {
        lastCrackTime = now;
        playCrackSound();
        showRandomCrackText();
      }
      if (dropping && whip.every((point) => point.y > height + 60)) {
        whip = null;
        onDismissRef.current();
      }
      prevMouseX = mouseX;
      prevMouseY = mouseY;
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      if (!whip) return;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#f8fafc';
      ctx.beginPath();
      ctx.moveTo(whip[0].x, whip[0].y);
      for (let i = 0; i < whip.length - 1; i++) {
        const curve = whipSegmentBezier(whip, i);
        ctx.bezierCurveTo(curve.cp1x, curve.cp1y, curve.cp2x, curve.cp2y, curve.x2, curve.y2);
      }
      ctx.lineWidth = P.lineWidthTip + P.outlineWidth * 2;
      ctx.stroke();

      ctx.strokeStyle = '#09090b';
      for (let i = 0; i < whip.length - 1; i++) {
        const t = i / Math.max(1, whip.length - 2);
        const extra = i < P.handleThickSegments ? P.handleExtraWidth : 0;
        const curve = whipSegmentBezier(whip, i);
        ctx.lineWidth = lerp(P.lineWidthHandle, P.lineWidthTip, t) + extra;
        ctx.beginPath();
        ctx.moveTo(whip[i].x, whip[i].y);
        ctx.bezierCurveTo(curve.cp1x, curve.cp1y, curve.cp2x, curve.cp2y, curve.x2, curve.y2);
        ctx.stroke();
      }
    };

    const loop = () => {
      update();
      draw();
      frame = requestAnimationFrame(loop);
    };

    const handlePointerMove = (event: PointerEvent) => {
      mouseX = event.clientX;
      mouseY = event.clientY;
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      mouseX = event.clientX;
      mouseY = event.clientY;
    };
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      dropping = true;
    };

    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('contextmenu', handleContextMenu);
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [active]);

  if (!active) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] h-[100vh] w-[100vw] cursor-none bg-transparent">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full bg-transparent"
        title="右键收起鞭子"
      />
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {crackTexts.map((item) => (
          <div
            key={item.id}
            className="absolute select-none whitespace-pre-wrap text-3xl sm:text-4xl font-black tracking-wide text-amber-200 animate-whip-crack-text"
            style={{
              left: `${item.left}%`,
              top: `${item.top}%`,
              '--whip-text-rotate': `${item.rotate}deg`,
              transform: `translate(-50%, -50%) rotate(${item.rotate}deg)`,
              textShadow: '0 3px 0 rgba(127, 29, 29, 0.95), 0 0 18px rgba(251, 191, 36, 0.75)',
            } as CSSProperties}
          >
            {item.text}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
