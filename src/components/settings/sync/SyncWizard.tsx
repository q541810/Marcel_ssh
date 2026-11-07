import { useEffect, useReducer, useRef } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useSyncStore } from '@/stores/syncStore';
import { getErrorMessage } from '@/lib/errors';
import {
  buildStorageConfig,
  buildStorageSecret,
  canSubmitWizard,
  canTestStorage,
  initialWizardState,
  isPlausibleRecoveryKey,
  normalizeRecoveryKey,
  wizardReducer,
  type JoinMethod,
  type WizardMode,
} from '@/lib/syncModel';
import { RecoveryKeyView } from './RecoveryKeyView';
import { StorageForm, TestResult } from './StorageForm';
import { Callout, SyncButton, SyncCheckbox, SyncChoice, SyncDialog, type SyncVariant } from './syncUi';

const JOIN_METHOD_OPTIONS = [
  { value: 'code', label: '同步码', desc: '从已开启同步的设备复制' },
  { value: 'manual', label: '手动输入', desc: '自己填存储位置和恢复密钥' },
] as const;

const inputClass =
  'w-full rounded-lg border border-edge-strong bg-field px-3 py-2 text-body text-fg placeholder:text-fg-tertiary focus:border-indigo-500 focus:outline-none disabled:opacity-50';

/**
 * 「开启同步」与「加入已有同步」的向导（桌面 Modal / 手机 Sheet 共用）。
 *
 * 开启：选存储 → 测试连接 → 开启 → **展示恢复密钥**（勾选"我已妥善保存"才能完成，这一步不可随手关掉）。
 * 加入：粘贴同步码，或手动填存储位置 + 恢复密钥。
 *
 * 状态机在 `lib/syncModel.ts`（纯函数，有单测）；这里只负责把动作接到后端命令上。
 * 恢复密钥 / 同步码只存在于本组件的局部状态，关闭向导即清空。
 */
