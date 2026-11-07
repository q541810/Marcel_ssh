import { useMemo } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';
import {
  buildSettledVisualizationDoc,
  type HtmlVisualizationTheme,
} from '@/lib/htmlVisualization';
import MobileFullscreenPage from './ui/MobileFullscreenPage';

interface Props {
  title: string;
  fragment: string;
  token: string;
  theme: HtmlVisualizationTheme;
  onClose: () => void;
}

/**
 * 对话内可视化的全屏查看器：iframe 撑满、文档内部可滚动，横屏就有横屏宽度。
 *
 * 打开的是一个**新的 iframe 实例**，状态从初始值开始（不继承对话里那份的
 * 调参结果）：iframe 一旦换位置就会重载，而原位 fixed 放大又被消息列表的
 * `container-type` 拦住，两条路都做不到保留状态。
 */
export default function MobileHtmlVisualizationViewer({
  title,
  fragment,
  token,
  theme,
  onClose,
}: Props) {
  const { closing, requestClose, onAnimationEnd } = useAnimatedClose(onClose);
  // 与对话里那份用不同的 token：高度上报 / 流式消息按 token + source 认领，
  // 两个实例互不串线。
  const doc = useMemo(
    () =>
      buildSettledVisualizationDoc(fragment, title, theme, `${token}:fullscreen`, {
        // 查看器被键盘挤矮后，文档自己把正在输入的控件滚回可视区。
        focus: "self",
      }),
    [fragment, title, theme, token],
  );

  return (
    <MobileFullscreenPage
      region="mobile-html-viz-viewer"
      // 背景跟 iframe 同色，页眉、页脚（导航栏 padding）与画面连成一体。
      // 取对话里那份可视化解析出的底色：本页挂在 body 上，读不到对话页的覆盖值。
      backgroundColor={theme.background}
      closing={closing}
      onExitAnimationEnd={onAnimationEnd}
      onBack={requestClose}
    >
      <header
        className="flex flex-shrink-0 items-center gap-1 px-1 pb-1"
        style={{ paddingTop: 'max(0.25rem, env(safe-area-inset-top, 0px))' }}
      >
        <button
          type="button"
          onClick={requestClose}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-fg-secondary transition-colors duration-100 active:bg-white/10"
          aria-label="返回"
        >
          <ChevronLeft aria-hidden="true" className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 truncate pr-3 text-body font-medium text-fg">
          {title}
        </div>
      </header>
      {/* 与对话列表同样的 12px 侧边距：可视化文档自己没有内边距，贴着屏幕边缘
          既难看，又会和系统边缘返回手势抢触摸。 */}
      <div className="min-h-0 flex-1 px-3">
        <iframe
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={title}
          srcDoc={doc}
          className="block h-full w-full border-0"
          style={{ backgroundColor: theme.background, colorScheme: 'normal' }}
        />
      </div>
    </MobileFullscreenPage>
  );
}
