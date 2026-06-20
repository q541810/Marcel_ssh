/**
 * Web Audio API 合成提示音 — 3 种通知类型各一种音效。
 * 纯代码生成，无外部音频文件依赖（任务失败除外，使用自定义 MP3）。
 *
 * 音量映射：滑块 0-100，其中 70 = 音频原始音量(1.0)，100 = 增益至 1.3。
 */

let ctx: AudioContext | null = null;
let sliderValue = 70; // 滑块原始值 0-100

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

/** 滑块值 → 音频增益倍数：70→1.0，100→1.3，0→0 */
function toGain(v: number): number {
  if (v <= 0) return 0;
  if (v <= 70) return v / 70;
  return 1.0 + ((v - 70) / 30) * 0.3;
}

export function setNotificationVolume(v: number): void {
  sliderValue = Math.max(0, Math.min(100, v));
}

export function getNotificationVolume(): number {
  return sliderValue;
}

interface ToneSpec {
  freq: number;
  duration: number;
  type: OscillatorType;
  gain: number;
  delay: number;
}

function playTone(spec: ToneSpec): void {
  const ac = getCtx();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = spec.type;
  osc.frequency.value = spec.freq;
  const g = spec.gain * toGain(sliderValue);
  gain.gain.setValueAtTime(Math.max(g, 0.001), ac.currentTime + spec.delay);
  gain.gain.exponentialRampToValueAtTime(
    0.001,
    ac.currentTime + spec.delay + spec.duration,
  );
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(ac.currentTime + spec.delay);
  osc.stop(ac.currentTime + spec.delay + spec.duration);
}

function playSequence(tones: ToneSpec[]): void {
  for (const t of tones) playTone(t);
}

/** Agent 需要批准 — 两声短促升调（叮-咚） */
function playApproval(): void {
  playSequence([
    { freq: 800, duration: 0.15, type: 'sine', gain: 0.3, delay: 0 },
    { freq: 1200, duration: 0.18, type: 'sine', gain: 0.3, delay: 0.16 },
  ]);
}

/** Agent 任务完成 — 三声渐升和弦（C5→E5→G5） */
function playTaskDone(): void {
  playSequence([
    { freq: 523, duration: 0.18, type: 'sine', gain: 0.25, delay: 0 },
    { freq: 659, duration: 0.18, type: 'sine', gain: 0.25, delay: 0.15 },
    { freq: 784, duration: 0.25, type: 'sine', gain: 0.3, delay: 0.3 },
  ]);
}

/** Agent 任务失败 — 自定义 MP3 音频（支持增益 >1.0） */
async function playTaskFailed(): Promise<void> {
  const ac = getCtx();
  const gain = toGain(sliderValue);
  try {
    const resp = await fetch('/sounds/agent-failed.mp3');
    const buf = await resp.arrayBuffer();
    const audioBuf = await ac.decodeAudioData(buf);
    const src = ac.createBufferSource();
    const gainNode = ac.createGain();
    src.buffer = audioBuf;
    gainNode.gain.value = gain;
    src.connect(gainNode);
    gainNode.connect(ac.destination);
    src.start();
  } catch {
    const audio = new Audio('/sounds/agent-failed.mp3');
    audio.volume = Math.min(gain, 1);
    audio.play().catch(() => {});
  }
}

const handlers: Record<string, () => void> = {
  AgentApproval: playApproval,
  AgentTaskDone: playTaskDone,
  AgentTaskFailed: () => { playTaskFailed(); },
};

export function playNotificationSound(kind: string): void {
  const fn = handlers[kind];
  if (fn) fn();
}

/** 试听某个音效（不受设置开关限制） */
export function previewNotificationSound(kind: string): void {
  playNotificationSound(kind);
}
