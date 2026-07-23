/**
 * 移动端同步设置页。
 *
 * 复用桌面端 syncStore，适配移动端 MobileSettingRow 样式。
 * 简化版 UI：不显示设备列表（屏幕小），只做 profile + 危险操作。
 *
 * 配对流程（设置新账户 / 加入已有账户）通过 MobileSyncPairPage 打开
 * 独立全屏页面，不再在 section 内原地切换内容。
 */

import { useEffect, useState } from 'react';
import { RefreshCw, CloudOff, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useSyncStore } from '@/stores/syncStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { SyncCategory, SyncProfile } from '@/lib/types';
import Toggle from '@/components/ui/Toggle';
import { MobileSettingRow } from './MobileSettingRow';
import MobileSyncPairPage, { type MobileSyncPairMode } from '../MobileSyncPairPage';
import MobileSheet from '../ui/MobileSheet';
import { SYNC_DISCLAIMER_BODY, SYNC_DISCLAIMER_TITLE } from '@/lib/syncDisclaimer';

/** 移动端无 MCP，不展示 mcpServers 同步开关（后端也会平台过滤） */
const CATEGORY_LABELS: Partial<
  Record<SyncCategory, { label: string; sensitive?: boolean }>
> = {
  connections: { label: 'SSH 连接' },
  quickCommands: { label: '快捷命令' },
  skills: { label: '技能' },
  conversations: { label: '对话历史' },
  terminalSettings: { label: '终端设置' },
  modelService: { label: '模型服务' },
  agentPolicy: { label: 'Agent 策略' },
  displaySettings: { label: '对话显示' },
  secrets: { label: 'API Key', sensitive: true },
};

const inputClass =
  'mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500';

