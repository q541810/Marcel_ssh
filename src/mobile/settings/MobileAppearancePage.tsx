import { MobileAppearanceSection } from './MobileAppearanceSection';
import { MobileQuickCommandSection } from './MobileQuickCommandSection';

/**
 * 「外观与终端」页（手机）：主题 / 终端字号字体 / 对话显示，以及终端快捷命令。
 *
 * 快捷命令是终端底栏的自定义按钮，属于「终端怎么用」，跟字号字体放一页；
 * 桌面端的快捷命令在终端的快捷命令面板里，不在设置页。
 */
export function MobileAppearancePage() {
  return (
    <div className="flex flex-col gap-4">
      <MobileAppearanceSection />
      <section>
        <h2 className="mb-2 px-1 text-xs font-medium text-zinc-500">快捷命令</h2>
        <MobileQuickCommandSection />
      </section>
    </div>
  );
}
