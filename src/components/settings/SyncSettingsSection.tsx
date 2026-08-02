/**
 * 同步设置页（桌面端）。
 *
 * 三种状态：
 * 1. 未配置：显示配对入口（第一台设备 / 加入已有账户）
 * 2. 已配置：显示状态摘要 + sync_profile 勾选 + 设备列表 + 危险操作
 * 3. 配对中：显示配置码（第一台设备，仅此一次）
 */

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { RefreshCw, Cloud, CloudOff, KeyRound, Laptop, Smartphone, Trash2, AlertTriangle, Copy, Check, ShieldCheck, Link2, Unlink, Info } from 'lucide-react';
import { Card, SettingItem } from './helpers';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Toggle from '@/components/ui/Toggle';
import Modal from '@/components/ui/Modal';
import { useSyncStore } from '@/stores/syncStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { SyncCategory, SyncProfile } from '@/lib/types';
import { formatSize } from '@/lib/sftp-helpers';
import { SYNC_DISCLAIMER_BODY, SYNC_DISCLAIMER_TITLE } from '@/lib/syncDisclaimer';
import { validateNewAccountPassword } from '@/lib/syncPassword';
import { OFFICIAL_SYNC_SERVER_URL } from '@/lib/constants';
import Select from '@/components/ui/Select';

const SECTION_ID = 'settings-sync';

/** 一级分类的中文标签 + 说明 */
const CATEGORY_LABELS: Record<SyncCategory, { label: string; description: string; sensitive?: boolean }> = {
  connections: { label: 'SSH 连接', description: '同步连接列表（不含密码/密钥）' },
  quickCommands: { label: '快捷命令', description: '同步快捷命令列表' },
  skills: { label: '技能', description: '同步技能列表' },
  mcpServers: {
    label: 'MCP 服务器',
    description: '同步 MCP 服务器配置（可能含 token；仅桌面，移动端不同步）',
  },
  conversations: { label: '对话历史', description: '同步对话 + 消息 + plans（不含图片）' },
  terminalSettings: { label: '终端设置', description: '颜色 / 字号 / 字体' },
  modelService: { label: '模型服务', description: 'baseUrl / model / vision / 重试策略' },
  agentPolicy: { label: 'Agent 策略', description: '命令确认 / 超时 / 系统提示词等' },
  displaySettings: { label: '对话显示', description: '隐藏思考过程等展示偏好' },
  agentTools: {
    label: 'Agent 工具',
    description: '联网搜索 / HTTP 抓取 / 云页面开关，及搜索模式、提供商',
  },
  secrets: { label: 'API Key', description: '同步 LLM API Key 与搜索 API Key（敏感，默认关闭）', sensitive: true },
};

