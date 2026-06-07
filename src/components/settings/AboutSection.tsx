import { useState, useEffect, useCallback, useRef } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { checkUpdate } from '@/lib/tauri';
import type { UpdateCheckResult } from '@/lib/types';
import { getErrorMessage } from '@/lib/errors';
import { openExternalLink } from '@/lib/externalLinks';
import {
  APP_NAME,
  APP_LOGO,
  APP_MUSIC_BOX_AUDIO,
  APP_MUSIC_BOX_ROTATION_DURATION_MULTIPLIER,
  APP_MUSIC_BOX_FORWARD_DEG_PER_SEC,
  APP_MUSIC_BOX_REVERSE_TOTAL_DEG,
} from '@/lib/constants';
import Button from '@/components/ui/Button';
import { Card, SettingItem } from './helpers';

const APP_NAME_STR = APP_NAME;

/** 旋转阶段：空闲 / 按住正向 / 松开反向。 */
type MusicBoxPhase = 'idle' | 'forward' | 'reverse';

export default function AboutSection() {
  const [appVersion, setAppVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLogoPressed, setIsLogoPressed] = useState(false);

  const logoContainerRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLImageElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const rotationRef = useRef<number>(0);
  const phaseRef = useRef<MusicBoxPhase>('idle');
  const audioDurationRef = useRef<number>(0);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion('0.1.3'));
  }, []);

  const cancelAnimation = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /**
   * 停止所有播放并回到 idle 状态：取消动画帧、暂停并重置音频、清空 UI 状态。
   * 任何"终止路径"（卸载、页面隐藏、错误、再次按下、用户主动取消）都走这里。
   */
  const resetPlayback = useCallback(() => {
    cancelAnimation();
    phaseRef.current = 'idle';
    setIsLogoPressed(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, [cancelAnimation]);

  /**
   * 启动 RAF 旋转循环。
   * 循环内部根据 phaseRef 决定旋转方向与角速度；phase 回到 idle 时自动退出循环。
   * 该函数幂等：已有循环在跑时再次调用不会重复启动。
   */
  const runAnimation = useCallback(() => {
    if (rafRef.current !== null) return;
    lastFrameTimeRef.current = performance.now();

    const tick = () => {
      const logo = logoRef.current;
      if (!logo) {
        rafRef.current = null;
        return;
      }

      const now = performance.now();
      const deltaSec = (now - lastFrameTimeRef.current) / 1000;
      lastFrameTimeRef.current = now;

      const phase = phaseRef.current;
      if (phase === 'forward') {
        rotationRef.current += APP_MUSIC_BOX_FORWARD_DEG_PER_SEC * deltaSec;
        logo.style.transform = `rotate(${rotationRef.current}deg)`;
        rafRef.current = requestAnimationFrame(tick);
      } else if (phase === 'reverse' && audioDurationRef.current > 0) {
        const speed =
          APP_MUSIC_BOX_REVERSE_TOTAL_DEG /
          (audioDurationRef.current * APP_MUSIC_BOX_ROTATION_DURATION_MULTIPLIER);
        rotationRef.current -= speed * deltaSec;
        logo.style.transform = `rotate(${rotationRef.current}deg)`;
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // 组件卸载时清理：取消动画 + 暂停音频
  useEffect(() => {
    return () => {
      resetPlayback();
    };
  }, [resetPlayback]);

  /**
   * 监听 logo 所在区段是否在视口内。
   * SettingsContent 使用 `<div hidden>` 包裹 AboutSection，切换到其他设置项
   * 时组件不会 unmount，仅 hidden。IntersectionObserver 是唯一能在该场景下
   * 触发"停止播放"的安全点（依赖 visibilitychange 只能感知整页隐藏）。
   */
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const container = logoContainerRef.current?.parentElement;
    if (!container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry && !entry.isIntersecting && phaseRef.current !== 'idle') {
          resetPlayback();
        }
      },
      { threshold: 0 },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [resetPlayback]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLImageElement>) => {
      if (e.button !== 0 && e.button !== undefined) return;
      e.preventDefault();
      // 捕获指针，避免用户拖出 logo 边界后丢失 pointerup
      e.currentTarget.setPointerCapture(e.pointerId);

      // 已在播放：先完整停止，再开始新一轮"上发条"
      if (phaseRef.current !== 'idle' || (audioRef.current && !audioRef.current.paused)) {
        resetPlayback();
      }

      setIsLogoPressed(true);
      phaseRef.current = 'forward';
      runAnimation();
    },
    [resetPlayback, runAnimation],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLImageElement>) => {
      if (phaseRef.current === 'idle') return;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setIsLogoPressed(false);

      // 音频尚未加载（duration 不可用）则只停在当前角度，不进入反向播放
      if (!audioRef.current || audioDurationRef.current === 0) {
        resetPlayback();
        return;
      }

      // 切到反向旋转 + 启动音频
      phaseRef.current = 'reverse';
      audioRef.current.currentTime = 0;
      audioRef.current
        .play()
        .then(() => {
          runAnimation();
        })
        .catch((err) => {
          console.error('Music box playback failed:', err);
          resetPlayback();
        });
    },
    [resetPlayback, runAnimation],
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLImageElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      resetPlayback();
    },
    [resetPlayback],
  );

  const handleAudioLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      audioDurationRef.current = audio.duration;
    } else {
      audioDurationRef.current = 0;
    }
  }, []);

  /**
   * 音频自然结束：从头循环播放，制造"八音盒"永续效果。
   * 仅在仍处于 reverse 阶段时循环；用户已停止/离开页面则不重启。
   */
  const handleAudioEnded = useCallback(() => {
    const audio = audioRef.current;
    if (phaseRef.current === 'reverse' && audio) {
      audio.currentTime = 0;
      audio.play().catch((err) => {
        console.error('Music box loop failed:', err);
        resetPlayback();
      });
    }
  }, [resetPlayback]);

  const handleAudioError = useCallback(() => {
    console.error('Music box audio failed to load');
    resetPlayback();
  }, [resetPlayback]);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    setResult(null);
    try {
      const res = await checkUpdate();
      setResult(res);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setChecking(false);
    }
  }, []);

  return (
    <>
      <div className="flex justify-center mb-6" ref={logoContainerRef}>
        <img
          ref={logoRef}
          src={APP_LOGO}
          alt={`${APP_NAME_STR} logo`}
          className={`w-56 h-56 object-contain select-none touch-none will-change-transform ${
            isLogoPressed ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          draggable={false}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        />
      </div>
      <audio
        ref={audioRef}
        src={APP_MUSIC_BOX_AUDIO}
        preload="metadata"
        onLoadedMetadata={handleAudioLoadedMetadata}
        onEnded={handleAudioEnded}
        onError={handleAudioError}
      />
      <Card id="settings-about" title="应用信息">
        <SettingItem id="about-name" label="应用名称" sectionId="settings-about">
          <span className="text-sm text-zinc-300">{APP_NAME_STR}</span>
        </SettingItem>
        <SettingItem id="about-version" label="当前版本" sectionId="settings-about">
          <span className="text-sm text-zinc-300">{appVersion}</span>
        </SettingItem>
        <SettingItem
          id="about-update"
          label="检查更新"
          description="查看是否有新版本可用"
          sectionId="settings-about"
          keywords={['update', 'version', '升级']}
        >
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={handleCheck} loading={checking}>
              检查更新
            </Button>
            {result && !result.hasUpdate && (
              <span className="text-sm text-emerald-400">已是最新版本</span>
            )}
            {error && <span className="text-sm text-red-400">{error}</span>}
          </div>
          {result && result.hasUpdate && (
            <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-800/50 p-4 space-y-3">
              <p className="text-sm text-zinc-200">
                新版本 <span className="text-indigo-400 font-medium">{result.latestVersion}</span> 可用！
              </p>
              <Button variant="primary" onClick={() => openExternalLink(result.releaseUrl)}>
                去下载
              </Button>
            </div>
          )}
        </SettingItem>
      </Card>
    </>
  );
}
