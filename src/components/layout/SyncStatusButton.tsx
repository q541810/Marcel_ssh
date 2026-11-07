import { CloudAlert } from 'lucide-react';
import { useSyncStore } from '@/stores/syncStore';
import { describeSyncStatus, needsAttention } from '@/lib/syncModel';
import { openSyncSettings } from '@/lib/syncNav';

/**
 * 标题栏的同步状态图标：**只在需要用户处理时出现**（出错 / 等待确认 / 需要升级）。
 * 正常同步、同步中、没开启同步都不占位也不闪——同步是后台的事，没问题就不该打扰。
 * 点它直接跳到设置里的「跨设备同步」。
 */
export default function SyncStatusButton() {
  const status = useSyncStore((s) => s.status);
  if (!status || !needsAttention(status.state)) return null;

  const view = describeSyncStatus(status);
  const tone = status.state === 'error' ? 'text-red-400 hover:text-red-300' : 'text-amber-400 hover:text-amber-300';
  return (
    <button
      type="button"
      onClick={openSyncSettings}
      className={`pressable focus-ring flex h-6 w-6 items-center justify-center rounded-md hover:bg-state-soft ${tone}`}
      title={`跨设备同步：${view.title}，点击查看`}
      aria-label={`跨设备同步：${view.title}，点击查看`}
    >
      <CloudAlert size={16} strokeWidth={1.5} />
    </button>
  );
}