export function MobileSyncSection() {
  const {
    summary,
    loaded,
    actionLoading,
    error,
    load,
    updateProfile,
    pushNow,
    pullNow,
    resetAccount,
    disable,
    clearError,
  } = useSyncStore();

  // 配对全屏页面
  const [pairPageOpen, setPairPageOpen] = useState(false);
  const [pairMode, setPairMode] = useState<MobileSyncPairMode>('first');

  const [resetCode, setResetCode] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [disclaimerAccepting, setDisclaimerAccepting] = useState(false);

  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const hasAcceptedSyncDisclaimer = useSettingsStore((s) => s.settings.hasAcceptedSyncDisclaimer);
  const updateSettings = useSettingsStore((s) => s.update);
  const showDisclaimer = settingsLoaded && !hasAcceptedSyncDisclaimer;

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  const handleAcceptDisclaimer = async () => {
    setDisclaimerAccepting(true);
    try {
      await updateSettings({ hasAcceptedSyncDisclaimer: true });
    } catch {
      // 失败时 sheet 保持打开
    } finally {
      setDisclaimerAccepting(false);
    }
  };

  const openPairPage = (mode: MobileSyncPairMode) => {
    setPairMode(mode);
    setPairPageOpen(true);
  };

  const handleToggleCategory = (cat: SyncCategory, enabled: boolean) => {
    if (!summary) return;
    const current = new Set(summary.profile.enabledCategories);
    if (enabled) current.add(cat);
    else current.delete(cat);
    const newProfile: SyncProfile = {
      enabledCategories: Array.from(current),
      excludedKeys: summary.profile.excludedKeys ?? [],
    };
    updateProfile(newProfile);
  };

  const handleReset = async () => {
    if (!resetCode.trim()) return;
    try {
      await resetAccount(resetCode.trim());
      setResetCode('');
      setShowResetConfirm(false);
    } catch {
      // error 已在 store
    }
  };

  const handleDisable = async () => {
    await disable();
  };

  // 加载中
  if (!loaded) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
        <RefreshCw className="w-5 h-5 mb-2 animate-spin" />
        <span className="text-sm">加载中…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <MobileSheet
        open={showDisclaimer}
        onClose={() => {}}
        title={SYNC_DISCLAIMER_TITLE}
        dismissible={false}
        footer={
          <button
            type="button"
            disabled={disclaimerAccepting}
            onClick={() => void handleAcceptDisclaimer()}
            className="w-full rounded-lg bg-indigo-600 py-3 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-50"
          >
            {disclaimerAccepting ? '保存中…' : '我已了解'}
          </button>
        }
      >
        <div className="whitespace-pre-wrap px-1 pb-2 text-sm leading-relaxed text-zinc-300">
          {SYNC_DISCLAIMER_BODY}
        </div>
      </MobileSheet>

      {/* 错误提示 */}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="flex-1 text-xs text-red-300">{error}</p>
          <button onClick={clearError} className="text-red-400 text-xs">关闭</button>
        </div>
      )}

      {/* 未配置：配对入口（打开全屏页面） */}
      {!summary?.configured && (
        <div className="flex flex-col items-center py-6 text-center">
          <CloudOff className="w-8 h-8 mb-3 text-zinc-600" />
          <p className="text-sm text-zinc-400 mb-4">尚未配置同步</p>
          <button
            onClick={() => openPairPage('first')}
            className="w-full rounded-lg bg-indigo-600 text-white text-sm font-medium py-2.5 mb-2 active:bg-indigo-500"
          >
            设置新账户
          </button>
          <button
            onClick={() => openPairPage('join')}
            className="w-full rounded-lg border border-zinc-700 text-zinc-200 text-sm font-medium py-2.5 active:bg-zinc-800"
          >
            加入已有账户
          </button>
        </div>
      )}

      {/* 已配置：状态 + profile */}
      {summary?.configured && (
        <>
          {/* 状态 */}
          <MobileSettingRow
            label="同步状态"
            description={summary.error ? `错误：${summary.error}` : `待同步：${summary.pendingCount} 项`}
          >
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => pushNow()}
                disabled={summary.state === 'pushing'}
                className="flex-1 rounded-lg border border-zinc-700 text-zinc-200 text-xs py-2 active:bg-zinc-800"
              >
                {summary.state === 'pushing' ? '推送中…' : '推送'}
              </button>
              <button
                onClick={() => pullNow()}
                disabled={summary.state === 'pulling'}
                className="flex-1 rounded-lg border border-zinc-700 text-zinc-200 text-xs py-2 active:bg-zinc-800"
              >
                {summary.state === 'pulling' ? '拉取中…' : '拉取'}
              </button>
            </div>
          </MobileSettingRow>

          {/* sync_profile */}
          <div className="mt-2 mb-1 px-1 text-xs font-medium text-zinc-500">同步内容</div>
          {(Object.keys(CATEGORY_LABELS) as SyncCategory[]).map((cat) => {
            const info = CATEGORY_LABELS[cat];
            if (!info) return null;
            const enabled = summary.profile.enabledCategories.includes(cat);
            return (
              <MobileSettingRow
                key={cat}
                label={info.label}
                trailing={
                  <div className="flex items-center gap-1.5">
                    {info.sensitive && <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />}
                    <Toggle checked={enabled} onChange={(v) => handleToggleCategory(cat, v)} />
                  </div>
                }
              />
            );
          })}

          {/* 危险操作 */}
          <div className="mt-4 mb-1 px-1 text-xs font-medium text-red-400/80">危险操作</div>

          {!showResetConfirm ? (
            <MobileSettingRow
              label="账户重置"
              description="删除服务端所有数据 + 重新生成配置码"
              trailing={
                <button
                  onClick={() => setShowResetConfirm(true)}
                  className="rounded-lg border border-red-800 text-red-300 text-xs px-3 py-1.5 active:bg-red-900/30"
                >
                  重置
                </button>
              }
            />
          ) : (
            <div className="rounded-xl border border-red-800 bg-red-900/20 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                <span className="text-sm font-medium text-red-300">确认重置</span>
              </div>
              <p className="text-xs text-red-400/80 mb-2">
                所有设备需要重新配对。请输入当前配置码确认。
              </p>
              <input
                value={resetCode}
                onChange={(e) => setResetCode(e.target.value)}
                placeholder="当前配置码"
                className={inputClass}
                maxLength={32}
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={handleReset}
                  disabled={actionLoading}
                  className="flex-1 rounded-lg bg-red-700 text-white text-xs py-2 active:bg-red-600"
                >
                  {actionLoading ? '处理中…' : '确认重置'}
                </button>
                <button
                  onClick={() => { setShowResetConfirm(false); setResetCode(''); }}
                  className="flex-1 rounded-lg border border-zinc-700 text-zinc-300 text-xs py-2 active:bg-zinc-800"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          <MobileSettingRow
            label="关闭同步"
            description="从服务端移除本设备并清除本机凭证（账户数据保留以便重新启用）"
            trailing={
              <button
                onClick={handleDisable}
                disabled={actionLoading}
                className="rounded-lg border border-zinc-700 text-zinc-300 text-xs px-3 py-1.5 active:bg-zinc-800"
              >
                关闭
              </button>
            }
          />
        </>
      )}

      {/* 配对全屏页面 */}
      <MobileSyncPairPage
        open={pairPageOpen}
        initialMode={pairMode}
        onClose={() => setPairPageOpen(false)}
      />
    </div>
  );
}