export function SyncWizard({
  variant,
  mode,
  open,
  onClose,
  onFinished,
}: {
  variant: SyncVariant;
  mode: WizardMode;
  open: boolean;
  onClose: () => void;
  /** 开启 / 加入成功且用户走完最后一步后调用（用来在面板上提示一句"已开启"）。 */
  onFinished: (mode: WizardMode) => void;
}) {
  const [state, dispatch] = useReducer(wizardReducer, mode, initialWizardState);
  const testStorage = useSyncStore((s) => s.testStorage);
  const create = useSyncStore((s) => s.create);
  const join = useSyncStore((s) => s.join);
  const joinManual = useSyncStore((s) => s.joinManual);

  // 每次打开都从干净的表单开始（上次填过的密码 / 恢复密钥不该留着）。
  useEffect(() => {
    if (open) dispatch({ type: 'reset', mode });
  }, [open, mode]);

  // 关闭后稍等退场动画播完再清空：密码 / 恢复密钥 / 同步码不在内存里多留。
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => dispatch({ type: 'reset', mode }), 500);
    return () => clearTimeout(timer);
  }, [open, mode]);

  // 存储相关输入在测试期间变了，晚到的结果就不再适用。
  const signature = JSON.stringify([state.storageKind, state.webDav, state.sftp]);
  const signatureRef = useRef(signature);
  signatureRef.current = signature;

  const working = state.submit.status === 'working';
  const testing = state.test.status === 'testing';
  const showingKey = state.created !== null;
  const needsStorage = mode === 'create' || state.joinMethod === 'manual';

  const runTest = async () => {
    const storage = buildStorageConfig(state);
    if (!storage) return;
    const sigAtStart = signatureRef.current;
    dispatch({ type: 'testStart' });
    try {
      await testStorage(storage, buildStorageSecret(state));
      if (signatureRef.current === sigAtStart) dispatch({ type: 'testOk' });
    } catch (err) {
      if (signatureRef.current === sigAtStart) dispatch({ type: 'testFail', message: getErrorMessage(err) });
    }
  };

  const runSubmit = async () => {
    if (!canSubmitWizard(state)) return;
    dispatch({ type: 'submitStart' });
    try {
      if (mode === 'create') {
        const storage = buildStorageConfig(state);
        if (!storage) return;
        const result = await create(storage, buildStorageSecret(state));
        dispatch({ type: 'created', recoveryKey: result.recoveryKey, syncCode: result.syncCode });
        return;
      }
      if (state.joinMethod === 'code') {
        await join(state.syncCodeInput.trim());
      } else {
        const storage = buildStorageConfig(state);
        if (!storage) return;
        await joinManual(storage, buildStorageSecret(state), normalizeRecoveryKey(state.recoveryKeyInput));
      }
      onFinished('join');
      onClose();
    } catch (err) {
      dispatch({ type: 'submitFail', message: getErrorMessage(err) });
    }
  };

  const finishCreate = () => {
    onFinished('create');
    onClose();
  };

  // ───── 第二步：展示恢复密钥 ─────
  if (showingKey && state.created) {
    return (
      <SyncDialog
        variant={variant}
        open={open}
        onClose={() => {}}
        title="同步已开启，请保存恢复密钥"
        dismissible={false}
        footer={
          <SyncButton variant={variant} kind="primary" disabled={!state.acknowledged} onClick={finishCreate}>
            完成
          </SyncButton>
        }
      >
        <div className="flex items-start gap-3 text-body text-fg-secondary">
          <ShieldCheck className="mt-1 h-4 w-4 flex-shrink-0 text-emerald-400" aria-hidden />
          <p className="leading-relaxed">
            数据已经加密，这把恢复密钥是唯一能解开它们的钥匙。抄在纸上、或存进密码管理器都行。
          </p>
        </div>
        <RecoveryKeyView variant={variant} recoveryKey={state.created.recoveryKey} />
        <Callout tone="warn">
          恢复密钥等同于钥匙，请别发给别人。弄丢了也不用慌：这台设备上的数据不受影响，只是以后在新设备上无法解开云端的数据；
          你可以随时在「设置 → 同步」里再次查看它。
        </Callout>
        <SyncCheckbox
          variant={variant}
          checked={state.acknowledged}
          onChange={(value) => dispatch({ type: 'acknowledge', value })}
        >
          我已妥善保存恢复密钥
        </SyncCheckbox>
      </SyncDialog>
    );
  }

  // ───── 第一步：填写 ─────
  const title = mode === 'create' ? '开启跨设备同步' : '加入已有同步';
  const submitLabel = mode === 'create' ? '开启同步' : '加入';

  return (
    <SyncDialog
      variant={variant}
      open={open}
      onClose={onClose}
      title={title}
      dismissible={!working}
      footer={
        <>
          <SyncButton variant={variant} kind="ghost" onClick={onClose} disabled={working}>
            取消
          </SyncButton>
          {needsStorage && (
            <SyncButton
              variant={variant}
              kind="secondary"
              onClick={() => void runTest()}
              disabled={!canTestStorage(state) || testing || working}
              loading={testing}
            >
              测试连接
            </SyncButton>
          )}
          <SyncButton
            variant={variant}
            kind="primary"
            onClick={() => void runSubmit()}
            disabled={!canSubmitWizard(state)}
            loading={working}
          >
            {submitLabel}
          </SyncButton>
        </>
      }
    >
      {mode === 'create' ? (
        <Callout>
          端到端加密：数据在你的设备上加密之后才上传，存储方只看得到一堆看不懂的密文。
          数据存在你自己选的位置，没有我们的服务器。
        </Callout>
      ) : (
        <Callout>
          加入后，这台设备上已有的数据会和云端合并：两边内容冲突时以云端为准；
          这台设备独有的连接、技能等会保留，并同步给其它设备。
        </Callout>
      )}

      {mode === 'join' && (
        <SyncChoice<JoinMethod>
          variant={variant}
          options={JOIN_METHOD_OPTIONS}
          value={state.joinMethod}
          onChange={(method) => dispatch({ type: 'setJoinMethod', method })}
          ariaLabel="加入方式"
          disabled={working}
        />
      )}

      {mode === 'join' && state.joinMethod === 'code' && (
        <div>
          <label className="mb-1 block text-body font-medium text-fg-secondary" htmlFor="sync-code-input">
            同步码
          </label>
          <textarea
            id="sync-code-input"
            value={state.syncCodeInput}
            onChange={(e) => dispatch({ type: 'setSyncCode', value: e.target.value })}
            rows={4}
            placeholder="MSYNC1-…"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={working}
            className={`${inputClass} resize-none break-all font-mono text-meta`}
          />
          <p className="mt-1 text-meta leading-relaxed text-fg-tertiary">
            在已开启同步的设备上打开「设置 → 同步 → 添加设备」就能看到同步码。桌面端还有二维码：
            用手机相机扫一下，把扫出来的文字粘贴到这里即可。
          </p>
          <p className="mt-1 text-meta leading-relaxed text-amber-400/90">
            同步码里带着解锁数据的钥匙，别发给不信任的人。
          </p>
        </div>
      )}

      {needsStorage && (
        <>
          <StorageForm variant={variant} state={state} dispatch={dispatch} disabled={working} />
          <TestResult state={state.test} />
        </>
      )}

      {mode === 'join' && state.joinMethod === 'manual' && (
        <div>
          <label className="mb-1 block text-body font-medium text-fg-secondary" htmlFor="sync-recovery-input">
            恢复密钥
          </label>
          <input
            id="sync-recovery-input"
            value={state.recoveryKeyInput}
            onChange={(e) => dispatch({ type: 'setRecoveryKey', value: e.target.value })}
            placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={working}
            className={`${inputClass} font-mono`}
          />
          {state.recoveryKeyInput.trim().length > 0 && !isPlausibleRecoveryKey(state.recoveryKeyInput) ? (
            <p className="mt-1 text-meta text-amber-400/90">
              恢复密钥是 32 位字母和数字（4 个一组，用「-」分开）；这里的输入还不完整，或者有抄错的字符。
            </p>
          ) : (
            <p className="mt-1 text-meta text-fg-tertiary">忽略大小写、空格和「-」。</p>
          )}
        </div>
      )}

      {working && (
        <p className="text-meta text-fg-secondary" aria-live="polite">
          {mode === 'create' ? '正在创建加密空间…' : '正在加入并合并数据，数据多的话要花一会儿…'}
        </p>
      )}
      {state.submit.status === 'failed' && state.submit.message && (
        <Callout tone="error">{state.submit.message}</Callout>
      )}
    </SyncDialog>
  );
}
