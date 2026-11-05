import { SyncPanel } from '@/components/settings/sync/SyncPanel';
import { MobileArchiveSection } from './MobileArchiveSection';

/**
 * 「同步与会话」页（手机）：跨设备同步 + 会话归档保留天数。
 *
 * 同步部分与桌面共用 `SyncPanel`：功能完全一致，区别只有——不生成二维码（手机用不着扫自己），
 * 改为显示同步码 + 复制按钮；布局是整宽卡片，弹层是底部 Sheet。
 */
export function MobileSyncSection() {
  return (
    <div className="flex flex-col gap-4">
      <section>
        <SyncPanel variant="mobile" />
      </section>
      <section>
        <h2 className="mb-2 px-1 text-xs font-medium text-zinc-500">会话归档</h2>
        <MobileArchiveSection />
      </section>
    </div>
  );
}