export function SyncSettingsSection() {
  const {
    summary,
    devices,
    quota,
    loaded,
    actionLoading,
    error,
    load,
    pairFirst,
    pairJoin,
    updateProfile,
    pushNow,
    pullNow,
    refreshDevices,
    removeDevice,
    resetAccount,
    disable,
    clearError,
  } = useSyncStore();

  const [serverSource, setServerSource] = useState<'official' | 'custom'>('official');
  const [customServerUrl, setCustomServerUrl] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountPasswordConfirm, setAccountPasswordConfirm] = useState('');
  const [localPasswordError, setLocalPasswordError] = useState<string | null>(null);
  const [mode, setMode] = useState<'idle' | 'first' | 'join' | 'showCode'>('idle');
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [resetCode, setResetCode] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [disclaimerAccepting, setDisclaimerAccepting] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const resolvedServerUrl =
    serverSource === 'official' ? OFFICIAL_SYNC_SERVER_URL : customServerUrl.trim();

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
      // settingsStore 无 error UI；失败时弹窗保持打开，可再点
    } finally {
      setDisclaimerAccepting(false);
    }
  };

  // ── 配对流程 ──────────────────────────────

  const clearPairForm = () => {
    setJoinCode('');
    setAccountPassword('');
    setAccountPasswordConfirm('');
    setLocalPasswordError(null);
  };

  const handlePairFirst = async () => {
    if (!resolvedServerUrl) return;
    const err = validateNewAccountPassword(accountPassword, accountPasswordConfirm);
    if (err) {
      setLocalPasswordError(err);
      return;
    }
    setLocalPasswordError(null);
    try {
      const code = await pairFirst(resolvedServerUrl, accountPassword);
      if (code) {
        setGeneratedCode(code);
        setMode('showCode');
        setAccountPassword('');
        setAccountPasswordConfirm('');
      }
    } catch {
      // error 已在 store 里
    }
  };

  const handlePairJoin = async () => {
    if (!resolvedServerUrl || !joinCode.trim()) return;
    setLocalPasswordError(null);
    try {
      await pairJoin(resolvedServerUrl, joinCode.trim(), accountPassword);
      setMode('idle');
      clearPairForm();
      showHint('首次同步可能需要1分钟甚至更长，请不要关闭应用，耐心等待，"拉取中..."按钮变为"拉取"则为完成');
    } catch {
      // error 已在 store 里
    }
  };

  const handleCopyCode = async () => {
    if (!generatedCode) return;
    try {
      await navigator.clipboard.writeText(generatedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板可能不可用
    }
  };

  // ── sync_profile 切换 ──────────────────────

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

  // ── 危险操作 ──────────────────────────────

  const handleReset = async () => {
    if (!resetCode.trim()) return;
    try {
      await resetAccount(resetCode.trim());
      setResetCode('');
      setShowResetConfirm(false);
      setMode('idle');
      setGeneratedCode(null);
    } catch {
      // error 已在 store 里
    }
  };

  const handleDisable = async () => {
    await disable();
    setMode('idle');
    setGeneratedCode(null);
  };

  // ── 渲染分支 ──────────────────────────────

  // 加载中
  if (!loaded) {
    return (
      <div className="space-y-6">
        <Card id={SECTION_ID} title="跨设备同步" description="加载中…">
          <div className="px-6 py-8 text-center text-zinc-500">
            <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin" />
            正在加载同步状态…
          </div>
        </Card>
      </div>
    );
  }

  const configured = summary?.configured ?? false;

  return (
    <div className="space-y-6">
      <Modal
        open={showDisclaimer}
        onClose={() => {}}
        title={SYNC_DISCLAIMER_TITLE}
        size="md"
        dismissible={false}
      >
        <div className="px-4 pb-4 space-y-4">
          <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">
            {SYNC_DISCLAIMER_BODY}
          </div>
          <Button
            variant="primary"
            className="w-full"
            loading={disclaimerAccepting}
            onClick={() => void handleAcceptDisclaimer()}
          >
            我已了解
          </Button>
        </div>
      </Modal>

      {/* 错误提示 */}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-red-300">{error}</p>
          </div>
          <button onClick={clearError} className="text-red-400 hover:text-red-300 text-xs">
            关闭
          </button>
        </div>
      )}

      {/* 引导提示（开启同步项 / 加入同步成功） */}
      {hint && (
        <div className="rounded-lg border border-amber-800 bg-amber-900/20 px-4 py-3 flex items-start gap-3">
          <Info className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-amber-200">{hint}</p>
          </div>
          <button
            onClick={() => {
              if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
              setHint(null);
            }}
            className="text-amber-400 hover:text-amber-300 text-xs"
          >
            关闭
          </button>
        </div>
      )}

      {/* 配对流程：显示配置码 */}
      {mode === 'showCode' && generatedCode && (
        <Card id={SECTION_ID} title="配对成功" description="请立即手抄保存配置码，此码仅显示一次">
          <div className="px-6 py-6">
            <div className="rounded-lg border border-amber-800 bg-amber-900/20 p-4 mb-4">
              <div className="flex items-center gap-2 mb-2">
                <KeyRound className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-medium text-amber-200">配置码（必须手抄保存）</span>
              </div>
              <div className="flex items-center gap-3">
                <code className="flex-1 font-mono text-lg text-amber-100 tracking-wider break-all">
                  {generatedCode}
                </code>
                <Button variant="secondary" size="sm" onClick={handleCopyCode}>
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
              <p className="text-xs text-amber-500/70 mt-2">
                丢失配置码将无法恢复账户。其他设备加入需要此配置码与同一账户密码。服务端不存储配置码与密码。
              </p>
            </div>
            <Button variant="primary" onClick={() => { setMode('idle'); setGeneratedCode(null); clearPairForm(); }}>
              我已保存，关闭
            </Button>
          </div>
        </Card>
      )}

      {/* 未配置：配对入口 */}
      {!configured && mode !== 'showCode' && (
        <Card id={SECTION_ID} title="跨设备同步" description="自动同步配置、聊天记录到其他设备">
          <div className="px-6 py-6 space-y-4">
            {mode === 'idle' && (
              <div className="text-center py-4">
                <CloudOff className="w-8 h-8 mx-auto mb-3 text-zinc-600" />
                <p className="text-sm text-zinc-400 mb-4">尚未配置同步</p>
                <div className="flex flex-col items-center gap-2">
                  <Button variant="primary" onClick={() => setMode('first')}>
                    <Cloud className="w-4 h-4" />
                    设置新账户
                  </Button>
                  <Button variant="secondary" onClick={() => setMode('join')}>
                    <Link2 className="w-4 h-4" />
                    加入已有账户
                  </Button>
                </div>
              </div>
            )}

            {(mode === 'first' || mode === 'join') && (
              <div className="space-y-4">
                <SettingItem
                  id="sync-server-source"
                  label="同步服务器"
                  description="Marcel 官方服务器，或填写自建 / 第三方地址"
                  sectionId={SECTION_ID}
                  keywords={['server', 'url', 'host', '服务器', '官方', '自定义']}
                >
                  <Select
                    value={serverSource}
                    onChange={setServerSource}
                    options={[
                      { value: 'official', label: 'Marcel 官方服务器' },
                      { value: 'custom', label: '自定义服务器地址' },
                    ]}
                    className="min-w-[12rem]"
                  />
                </SettingItem>

                {serverSource === 'custom' && (
                  <SettingItem
                    id="sync-server-url-custom"
                    label="自定义服务器地址"
                    description="自部署或第三方同步服务端完整 URL"
                    sectionId={SECTION_ID}
                    keywords={['server', 'url', 'host', '自定义', '服务器']}
                  >
                    <Input
                      value={customServerUrl}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setCustomServerUrl(e.target.value)}
                      placeholder="https://sync.example.com 或 http://192.168.1.100:8787"
                      className="w-full"
                    />
                  </SettingItem>
                )}

                {mode === 'join' && (
                  <SettingItem
                    id="sync-join-code"
                    label="配置码"
                    description="从其他设备获取的 32 位配置码"
                    sectionId={SECTION_ID}
                    keywords={['config', 'code', 'pair', '配置码', '配对']}
                  >
                    <Input
                      value={joinCode}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setJoinCode(e.target.value)}
                      placeholder="32 位配置码"
                      className="w-full font-mono"
                      maxLength={32}
                    />
                  </SettingItem>
                )}

                {mode === 'first' ? (
                  <>
                    <SettingItem
                      id="sync-account-password"
                      label="账户密码"
                      description="参与端到端密钥派生，服务端不存储；至少 8 位"
                      sectionId={SECTION_ID}
                      keywords={['password', '密码', '账户']}
                    >
                      <Input
                        type="password"
                        value={accountPassword}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setAccountPassword(e.target.value);
                          setLocalPasswordError(null);
                        }}
                        placeholder="设置账户密码"
                        className="w-full"
                        autoComplete="new-password"
                      />
                    </SettingItem>
                    <SettingItem
                      id="sync-account-password-confirm"
                      label="确认密码"
                      description="请再输入一次"
                      sectionId={SECTION_ID}
                      keywords={['password', '确认密码']}
                    >
                      <Input
                        type="password"
                        value={accountPasswordConfirm}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => {
                          setAccountPasswordConfirm(e.target.value);
                          setLocalPasswordError(null);
                        }}
                        placeholder="再次输入密码"
                        className="w-full"
                        autoComplete="new-password"
                      />
                    </SettingItem>
                  </>
                ) : (
                  <SettingItem
                    id="sync-join-password"
                    label="账户密码"
                    description="新账户必填；旧账户若未设密码可留空"
                    sectionId={SECTION_ID}
                    keywords={['password', '密码', '加入']}
                  >
                    <Input
                      type="password"
                      value={accountPassword}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setAccountPassword(e.target.value)}
                      placeholder="账户密码（旧账户可留空）"
                      className="w-full"
                      autoComplete="current-password"
                    />
                  </SettingItem>
                )}

                {localPasswordError && (
                  <p className="px-6 text-sm text-red-400">{localPasswordError}</p>
                )}

                <div className="flex gap-2 pt-2">
                  <Button
                    variant="primary"
                    onClick={mode === 'first' ? handlePairFirst : handlePairJoin}
                    loading={actionLoading}
                    disabled={
                      !resolvedServerUrl ||
                      (mode === 'join' && !joinCode.trim()) ||
                      (mode === 'first' && !accountPassword)
                    }
                  >
                    {mode === 'first' ? '生成配置码并注册' : '加入账户'}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setMode('idle');
                      clearPairForm();
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* 已配置：状态 + profile + 设备列表 */}
      {configured && summary && (
        <>
          {/* 状态摘要 */}
          <Card id={SECTION_ID} title="跨设备同步" description={`服务器：${summary.serverUrl ?? '未设置'}`}>
            <SettingItem
              id="sync-status"
              label="同步状态"
              description={summary.error ? `错误：${summary.error}` : `待同步：${summary.pendingCount} 项`}
              sectionId={SECTION_ID}
              keywords={['status', 'state', '同步状态']}
            >
              <div className="flex items-center gap-2">
                <SyncStateBadge state={summary.state} />
                <Button variant="secondary" onClick={() => pushNow()} disabled={summary.state === 'pushing'}>
                  <RefreshCw className={`w-4 h-4 ${summary.state === 'pushing' ? 'animate-spin' : ''}`} />
                  推送
                </Button>
                <Button variant="secondary" onClick={() => pullNow()} disabled={summary.state === 'pulling'}>
                  <RefreshCw className={`w-4 h-4 ${summary.state === 'pulling' ? 'animate-spin' : ''}`} />
                  拉取
                </Button>
              </div>
            </SettingItem>

            <SettingItem
              id="sync-device-id"
              label="本设备 ID"
              description={`平台：${summary.platform === 'desktop' ? '桌面' : '移动'}`}
              sectionId={SECTION_ID}
              keywords={['device', 'id', '设备']}
            >
              <code className="text-xs text-zinc-400 font-mono">
                {summary.deviceId?.slice(0, 8) ?? '—'}
              </code>
            </SettingItem>

            {/* 存储配额：仅新版服务端支持；旧服务端（404）/ 网络失败时 quota 为 null，整行不渲染 */}
            {quota !== null && (
              <SettingItem
                id="sync-quota"
                label="存储配额"
                description={
                  quota.quotaLimitBytes > 0
                    ? `已用 ${formatSize(quota.quotaUsedBytes)} / ${formatSize(quota.quotaLimitBytes)}`
                    : '自部署服务器，无配额限制'
                }
                sectionId={SECTION_ID}
                keywords={['quota', '配额', '存储', '空间', 'storage']}
              >
                {quota.quotaLimitBytes > 0 ? (
                  <div className="w-44">
                    <QuotaBar
                      used={quota.quotaUsedBytes}
                      limit={quota.quotaLimitBytes}
                    />
                  </div>
                ) : (
                  <span className="text-xs text-emerald-400">无限制</span>
                )}
              </SettingItem>
            )}
          </Card>

          {/* sync_profile 勾选 */}
          <Card id="settings-sync-profile" title="同步内容" description="选择要同步的数据类别">
            {(Object.keys(CATEGORY_LABELS) as SyncCategory[]).map((cat) => {
              const info = CATEGORY_LABELS[cat];
              const enabled = summary.profile.enabledCategories.includes(cat);
              return (
                <SettingItem
                  key={cat}
                  id={`sync-cat-${cat}`}
                  label={info.label}
                  description={info.description}
                  sectionId="settings-sync-profile"
                  keywords={['同步', cat, info.label]}
                >
                  <div className="flex items-center gap-2">
                    {info.sensitive && (
                      <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                    )}
                    <Toggle
                      checked={enabled}
                      onChange={(v: boolean) => handleToggleCategory(cat, v)}
                    />
                  </div>
                </SettingItem>
              );
            })}
          </Card>

          {/* 设备列表 */}
          <Card id="settings-sync-devices" title="已配对设备" description={`${devices.length} 台设备`}>
            {devices.length === 0 ? (
              <div className="px-6 py-4 text-sm text-zinc-500">加载中…</div>
            ) : (
              devices.map((d) => (
                <SettingItem
                  key={d.deviceId}
                  id={`sync-device-${d.deviceId}`}
                  label={d.platform === 'desktop' ? '桌面端' : '移动端'}
                  description={`最后活跃：${new Date(d.lastSeenAt).toLocaleString()}`}
                  sectionId="settings-sync-devices"
                  keywords={['device', '设备', d.platform]}
                >
                  <div className="flex items-center gap-2">
                    {d.platform === 'desktop' ? (
                      <Laptop className="w-4 h-4 text-zinc-400" />
                    ) : (
                      <Smartphone className="w-4 h-4 text-zinc-400" />
                    )}
                    <code className="text-xs text-zinc-500 font-mono">{d.deviceId.slice(0, 8)}</code>
                    {d.deviceId === summary.deviceId ? (
                      <span className="text-xs text-emerald-400">本机</span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeDevice(d.deviceId)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </SettingItem>
              ))
            )}
            <div className="px-6 py-3">
              <Button variant="secondary" onClick={refreshDevices}>
                <RefreshCw className="w-4 h-4" />
                刷新设备列表
              </Button>
            </div>
          </Card>

          {/* 危险操作 */}
          <Card id="settings-sync-danger" title="危险操作" description="账户重置将删除所有设备的同步数据">
            {!showResetConfirm ? (
              <SettingItem
                id="sync-reset"
                label="账户重置"
                description="删除服务端所有数据 + 重新生成配置码"
                sectionId="settings-sync-danger"
                keywords={['reset', '重置', '删除', '危险']}
              >
                <Button variant="danger" onClick={() => setShowResetConfirm(true)}>
                  <Trash2 className="w-4 h-4" />
                  重置账户
                </Button>
              </SettingItem>
            ) : (
              <div className="px-6 py-4 space-y-3">
                <div className="rounded-lg border border-red-800 bg-red-900/20 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-4 h-4 text-red-400" />
                    <span className="text-sm font-medium text-red-300">确认重置账户</span>
                  </div>
                  <p className="text-xs text-red-400/80 mb-3">
                    此操作将删除服务端所有同步数据，所有设备需要重新配对。请输入当前配置码确认。
                  </p>
                  <Input
                    value={resetCode}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setResetCode(e.target.value)}
                    placeholder="当前配置码"
                    className="w-full font-mono mb-2"
                    maxLength={32}
                  />
                  <div className="flex gap-3">
                    <Button variant="danger" onClick={handleReset} loading={actionLoading}>
                      确认重置
                    </Button>
                    <Button variant="ghost" onClick={() => { setShowResetConfirm(false); setResetCode(''); }}>
                      取消
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <SettingItem
              id="sync-disable"
              label="关闭同步"
              description="从服务端移除本设备并清除本机凭证（账户数据保留以便重新启用）"
              sectionId="settings-sync-danger"
              keywords={['disable', '关闭', 'logout', '退出']}
            >
              <Button variant="ghost" onClick={handleDisable} loading={actionLoading}>
                <Unlink className="w-4 h-4" />
                关闭同步
              </Button>
            </SettingItem>
          </Card>
        </>
      )}
    </div>
  );
}

/** 同步状态徽章 */
function SyncStateBadge({ state }: { state: string }) {
  const config: Record<string, { label: string; color: string; dot?: boolean }> = {
    idle: { label: '已同步', color: 'text-emerald-400 bg-emerald-900/20 border-emerald-800' },
    pushing: { label: '推送中', color: 'text-indigo-300 bg-indigo-900/20 border-indigo-800', dot: true },
    pulling: { label: '拉取中', color: 'text-indigo-300 bg-indigo-900/20 border-indigo-800', dot: true },
    error: { label: '错误', color: 'text-red-300 bg-red-900/20 border-red-800' },
    notConfigured: { label: '未配置', color: 'text-zinc-400 bg-zinc-800 border-zinc-700' },
  };
  const c = config[state] ?? config.notConfigured;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border ${c.color}`}>
      {c.dot && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
      {c.label}
    </span>
  );
}

/** 配额使用进度条：超过 90% 转琥珀色提示接近上限，超过 100% 变红 */
function QuotaBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const barClass =
    pct >= 100
      ? 'bg-red-500'
      : pct >= 90
        ? 'bg-amber-400'
        : 'bg-indigo-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={`text-xs tabular-nums whitespace-nowrap ${
          pct >= 90 ? 'text-amber-400' : 'text-zinc-400'
        }`}
      >
        {Math.round(pct)}%
      </span>
    </div>
  );
}
