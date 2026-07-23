import { MobileNotificationSection } from './MobileNotificationSection';
import { MobileBackgroundSection } from './MobileBackgroundSection';

/**
 * 通知与后台合并页。
 *
 * 两者都是移动端系统行为配置（Agent 事件提醒 + 前台保活），
 * 合并减少分区入口。用分段标题区分。
 *
 * 非 Android 环境下两个子 section 各自返回降级提示，互不影响。
 */
export function MobileNotificationBackgroundSection() {
  return (
    <div className="flex flex-col gap-4">
      <section>
        <h2 className="mb-2 px-1 text-xs font-medium text-zinc-500">
          Agent 通知
        </h2>
        <MobileNotificationSection />
      </section>
      <section>
        <h2 className="mb-2 px-1 text-xs font-medium text-zinc-500">
          后台保活
        </h2>
        <MobileBackgroundSection />
      </section>
    </div>
  );
}
