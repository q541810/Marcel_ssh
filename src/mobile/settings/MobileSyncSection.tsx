/**
 * 移动端同步设置页。
 *
 * 复用桌面端 syncStore，适配移动端 MobileSettingRow 样式。
 * 简化版 UI：不显示设备列表（屏幕小），只做 profile + 危险操作。
 *
 * 配对流程（设置新账户 / 加入已有账户）通过 MobileSyncPairPage 打开
 * 独立全屏页面，不再在 section 内原地切换内容。
 */

import { useEffect, useRef, useState } from 'react';
import { RefreshCw, CloudOff, AlertTriangle, ShieldCheck, Info } from 'lucide-react';
import { useSyncStore } from '@/stores/syncStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { SyncCategory, SyncProfile } from '@/lib/types';
import { formatSize } from '@/lib/sftp-helpers';
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
  agentTools: { label: 'Agent 工具' },
  secrets: { label: 'API Key（LLM 与搜索，敏感）', sensitive: true },
};

const inputClass =
  'mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500';

export function MobileSyncSection() {
  const {
    summary,
    quota,
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

  // pull 进度（pulling 时显示百分比）
  const progress = summary?.progress ?? null;
  const pullPct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : null;

  // 配对全屏页面
  const [pairPageOpen, setPairPageOpen] = useState(false);
  const [pairMode, setPairMode] = useState<MobileSyncPairMode>('first');

  const [resetCode, setResetCode] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [disclaimerAccepting, setDisclaimerAccepting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 版本闸门：手动同步前的风险确认（'push' | 'pull' | null）
  const [forceSyncConfirm, setForceSyncConfirm] = useState<'push' | 'pull' | null>(null);
  const [forceSyncLoading, setForceSyncLoading] = useState(false);

  // 设置一条引导提示，5 秒后自动消失。重复调用会重置计时器。
  const showHint = (text: string) => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    setHint(text);
    hintTimerRef.current = setTimeout(() => {
      setHint(null);
      hintTimerRef.current = null;
    }, 5000);
  };

  useEffect(() => {
    return () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    };
  }, []);

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

  // 手动同步：版本闸门命中时先弹风险确认，用户明确坚持才带 force 执行
  const handleManualPush = () => {
    if (summary?.versionBlock) {
      setForceSyncConfirm('push');
      return;
    }
    void pushNow();
  };

  const handleManualPull = () => {
    if (summary?.versionBlock) {
      setForceSyncConfirm('pull');
      return;
    }
    void pullNow();
  };

  const handleForceSync = async () => {
    const action = forceSyncConfirm;
    if (!action) return;
    setForceSyncLoading(true);
    try {
      if (action === 'push') await pushNow(true);
      else await pullNow(true);
      setForceSyncConfirm(null);
    } catch {
      // error 已在 store
    } finally {
      setForceSyncLoading(false);
    }
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

      {/* 版本闸门：强制同步风险确认（用户明确坚持才放行一次） */}
      <MobileSheet
        open={forceSyncConfirm !== null}
        onClose={() => setForceSyncConfirm(null)}
        title="确定要强制同步吗？"
        footer={
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setForceSyncConfirm(null)}
              className="flex-1 rounded-lg border border-zinc-700 py-3 text-sm font-medium text-zinc-200 active:bg-zinc-800"
            >
              取消
            </button>
            <button
              type="button"
              disabled={forceSyncLoading}
              onClick={() => void handleForceSync()}
              className="flex-1 rounded-lg bg-red-600 py-3 text-sm font-medium text-white active:bg-red-500 disabled:opacity-50"
            >
              {forceSyncLoading
                ? '同步中…'
                : forceSyncConfirm === 'push'
                  ? '仍要推送'
                  : '仍要拉取'}
            </button>
          </div>
        }
      >
        <div className="rounded-lg border border-amber-800 bg-amber-900/20 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <span className="text-sm font-medium text-amber-200">
              注意，你的客户端版本号低于云端配置的客户端版本号
            </span>
          </div>
          <p className="text-xs leading-relaxed text-amber-400/80">
            这很可能导致你的数据损坏，请不要这么做，除非你知道你在做什么。
            {summary?.versionBlock && (
              <>
                本机 v{summary.versionBlock.localVersion}，云端
                v{summary.versionBlock.cloudVersion}。
              </>
            )}
          </p>
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

      {/* 引导提示（开启同步项 / 加入同步成功） */}
      {hint && (
        <div className="rounded-lg border border-amber-800 bg-amber-900/20 px-3 py-2 flex items-start gap-2">
          <Info className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="flex-1 text-xs text-amber-200">{hint}</p>
          <button
            onClick={() => {
              if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
              setHint(null);
            }}
            className="text-amber-400 text-xs"
          >
            关闭
          </button>
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
          {/* 版本闸门警告：云端配置版本更高，自动同步已挂起 */}
          {summary.versionBlock && (
            <div className="rounded-lg border border-amber-800 bg-amber-900/20 px-3 py-2.5 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-xs font-medium text-amber-200">
                  同步已暂停：云端配置的客户端版本号高于本机
                </p>
                <p className="text-[11px] leading-relaxed text-amber-400/80">
                  本机 v{summary.versionBlock.localVersion}，云端
                  v{summary.versionBlock.cloudVersion}。低版本客户端应用新格式数据后可能损坏配置。
                  升级本应用到 v{summary.versionBlock.cloudVersion} 及以上后将自动恢复。
                </p>
              </div>
            </div>
          )}

          {/* 状态 */}
          <MobileSettingRow
            label="同步状态"
            description={summary.error ? `错误：${summary.error}` : `待同步：${summary.pendingCount} 项`}
          >
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => handleManualPush()}
                disabled={summary.state === 'pushing'}
                className="flex-1 rounded-lg border border-zinc-700 text-zinc-200 text-xs py-2 active:bg-zinc-800"
              >
                {summary.state === 'pushing' ? '推送中…' : '推送'}
              </button>
              <button
                onClick={() => handleManualPull()}
                disabled={summary.state === 'pulling'}
                className="flex-1 rounded-lg border border-zinc-700 text-zinc-200 text-xs py-2 active:bg-zinc-800"
              >
                {summary.state === 'pulling'
                  ? pullPct !== null
                    ? `拉取中 ${pullPct}%`
                    : '拉取中…'
                  : '拉取'}
              </button>
            </div>
          </MobileSettingRow>

          {/* 存储配额：仅新版服务端支持；旧服务端（404）/ 网络失败时 quota 为 null，整行不渲染 */}
          {quota !== null && (
            <MobileSettingRow
              label="存储配额"
              description={
                quota.quotaLimitBytes > 0
                  ? `已用 ${formatSize(quota.quotaUsedBytes)} / ${formatSize(quota.quotaLimitBytes)}`
                  : '自部署服务器，无配额限制'
              }
              trailing={
                quota.quotaLimitBytes > 0 ? (
                  <span
                    className={`text-xs tabular-nums ${
                      quota.quotaUsedBytes / quota.quotaLimitBytes >= 0.9
                        ? 'text-amber-400'
                        : 'text-zinc-400'
                    }`}
                  >
                    {Math.min(100, Math.round((quota.quotaUsedBytes / quota.quotaLimitBytes) * 100))}%
                  </span>
                ) : (
                  <span className="text-xs text-emerald-400">无限制</span>
                )
              }
            />
          )}

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
        onPairSuccess={() => {
          // 关闭配对页后回到 section 才显示提示，避免被全屏页遮挡
          setTimeout(() => {
            showHint('首次同步可能需要1分钟甚至更长，请不要关闭应用，耐心等待，"拉取中..."按钮变为"拉取"则为完成');
          }, 400);
        }}
      />
    </div>
  );
}
