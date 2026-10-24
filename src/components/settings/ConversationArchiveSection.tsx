import { useEffect, useState } from 'react';
import { Card, SettingItem } from './helpers';
import { useSettingsActions } from './SettingsActionsContext';

/** 保留天数的上限：十年。再大没有意义，也给输入框一个防呆边界。 */
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_RETENTION_DAYS = 30;

/**
 * 会话归档设置。
 *
 * 归档本身不用确认（可从归档视图恢复），真正不可逆的是「到期清理」：这里配的
 * 天数决定归档多久后**永久删除**。0 = 永不清理，需要用户显式选择，不能靠留空
 * 得到 —— 留空/非法输入一律回落到默认 30 天。
 */
export function ConversationArchiveSection() {
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
    <Card
      id="settings-conversations"
      title="会话归档"
      description="归档的会话不计入默认列表，也不参与全局搜索和记忆召回；到期后自动清理"
    >
      <SettingItem
        id="archive-retention-days"
        label="归档保留天数"
        description="归档超过这个天数的会话会在下次启动时永久删除（消息一并清理）；填 0 表示永不清理"
        sectionId="settings-conversations"
        keywords={['archive', 'cleanup', 'retention', 'days', '归档', '清理', '保留', '会话', '历史']}
      >
        <div className="flex items-center gap-2">
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
            className="w-20 rounded-lg border border-edge bg-zinc-800 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
            aria-label="归档保留天数"
          />
          <span className="text-sm text-zinc-400">天</span>
          {days === 0 && (
            <span className="text-xs text-amber-400/90">已关闭自动清理</span>
          )}
        </div>
      </SettingItem>
    </Card>
  );
}
