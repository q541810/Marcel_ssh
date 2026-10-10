import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as tauri from '@/lib/tauri';

interface Props {
  relativePath: string;
  className?: string;
  removable?: boolean;
  onRemove?: () => void;
  onPreview?: (src: string) => void;
  label?: string;
}

/** Thumbnail for a persisted relative image path under config images/. */
export default function MessageImageThumb({
  relativePath,
  className = '',
  removable,
  onRemove,
  onPreview,
  label = '图片',
}: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setSrc(null);
    (async () => {
      try {
        const abs = await tauri.agentResolveImagePath(relativePath);
        if (cancelled) return;
        setSrc(convertFileSrc(abs));
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relativePath]);

  if (failed) {
    return (
      <div
        role="img"
        aria-label={`${label}无法显示`}
        className={`flex items-center justify-center rounded-md bg-zinc-800 text-[10px] text-zinc-500 ${className}`}
        title="图片缺失或无法读取"
      >
        图片不可用
      </div>
    );
  }

  if (!src) {
    return (
      <div role="status" aria-label={`${label}正在加载`} className={`rounded-md bg-zinc-800 animate-pulse motion-reduce:animate-none ${className}`} />
    );
  }

  return (
    <div className={`relative group/img ${className}`}>
      {onPreview ? (
        <button
          type="button"
          onClick={() => onPreview(src)}
          aria-label={`预览 ${label}`}
          aria-haspopup="dialog"
          className="h-full w-full rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
        >
          <img src={src} alt={label} className="h-full w-full object-cover rounded-md border border-zinc-700" onError={() => setFailed(true)} />
        </button>
      ) : <img
        src={src}
        alt=""
        className="h-full w-full object-cover rounded-md border border-zinc-700"
        onError={() => setFailed(true)}
      />}
      {removable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove?.();
          }}
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-900 border border-zinc-600 text-zinc-300 hover:text-white hover:bg-red-600 flex items-center justify-center text-[10px] leading-none"
          title="移除"
        >
          ×
        </button>
      )}
    </div>
  );
}
