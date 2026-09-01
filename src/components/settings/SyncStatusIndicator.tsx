/**
 * 同步状态指示器（全局）。
 *
 * 显示当前同步状态的小徽章：
 * - 有未解决冲突：红色，显示"冲突 N"，点击打开冲突 Modal
 * - 否则：按 idle/pushing/pulling/error 显示，点击跳设置页同步分类
 *
 * 放在 AppHeader 或 NavRail 区域。
 * 未配置同步时不显示。
 */

import { useEffect } from 'react';
import { Cloud, RefreshCw, CloudOff, AlertCircle, Check, AlertTriangle } from 'lucide-react';
import { useSyncStore } from '@/stores/syncStore';
import { useViewStore } from '@/stores/viewStore';
import { useSettingsNavStore } from '@/stores/settingsNavStore';
import type { SyncState } from '@/lib/types';

interface SyncStatusIndicatorProps {
  /** 紧凑模式（移动端，只显示图标） */
  compact?: boolean;
}

export function SyncStatusIndicator({ compact = false }: SyncStatusIndicatorProps) {
  const { summary, loaded, load, pendingConflicts, openConflictModal } = useSyncStore();

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  // 未配置或加载中不显示
  if (!loaded || !summary || !summary.configured) {
    return null;
  }

  const state = summary.state;
  const conflictCount = pendingConflicts.length;
  // pull 进度（pulling 时显示百分比）
  const progress = summary.progress;
  const pr = progress && progress.total > 0 ? progress : null;
  const pullPct = pr ? Math.min(100, Math.round((pr.done / pr.total) * 100)) : null;
  // 版本闸门：云端配置版本更高，自动同步挂起
  const versionBlock = summary.versionBlock ?? null;

  const config: Record<
    SyncState,
    { icon: typeof Cloud; color: string; label: string; spin?: boolean }
  > = {
    idle: { icon: Check, color: 'text-emerald-400', label: '已同步' },
    pushing: { icon: RefreshCw, color: 'text-indigo-400', label: '同步中', spin: true },
    pulling: { icon: RefreshCw, color: 'text-indigo-400', label: '同步中', spin: true },
    error: { icon: AlertCircle, color: 'text-red-400', label: '同步错误' },
    notConfigured: { icon: CloudOff, color: 'text-zinc-500', label: '未配置' },
  };

  const c = config[state] ?? config.notConfigured;
  const stateIcon = state === 'idle' ? Cloud : c.icon;
  // 版本闸门命中时，空闲/错误态显示琥珀色"已暂停"而非"已同步"，避免误导
  const paused = !!versionBlock && (state === 'idle' || state === 'error');

  const handleClick = () => {
    // 优先处理冲突：有未解决冲突时点击直接打开冲突 Modal
    if (conflictCount > 0) {
      openConflictModal();
      return;
    }
    // 否则切换到设置视图 + 请求跳转到 sync category
    useViewStore.getState().setActiveId('builtin.settings');
    useSettingsNavStore.getState().requestNavigate('sync');
  };

  // 有冲突时覆盖显示样式（红色 + 冲突数）；版本闸门命中时琥珀色
  const hasConflicts = conflictCount > 0;
  const displayColor = hasConflicts
    ? 'text-red-400'
    : paused
      ? 'text-amber-400'
      : c.color;
  const Icon = hasConflicts ? AlertTriangle : paused ? AlertTriangle : stateIcon;
  const displayLabel = hasConflicts
    ? compact
      ? `${conflictCount}`
      : `冲突 ${conflictCount}`
    : paused
      ? '同步已暂停'
      : state === 'pulling' && pullPct !== null
        ? `同步中 ${pullPct}%`
        : c.label;
  const title = hasConflicts
    ? `有 ${conflictCount} 项未解决冲突，点击处理`
    : paused && versionBlock
      ? `同步已暂停：云端配置的客户端版本号（v${versionBlock.cloudVersion}）高于本机（v${versionBlock.localVersion}），点击查看`
      : summary.error
        ? `错误：${summary.error}`
        : state === 'pulling' && pr
          ? `正在拉取 ${pr.done}/${pr.total} 项 · ${pullPct}%`
          : c.label;

  return (
    <button
      onClick={handleClick}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors hover:bg-zinc-800 ${
        displayColor
      } ${hasConflicts ? 'animate-pulse' : ''}`}
      title={title}
    >
      <Icon className={`w-3.5 h-3.5 ${!hasConflicts && c.spin ? 'animate-spin' : ''}`} />
      {!compact && <span>{displayLabel}</span>}
      {compact && state === 'pulling' && pullPct !== null && (
        <span className="tabular-nums">{pullPct}%</span>
      )}
      {!hasConflicts && state === 'idle' && summary.pendingCount > 0 && (
        <span className="text-amber-400">({summary.pendingCount})</span>
      )}
    </button>
  );
}
