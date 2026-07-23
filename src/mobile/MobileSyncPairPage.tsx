/**
 * 移动端跨设备同步配对全屏页面。
 *
 * 把配对流程（设置新账户 / 加入已有账户 / 显示配置码）从同步设置 section
 * 里抽出来，做成独立全屏页面（参考 MobileFileEditor 的 portal 模式），
 * 避免在设置 section 内原地切换内容。
 *
 * 三种场景：
 * - mode='first'：输入服务器地址 → 生成配置码 → 显示配置码
 * - mode='join'：输入服务器地址 + 配置码 → 加入
 * - mode='showCode'：配对成功后显示配置码（由 first 流程转入，或外部直接打开）
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, RefreshCw, KeyRound, Copy, Check, AlertTriangle } from 'lucide-react';
import { useSyncStore } from '@/stores/syncStore';
import { useAnimatedClose } from '@/hooks/useAnimatedPresence';
import { OFFICIAL_SYNC_SERVER_URL } from '@/lib/constants';
import { validateNewAccountPassword } from '@/lib/syncPassword';
import { registerBackHandler } from './backHandler';

export type MobileSyncPairMode = 'first' | 'join' | 'showCode';

interface MobileSyncPairPageProps {
  open: boolean;
  /** 初始模式：'first' 设置新账户，'join' 加入已有账户，'showCode' 直接展示配置码 */
  initialMode: MobileSyncPairMode;
  /** initialMode='showCode' 时传入配置码；first 成功后内部生成 */
  initialCode?: string;
  onClose: () => void;
}

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500';

