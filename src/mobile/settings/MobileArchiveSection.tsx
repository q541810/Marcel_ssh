import { useEffect, useState } from 'react';
import { useSettingsActions } from '@/components/settings/SettingsActionsContext';
import { MobileSettingRow } from './MobileSettingRow';

/** 保留天数的上限：十年。与桌面设置项同一上限（后端还会再夹一次）。 */
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_RETENTION_DAYS = 30;

/**
 * 会话归档设置（移动端）：与桌面 ConversationArchiveSection 同一套语义。
 *
 * 归档本身不用确认（可从归档视图恢复），真正不可逆的是「到期清理」：这里配的
 * 天数决定归档多久后**永久删除**。0 = 永不清理，需要用户显式选择，不能靠留空
 * 得到 —— 留空/非法输入一律回落到默认 30 天。
 */
export function MobileArchiveSection() {
  const { settings, update } = useSettingsActions();
  const days = settings.archiveRetentionDays ?? DEFAULT_RETENTION_DAYS;

  // 输入过程要允许「清空再重打」，所以本地维护草稿字符串，提交时才夹取。
  const [draft, setDraft] = useState(String(days));
  useEffect(() => {
    setDraft(String(days));
  }, [days]);

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    const next = Number.isFinite(parsed)
      ? Math.min(MAX_RETENTION_DAYS, Math.max(0, parsed))
      : DEFAULT_RETENTION_DAYS;
    setDraft(String(next));
    if (next !== days) update({ archiveRetentionDays: next });
  };

  return (
    <div className="space-y-2">
      <MobileSettingRow
        label="归档保留天数"
        description="归档超过这个天数的会话会在下次启动应用时永久删除（消息一并清理）；填 0 表示永不清理"
      >
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_RETENTION_DAYS}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
                e.currentTarget.blur();
              }
            }}
            className="w-24 rounded-lg border border-edge bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            aria-label="归档保留天数"
          />
          <span className="text-sm text-zinc-400">天</span>
          {days === 0 && (
            <span className="text-xs text-amber-400/90">已关闭自动清理</span>
          )}
        </div>
      </MobileSettingRow>
      <p className="px-1 text-xs leading-relaxed text-zinc-500">
        归档的会话不进入默认列表，也不参与全局搜索与记忆召回；归档本身可随时在「已归档」里恢复。
      </p>
    </div>
  );
}
