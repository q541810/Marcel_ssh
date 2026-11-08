import { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '@/components/ui/Modal';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { useDevicePixelRatio } from '@/hooks/useDevicePixelRatio';
import { QrCode } from './QrCode';
import { buildQrMatrix, qrRenderPlan } from './qrMatrix';

/** 弹层里除了二维码还要放说明文字，这部分高度先扣掉，别让码顶出屏幕。 */
const CHROME_HEIGHT = 260;

/**
 * 「放大二维码」弹层：把同步码画到屏幕能给的最大尺寸。
 *
 * 存在的理由：设置页右侧控件列只有 280~320px，而 SFTP 同步码（要带整条服务器连接 + 主机指纹）
 * 有 1100 字符上下，二维码要 133 个模块——那个宽度里每格连 3 个设备像素都分不到，手机怎么扫都解不出。
 * 放大到 600px 上下、每格 4~5 个设备像素后才稳定可扫（实测从 0/9 升到 9/9）。
 *
 * 刻意**不显示同步码文本**：这一屏只用来扫，少一段能看能抄的密钥，也少一次抄错的机会。
 */
export function QrZoomDialog({
  open,
  code,
  onClose,
}: {
  open: boolean;
  code: string;
  onClose: () => void;
}) {
  // 量弹层里真正能用的宽度，再按整数设备像素算尺寸。
  // 首帧（还没量到）用按视口估出来的宽度兜底：`ResizeObserver` 要下一帧才回调，
  // 不给兜底的话弹层会先空一下再突然冒出二维码。量到之后以实测宽度为准。
  const boxRef = useRef<HTMLDivElement>(null);
  const measured = useContainerWidth(boxRef);
  const dpr = useDevicePixelRatio();
  const [viewport, setViewport] = useState(() => readViewport());
  const matrix = useMemo(() => (code ? buildQrMatrix(code) : null), [code]);

  useEffect(() => {
    if (!open) return;
    const update = () => setViewport(readViewport());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, [open]);

  // 弹层本体 `max-w-[min(92vw,720px)]`、左右各 px-4，估宽度时一并扣掉。
  const estimated = Math.min(viewport.width * 0.92, 720) - 32;
  const available = measured > 0 ? Math.min(measured, estimated) : estimated;
  const maxSize = Math.min(available, viewport.height - CHROME_HEIGHT);
  const fits = matrix !== null && maxSize > 0 && qrRenderPlan(matrix, maxSize, dpr).fits;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="用手机扫描"
      size="md"
      contentClassName="!max-w-[min(92vw,720px)]"
    >
      <div className="space-y-3 px-4 pb-4">
        <p className="text-body leading-relaxed text-fg-secondary">
          在手机端打开「加入已有同步 → 同步码 → 扫码」，把镜头对准下面这张码。手机没有扫码功能时，
          也可以用系统相机扫，扫出来的文字粘贴进去即可。
        </p>
        <div ref={boxRef} className="flex min-h-16 items-center justify-center">
          {fits ? (
            <QrCode text={code} maxSize={maxSize} label="同步码二维码" />
          ) : (
            <p className="py-6 text-center text-body leading-relaxed text-fg-tertiary">
              {matrix === null
                ? '同步码太长，无法生成二维码，请复制后发到另一台设备。'
                : '窗口太小，放不下一张能扫的二维码。把窗口拉大一点，或者复制同步码发到另一台设备。'}
            </p>
          )}
        </div>
        <p className="text-meta leading-relaxed text-fg-tertiary">
          同步码里带着解锁数据的钥匙，等同于钥匙本身：只在你自己的设备之间传递，别发给别人。
        </p>
      </div>
    </Modal>
  );
}

function readViewport(): { width: number; height: number } {
  return {
    width: typeof window === 'undefined' ? 720 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
  };
}
