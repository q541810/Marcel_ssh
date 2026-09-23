import { useEffect, useState, type ReactNode } from 'react';
import type { JumpAuthMethod, SavedConnection, StoredKeyMeta } from '@/lib/types';
import { DEFAULT_PORT } from '@/lib/constants';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import { describeAlgorithm, shortFingerprint } from '@/lib/privateKey';
import { useConnectionStore } from '@/stores/connectionStore';
import KeyManager from '@/components/connection/KeyManager';
import MobileSheet from './ui/MobileSheet';

interface MobileConnectionFormProps {
  open: boolean;
  /** Existing connection when editing; undefined when creating. */
  connection?: SavedConnection;
  onSave: (connection: SavedConnection) => Promise<void> | void;
  onCancel: () => void;
  /**
   * 密钥链写入失败的出路。
   *
   * 浮层保存后**立刻关闭**，自己那条提示活不到用户看见；所以失败要说给外面的既有
   * 报错面（连接列表那条红条）。密钥链不可用不拦保存——连接本身照样存下来。
   */
  onSecretSaveError: (message: string) => void;
}

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500';
const inputErrorClass =
  'w-full rounded-lg border border-red-500 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-red-400';

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs text-zinc-400">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

/**
 * 密钥链写入失败的提示文案。
 *
 * 只说这件事本身——不回显、不记录任何凭据（错误文案来自后端密钥链，只有系统层面的
 * 原因）。同一条提示在连接列表与连接表单里各有一份（桌面/移动共四处），改口径要
 * 一起改。
 */
function secretSaveFailedMessage(what: string, err: unknown): string {
  return `${what}没能保存到本设备（${getErrorMessage(err)}）。下次连接和「重连」还得再输一次。`;
}

/**
 * Mobile create / edit form for a saved SSH connection.
 * Field model mirrors the desktop ConnectionForm (name/host/port/username/
 * auth/group + ProxyJump). Secrets go to the OS keychain via Rust-side IPC.
 */