export default function MobileSyncPairPage({
  open,
  initialMode,
  initialCode,
  onClose,
}: MobileSyncPairPageProps) {
  const { pairFirst, pairJoin, actionLoading, error, clearError } = useSyncStore();
  const [serverSource, setServerSource] = useState<'official' | 'custom'>('official');
  const [customServerUrl, setCustomServerUrl] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountPasswordConfirm, setAccountPasswordConfirm] = useState('');
  const [localPasswordError, setLocalPasswordError] = useState<string | null>(null);
  const [mode, setMode] = useState<MobileSyncPairMode>(initialMode);
  const [generatedCode, setGeneratedCode] = useState<string | null>(initialCode ?? null);
  const [copied, setCopied] = useState(false);
  const { closing, requestClose, onAnimationEnd: onExitAnimationEnd } = useAnimatedClose(onClose);

  const resolvedServerUrl =
    serverSource === 'official' ? OFFICIAL_SYNC_SERVER_URL : customServerUrl.trim();

  // 每次打开时重置状态到 initialMode
  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setGeneratedCode(initialCode ?? null);
    setServerSource('official');
    setCustomServerUrl('');
    setJoinCode('');
    setAccountPassword('');
    setAccountPasswordConfirm('');
    setLocalPasswordError(null);
    setCopied(false);
  }, [open, initialMode, initialCode]);

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
      // error 已在 store
    }
  };

  const handlePairJoin = async () => {
    if (!resolvedServerUrl || !joinCode.trim()) return;
    setLocalPasswordError(null);
    try {
      await pairJoin(resolvedServerUrl, joinCode.trim(), accountPassword);
      // 加入成功 → 关闭页面
      requestClose();
    } catch {
      // error 已在 store
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

  // Android back gesture = header back button
  useEffect(() => {
    if (!open) return;
    // showCode 模式下，back 也直接关闭页面（配置码已显示，用户可选择稍后处理）
    return registerBackHandler(requestClose);
  }, [open, requestClose]);

  if (!open) return null;

  const title = mode === 'showCode'
    ? '配置码'
    : mode === 'first'
      ? '设置新账户'
      : '加入已有账户';

  return createPortal(
    <div
      onAnimationEnd={onExitAnimationEnd}
      className={`fixed inset-0 z-50 flex flex-col bg-zinc-950 ${
        closing ? 'mobile-fullscreen-exit' : 'mobile-fullscreen-enter'
      }`}
      data-region="mobile-sync-pair"
    >
      {/* Header */}
      <header
        className="flex flex-shrink-0 items-center gap-1 border-b border-zinc-800 px-1 py-2"
        style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top, 0px))' }}
      >
        <button
          type="button"
          onClick={requestClose}
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-zinc-300 active:bg-zinc-800"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100">
            {title}
          </div>
        </div>
      </header>

      {/* Error bar */}
      {error && (
        <div className="flex flex-shrink-0 items-start gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="ml-2 flex-shrink-0 text-red-400"
            aria-label="关闭错误"
          >
            ✕
          </button>
        </div>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {mode === 'showCode' && generatedCode ? (
          <div className="rounded-xl border border-amber-800 bg-amber-900/20 p-4">
            <div className="mb-3 flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-medium text-amber-200">
                配置码（必须手抄保存）
              </span>
            </div>
            <code className="mb-3 block break-all font-mono text-base tracking-wider text-amber-100">
              {generatedCode}
            </code>
            <button
              onClick={handleCopyCode}
              className="inline-flex items-center gap-1 text-xs text-amber-300 active:text-amber-200"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? '已复制' : '复制'}
            </button>
            <p className="mt-2 text-xs text-amber-500/70">
              丢失配置码将无法恢复账户。加入其他设备需要配置码与同一账户密码。
            </p>
            <button
              onClick={requestClose}
              className="mt-4 w-full rounded-lg bg-indigo-600 py-3 text-sm font-medium text-white active:bg-indigo-500"
            >
              我已保存
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <label className="mb-1.5 block text-xs text-zinc-400">同步服务器</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setServerSource('official')}
                  className={`flex-1 rounded-lg border py-2.5 text-sm ${
                    serverSource === 'official'
                      ? 'border-indigo-500 bg-indigo-600/20 text-indigo-200'
                      : 'border-zinc-700 bg-zinc-800 text-zinc-300'
                  }`}
                >
                  Marcel 官方服务器
                </button>
                <button
                  type="button"
                  onClick={() => setServerSource('custom')}
                  className={`flex-1 rounded-lg border py-2.5 text-sm ${
                    serverSource === 'custom'
                      ? 'border-indigo-500 bg-indigo-600/20 text-indigo-200'
                      : 'border-zinc-700 bg-zinc-800 text-zinc-300'
                  }`}
                >
                  自定义服务器地址
                </button>
              </div>
            </div>

            {serverSource === 'custom' && (
              <div>
                <label className="mb-1.5 block text-xs text-zinc-400">自定义服务器地址</label>
                <input
                  value={customServerUrl}
                  onChange={(e) => setCustomServerUrl(e.target.value)}
                  placeholder="https://sync.example.com"
                  className={inputClass}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="url"
                />
              </div>
            )}

            {mode === 'join' && (
              <div>
                <label className="mb-1.5 block text-xs text-zinc-400">配置码</label>
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="32 位配置码"
                  className={inputClass}
                  maxLength={32}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
            )}

            {mode === 'first' ? (
              <>
                <div>
                  <label className="mb-1.5 block text-xs text-zinc-400">账户密码（至少 8 位）</label>
                  <input
                    type="password"
                    value={accountPassword}
                    onChange={(e) => {
                      setAccountPassword(e.target.value);
                      setLocalPasswordError(null);
                    }}
                    placeholder="设置账户密码"
                    className={inputClass}
                    autoComplete="new-password"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs text-zinc-400">确认密码</label>
                  <input
                    type="password"
                    value={accountPasswordConfirm}
                    onChange={(e) => {
                      setAccountPasswordConfirm(e.target.value);
                      setLocalPasswordError(null);
                    }}
                    placeholder="再次输入密码"
                    className={inputClass}
                    autoComplete="new-password"
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="mb-1.5 block text-xs text-zinc-400">
                  账户密码（旧账户可留空）
                </label>
                <input
                  type="password"
                  value={accountPassword}
                  onChange={(e) => setAccountPassword(e.target.value)}
                  placeholder="账户密码"
                  className={inputClass}
                  autoComplete="current-password"
                />
              </div>
            )}

            {localPasswordError && (
              <p className="text-xs text-red-400">{localPasswordError}</p>
            )}

            <button
              onClick={mode === 'first' ? handlePairFirst : handlePairJoin}
              disabled={
                actionLoading ||
                !resolvedServerUrl ||
                (mode === 'join' && !joinCode.trim()) ||
                (mode === 'first' && !accountPassword)
              }
              className="w-full rounded-lg bg-indigo-600 py-3 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-50"
            >
              {actionLoading ? (
                <span className="inline-flex items-center gap-2">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  处理中…
                </span>
              ) : mode === 'first' ? (
                '生成配置码并注册'
              ) : (
                '加入账户'
              )}
            </button>

            {mode === 'first' && (
              <p className="px-1 text-xs text-zinc-500">
                注册成功后会生成 32 位配置码，请务必手抄保存。其他设备需配置码与同一账户密码加入。
              </p>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
