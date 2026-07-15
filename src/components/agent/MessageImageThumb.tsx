import { useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as tauri from '@/lib/tauri';

interface Props {
  relativePath: string;
  className?: string;
  removable?: boolean;
  onRemove?: () => void;
}

/** Thumbnail for a persisted relative image path under config images/. */
export default function MessageImageThumb({
  relativePath,
  className = '',
  removable,
  onRemove,
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
        className={`flex items-center justify-center rounded-md bg-zinc-800 text-[10px] text-zinc-500 ${className}`}
        title="图片缺失"
      >
        [image]
      </div>
    );
  }

  if (!src) {
    return (
      <div className={`rounded-md bg-zinc-800 animate-pulse ${className}`} />
    );
  }

  return (
    <div className={`relative group/img ${className}`}>
      <img
        src={src}
        alt=""
        className="h-full w-full object-cover rounded-md border border-zinc-700"
        onError={() => setFailed(true)}
      />
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