export default function MobileConnectionForm({
  open,
  connection,
  onSave,
  onCancel,
  onSecretSaveError,
}: MobileConnectionFormProps) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(DEFAULT_PORT);
  const [username, setUsername] = useState('');
  const [authMethod, setAuthMethod] = useState('Password');
  const [keyPath, setKeyPath] = useState('');
  const [keyId, setKeyId] = useState('');
  const [keys, setKeys] = useState<StoredKeyMeta[]>([]);
  const [keyManagerTarget, setKeyManagerTarget] = useState<'main' | 'jump' | null>(
    null,
  );
  /** 本地已存了主凭证（密码或密钥密码）——用于"已保存 / 修改 / 清除"的呈现 */
  const [hasSecret, setHasSecret] = useState(false);
  const [secretDirty, setSecretDirty] = useState(false);
  const [group, setGroup] = useState('');
  /** Optional main credential (password or key passphrase) saved to keychain. */
  const [secret, setSecret] = useState('');
  /**
   * 登录密码：私钥连接也能存（供 agent 执行 sudo 时自动填给远端）。
   * 它不用来登录本连接 —— 见桌面 ConnectionForm 里同一字段的说明。
   */
  const [loginPassword, setLoginPassword] = useState('');
  const [hasLoginPassword, setHasLoginPassword] = useState(false);
  const [loginPasswordDirty, setLoginPasswordDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Jump host
  const [useJump, setUseJump] = useState(false);
  const [jumpHost, setJumpHost] = useState('');
  const [jumpPort, setJumpPort] = useState(DEFAULT_PORT);
  const [jumpUsername, setJumpUsername] = useState('');
  const [jumpAuthMethod, setJumpAuthMethod] =
    useState<JumpAuthMethod>('withTarget');
  const [jumpKeyPath, setJumpKeyPath] = useState('');
  const [jumpKeyId, setJumpKeyId] = useState('');
  const [jumpPassword, setJumpPassword] = useState('');
  const [jumpPassphrase, setJumpPassphrase] = useState('');
  const [hasJumpPassword, setHasJumpPassword] = useState(false);
  const [hasJumpPassphrase, setHasJumpPassphrase] = useState(false);

  const connections = useConnectionStore((s) => s.connections);

  // Re-init form state each time the sheet opens (create vs edit).
  useEffect(() => {
    if (!open) return;
    setName(connection?.name ?? '');
    setHost(connection?.host ?? '');
    setPort(connection?.port ?? DEFAULT_PORT);
    setUsername(connection?.username ?? '');
    setAuthMethod(connection?.authMethod ?? 'Password');
    setKeyPath(connection?.keyPath ?? '');
    setKeyId(connection?.keyId ?? '');
    setGroup(connection?.group ?? '');
    setSecret('');
    setHasSecret(false);
    setSecretDirty(false);
    setLoginPassword('');
    setHasLoginPassword(false);
    setLoginPasswordDirty(false);
    setErrors({});
    setSaving(false);
    setUseJump(connection?.useJump ?? false);
    setJumpHost(connection?.jumpHost ?? '');
    setJumpPort(connection?.jumpPort ?? DEFAULT_PORT);
    setJumpUsername(connection?.jumpUsername ?? '');
    setJumpAuthMethod(connection?.jumpAuthMethod ?? 'withTarget');
    setJumpKeyPath(connection?.jumpKeyPath ?? '');
    setJumpKeyId(connection?.jumpKeyId ?? '');
    setJumpPassword('');
    setJumpPassphrase('');
    setHasJumpPassword(false);
    setHasJumpPassphrase(false);
  }, [open, connection]);

  // 密钥库列表：进入表单时载入；密钥库浮层关闭后重载（期间可能刚导入或删过）
  useEffect(() => {
    if (!open || keyManagerTarget !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await tauri.listKeys();
        if (!cancelled) setKeys(list);
      } catch {
        /* 私钥库读取失败不该挡住表单 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, keyManagerTarget]);

  // 主凭证是否已保存（编辑模式才问得出来）。
  // **依赖当前选择的认证方式，而不是保存时那个**：下面那一行的可见性来自
  // hasSecret，标签与「清除」删的账号来自 authMethod——三者必须同源，否则把私钥
  // 连接改成密码认证后，会沿用「密钥密码已存」这一可见性、显示成「密码 / 已保存
  // 在本设备」、点清除却删掉 {id}（那条是本次改动新引入的 sudo 登录密码）。
  useEffect(() => {
    if (!open || !connection?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const isPassword = authMethod === 'Password';
        const [has, hasLogin] = await Promise.all([
          isPassword
            ? tauri.hasPassword(connection.id)
            : tauri.hasPassphrase(connection.id),
          // 私钥连接下这个账号只服务 sudo 自动填充（用私钥登录用不到它）
          isPassword ? Promise.resolve(false) : tauri.hasPassword(connection.id),
        ]);
        if (!cancelled) {
          setHasSecret(has);
          setHasLoginPassword(hasLogin);
        }
      } catch {
        /* keychain optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, connection, authMethod]);

  // Check saved jump credentials when editing a jump-enabled connection.
  useEffect(() => {
    if (!open || !connection?.id || !connection.useJump) return;
    let cancelled = false;
    void (async () => {
      try {
        const [pw, pp] = await Promise.all([
          tauri.hasJumpPassword(connection.id),
          tauri.hasJumpPassphrase(connection.id),
        ]);
        if (!cancelled) {
          setHasJumpPassword(pw);
          setHasJumpPassphrase(pp);
        }
      } catch {
        /* keychain optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, connection]);

  const buildSaved = (): SavedConnection => ({
    id: connection?.id ?? crypto.randomUUID(),
    name: name.trim(),
    host: host.trim(),
    port,
    username: username.trim(),
    authMethod,
    // 选了密钥库里的私钥就不再记路径；反之保留手填路径（老数据与高级用法）
    keyPath: authMethod === 'PrivateKey' && !keyId ? keyPath.trim() : undefined,
    keyId: authMethod === 'PrivateKey' ? keyId || undefined : undefined,
    group: group.trim() || undefined,
    lastConnected: connection?.lastConnected,
    useJump,
    jumpHost: useJump ? jumpHost.trim() : undefined,
    jumpPort: useJump ? jumpPort : undefined,
    jumpUsername: useJump ? jumpUsername.trim() : undefined,
    jumpAuthMethod: useJump ? jumpAuthMethod : undefined,
    jumpKeyPath:
      useJump && jumpAuthMethod === 'PrivateKey' && !jumpKeyId
        ? jumpKeyPath.trim()
        : undefined,
    jumpKeyId:
      useJump && jumpAuthMethod === 'PrivateKey'
        ? jumpKeyId || undefined
        : undefined,
  });

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = '名称为必填项';
    if (!host.trim()) next.host = '主机为必填项';
    if (!username.trim()) next.username = '用户名为必填项';
    if (port < 1 || port > 65535) next.port = '端口必须在 1-65535 之间';
    if (authMethod === 'PrivateKey' && !keyId && !keyPath.trim()) {
      next.keyPath = '请选择或导入一把私钥';
    }
    if (useJump) {
      if (!jumpHost.trim()) next.jumpHost = '跳板机主机为必填项';
      if (!jumpUsername.trim()) next.jumpUsername = '跳板机用户名为必填项';
      if (jumpPort < 1 || jumpPort > 65535)
        next.jumpPort = '端口必须在 1-65535 之间';
      if (jumpAuthMethod === 'PrivateKey' && !jumpKeyId && !jumpKeyPath.trim()) {
        next.jumpKeyPath = '请选择或导入跳板机的私钥';
      }
      if (jumpAuthMethod === 'Password' && !jumpPassword && !hasJumpPassword) {
        next.jumpPassword = '请填写跳板机密码';
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  /** 有几条连接在用这把私钥（含作为跳板机私钥），删除前要提醒清楚。 */
  const keyUsage = (id: string) =>
    connections.filter(
      (c) => c.keyId === id || (c.useJump && c.jumpKeyId === id),
    ).length;

  /** Persist secrets to keychain (best-effort, same semantics as desktop). */
  const persistSecrets = async (id: string) => {
    if (secret) {
      if (authMethod === 'Password') {
        await tauri.savePassword(id, secret);
      } else if (authMethod === 'PrivateKey') {
        await tauri.savePassphrase(id, secret);
      }
    }
    // 登录密码：私钥连接下它只服务 agent 的 sudo 自动填充。与密钥密码是两个
    // 密钥链账号（`{id}` vs `pk:{id}`），写串了会让 sudo 静默失效。
    if (authMethod === 'PrivateKey' && loginPassword) {
      await tauri.savePassword(id, loginPassword);
    }
    if (!useJump) {
      // Best-effort cleanup when jump is turned off on an existing connection
      if (connection?.id) {
        await Promise.allSettled([
          tauri.deleteJumpPassword(id),
          tauri.deleteJumpPassphrase(id),
        ]);
      }
      return;
    }
    if (jumpAuthMethod === 'Password' && jumpPassword) {
      await tauri.saveJumpPassword(id, jumpPassword);
    } else if (jumpAuthMethod === 'PrivateKey' && jumpPassphrase) {
      await tauri.saveJumpPassphrase(id, jumpPassphrase);
    }
  };

  const handleSave = async () => {
    if (!validate()) return;
    const saved = buildSaved();
    setSaving(true);
    let secretWarning: string | null = null;
    try {
      try {
        await persistSecrets(saved.id);
      } catch (err) {
        console.warn('保存凭证失败:', err);
        // 凭证没进密钥链这件事必须让用户知道（否则他以为已经记住了，下次又得输）。
        // 连接本身照存——这是既有的取舍：密钥链不可用不该挡着保存/连接。
        secretWarning = secretSaveFailedMessage('凭证', err);
      }
      await onSave(saved);
    } finally {
      setSaving(false);
    }
    // 报给宿主放在 onSave **之后**：宿主可能在自己的 onSave 里清错误（连接列表就是），
    // 先说再清等于没说。
    if (secretWarning) onSecretSaveError(secretWarning);
  };

  const secretLabel =
    authMethod === 'Password' ? '密码（可选）' : '密钥密码（可选）';
  const secretPlaceholder = connection?.id
    ? '留空则保持不变'
    : '留空则连接时输入';
  const selectedKey = keys.find((k) => k.id === keyId);
  const selectedJumpKey = keys.find((k) => k.id === jumpKeyId);

  return (
    <MobileSheet
      open={open}
      onClose={onCancel}
      title={connection ? '编辑连接' : '新建连接'}
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300 active:bg-zinc-700"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-40"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      }
    >
      <div className="space-y-3 px-4 pb-3">
        <Field label="名称" error={errors.name}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="我的服务器"
            className={errors.name ? inputErrorClass : inputClass}
          />
        </Field>

        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2">
            <Field label="主机" error={errors.host}>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className={errors.host ? inputErrorClass : inputClass}
              />
            </Field>
          </div>
          <Field label="端口" error={errors.port}>
            <input
              type="number"
              inputMode="numeric"
              value={String(port)}
              onChange={(e) =>
                setPort(parseInt(e.target.value, 10) || DEFAULT_PORT)
              }
              className={errors.port ? inputErrorClass : inputClass}
            />
          </Field>
        </div>

        <Field label="用户名" error={errors.username}>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="root"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={errors.username ? inputErrorClass : inputClass}
          />
        </Field>

        <Field label="认证方式">
          <select
            value={authMethod}
            onChange={(e) => {
              const next = e.target.value;
              setAuthMethod(next);
              setSecret('');
              setSecretDirty(false);
              // 旧值属于旧账号，先撤下（避免重取回来之前那一行还挂着「清除」），
              // 再由上面的 effect 按新的认证方式重取。
              setHasSecret(false);
            }}
            className={inputClass}
          >
            <option value="Password">密码</option>
            <option value="PrivateKey">私钥</option>
          </select>
        </Field>

        {authMethod === 'PrivateKey' && (
          <>
            <Field label="私钥">
              <div className="flex gap-2">
                <select
                  value={keyId}
                  onChange={(e) => {
                    setKeyId(e.target.value);
                    if (e.target.value) setKeyPath('');
                  }}
                  className={`min-w-0 flex-1 ${inputClass}`}
                >
                  <option value="">
                    {keys.length > 0 ? '未选择' : '还没有导入私钥'}
                  </option>
                  {keys.map((key) => (
                    <option key={key.id} value={key.id}>
                      {key.name}（{describeAlgorithm(key.algorithm)}
                      {key.encrypted ? ' · 带密码' : ''}）
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setKeyManagerTarget('main')}
                  className="shrink-0 rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 active:bg-zinc-700"
                >
                  选择 / 导入…
                </button>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                {selectedKey
                  ? `${describeAlgorithm(selectedKey.algorithm)} · ${shortFingerprint(selectedKey.fingerprint)}`
                  : '从手机里挑一个密钥文件，或直接粘贴私钥内容。'}
              </p>
            </Field>

            {!keyId && (
              <Field label="私钥路径（高级）" error={errors.keyPath}>
                <input
                  type="text"
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_rsa"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className={errors.keyPath ? inputErrorClass : inputClass}
                />
              </Field>
            )}
          </>
        )}

        {hasSecret && !secretDirty && !secret ? (
          <Field label={authMethod === 'Password' ? '密码' : '密钥密码'}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-zinc-400">已保存在本设备</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSecretDirty(true)}
                  className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 active:bg-zinc-700"
                >
                  修改
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void (async () => {
                      if (!connection?.id) return;
                      try {
                        if (authMethod === 'Password') {
                          await tauri.deletePassword(connection.id);
                        } else {
                          await tauri.deletePassphrase(connection.id);
                        }
                        setHasSecret(false);
                        setSecret('');
                        setSecretDirty(false);
                      } catch {
                        /* keychain optional */
                      }
                    })()
                  }
                  className="rounded-lg px-3 py-2 text-xs text-red-400/80 active:bg-zinc-800"
                >
                  清除
                </button>
              </div>
            </div>
          </Field>
        ) : (
          <Field label={secretLabel}>
            <input
              type="password"
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                setSecretDirty(true);
              }}
              placeholder={secretPlaceholder}
              autoComplete="new-password"
              className={inputClass}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
              填写后加密保存到本设备，连接时自动使用。
            </p>
          </Field>
        )}

        {/* 登录密码：与登录无关，只给 agent 执行 sudo 时自动填给远端 */}
        {authMethod === 'PrivateKey' &&
          (hasLoginPassword && !loginPasswordDirty && !loginPassword ? (
            <Field label="登录密码">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-zinc-400">已保存在本设备</span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setLoginPasswordDirty(true)}
                    className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 active:bg-zinc-700"
                  >
                    修改
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void (async () => {
                        if (!connection?.id) return;
                        try {
                          await tauri.deletePassword(connection.id);
                          setHasLoginPassword(false);
                          setLoginPassword('');
                          setLoginPasswordDirty(false);
                        } catch {
                          /* keychain optional */
                        }
                      })()
                    }
                    className="rounded-lg px-3 py-2 text-xs text-red-400/80 active:bg-zinc-800"
                  >
                    清除
                  </button>
                </div>
              </div>
            </Field>
          ) : (
            <Field label="登录密码（可选）">
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => {
                  setLoginPassword(e.target.value);
                  setLoginPasswordDirty(true);
                }}
                placeholder="留空则不自动填充"
                autoComplete="new-password"
                className={inputClass}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                本连接用私钥登录，用不到它。填了之后 agent 执行 sudo
                时会自动填给远端。
              </p>
            </Field>
          ))}

        <Field label="分组（可选）">
          <input
            type="text"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="生产环境"
            className={inputClass}
          />
        </Field>

        {/* Jump host (ProxyJump) */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
          <button
            type="button"
            onClick={() => setUseJump((v) => !v)}
            className="flex w-full items-center justify-between rounded-xl px-3 py-3 text-sm text-zinc-300 active:bg-zinc-800/50"
          >
            <span className="font-medium">跳板机（可选）</span>
            <span
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                useJump ? 'bg-indigo-600' : 'bg-zinc-700'
              }`}
              role="switch"
              aria-checked={useJump}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  useJump ? 'translate-x-[18px]' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>

          {useJump && (
            <div className="space-y-3 border-t border-zinc-800 px-3 pb-3 pt-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <Field label="主机" error={errors.jumpHost}>
                    <input
                      type="text"
                      value={jumpHost}
                      onChange={(e) => setJumpHost(e.target.value)}
                      placeholder="bastion.example.com"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className={errors.jumpHost ? inputErrorClass : inputClass}
                    />
                  </Field>
                </div>
                <Field label="端口" error={errors.jumpPort}>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={String(jumpPort)}
                    onChange={(e) =>
                      setJumpPort(parseInt(e.target.value, 10) || DEFAULT_PORT)
                    }
                    className={errors.jumpPort ? inputErrorClass : inputClass}
                  />
                </Field>
              </div>

              <Field label="用户名" error={errors.jumpUsername}>
                <input
                  type="text"
                  value={jumpUsername}
                  onChange={(e) => setJumpUsername(e.target.value)}
                  placeholder="jumpuser"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className={
                    errors.jumpUsername ? inputErrorClass : inputClass
                  }
                />
              </Field>

              <Field label="认证方式">
                <select
                  value={jumpAuthMethod}
                  onChange={(e) => {
                    setJumpAuthMethod(e.target.value as JumpAuthMethod);
                    setJumpPassword('');
                    setJumpPassphrase('');
                  }}
                  className={inputClass}
                >
                  <option value="withTarget">和目标相同</option>
                  <option value="Password">密码</option>
                  <option value="PrivateKey">私钥</option>
                </select>
              </Field>

              {jumpAuthMethod === 'Password' && (
                <Field
                  label={hasJumpPassword ? '密码（已设置）' : '密码'}
                  error={errors.jumpPassword}
                >
                  <input
                    type="password"
                    value={jumpPassword}
                    onChange={(e) => setJumpPassword(e.target.value)}
                    placeholder={
                      hasJumpPassword ? '留空则保持不变' : '跳板机密码'
                    }
                    autoComplete="new-password"
                    className={
                      errors.jumpPassword ? inputErrorClass : inputClass
                    }
                  />
                </Field>
              )}

              {jumpAuthMethod === 'PrivateKey' && (
                <>
                  <Field label="私钥">
                    <div className="flex gap-2">
                      <select
                        value={jumpKeyId}
                        onChange={(e) => {
                          setJumpKeyId(e.target.value);
                          if (e.target.value) setJumpKeyPath('');
                        }}
                        className={`min-w-0 flex-1 ${inputClass}`}
                      >
                        <option value="">
                          {keys.length > 0 ? '未选择' : '还没有导入私钥'}
                        </option>
                        {keys.map((key) => (
                          <option key={key.id} value={key.id}>
                            {key.name}（{describeAlgorithm(key.algorithm)}）
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setKeyManagerTarget('jump')}
                        className="shrink-0 rounded-lg bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 active:bg-zinc-700"
                      >
                        选择 / 导入…
                      </button>
                    </div>
                    {selectedJumpKey && (
                      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                        {describeAlgorithm(selectedJumpKey.algorithm)} ·{' '}
                        {shortFingerprint(selectedJumpKey.fingerprint)}
                      </p>
                    )}
                  </Field>

                  {!jumpKeyId && (
                    <Field label="私钥路径（高级）" error={errors.jumpKeyPath}>
                      <input
                        type="text"
                        value={jumpKeyPath}
                        onChange={(e) => setJumpKeyPath(e.target.value)}
                        placeholder="~/.ssh/id_rsa"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className={
                          errors.jumpKeyPath ? inputErrorClass : inputClass
                        }
                      />
                    </Field>
                  )}
                  <Field
                    label={
                      hasJumpPassphrase
                        ? '密钥密码（已设置）'
                        : '密钥密码（可选）'
                    }
                  >
                    <input
                      type="password"
                      value={jumpPassphrase}
                      onChange={(e) => setJumpPassphrase(e.target.value)}
                      placeholder={
                        hasJumpPassphrase ? '留空则保持不变' : '私钥 passphrase'
                      }
                      autoComplete="new-password"
                      className={inputClass}
                    />
                  </Field>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 私钥库：选文件 / 粘贴内容 / 重命名 / 删除都在同一个界面里。
          浮层叠在表单之上，返回键由 MobileSheet 自己接管，先关它再关表单。 */}
      <MobileSheet
        open={keyManagerTarget !== null}
        onClose={() => setKeyManagerTarget(null)}
        title="私钥"
      >
        <KeyManager
          variant="mobile"
          selectedId={keyManagerTarget === 'jump' ? jumpKeyId : keyId}
          onSelect={(id) => {
            if (keyManagerTarget === 'jump') {
              setJumpKeyId(id ?? '');
              if (id) setJumpKeyPath('');
            } else {
              setKeyId(id ?? '');
              if (id) setKeyPath('');
            }
          }}
          usageOf={keyUsage}
        />
      </MobileSheet>
    </MobileSheet>
  );
}
