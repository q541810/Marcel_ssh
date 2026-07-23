import { useEffect, useState, type ReactNode } from 'react';
import type { JumpAuthMethod, SavedConnection } from '@/lib/types';
import { DEFAULT_PORT } from '@/lib/constants';
import * as tauri from '@/lib/tauri';
import MobileSheet from './ui/MobileSheet';

interface MobileConnectionFormProps {
  open: boolean;
  /** Existing connection when editing; undefined when creating. */
  connection?: SavedConnection;
  onSave: (connection: SavedConnection) => Promise<void> | void;
  onCancel: () => void;
}

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-green-500';
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
 * Mobile create / edit form for a saved SSH connection.
 * Field model mirrors the desktop ConnectionForm (name/host/port/username/
 * auth/group + ProxyJump). Secrets go to the OS keychain via Rust-side IPC.
 */
export default function MobileConnectionForm({
  open,
  connection,
  onSave,
  onCancel,
}: MobileConnectionFormProps) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(DEFAULT_PORT);
  const [username, setUsername] = useState('');
  const [authMethod, setAuthMethod] = useState('Password');
  const [keyPath, setKeyPath] = useState('');
  const [group, setGroup] = useState('');
  /** Optional main credential (password or key passphrase) saved to keychain. */
  const [secret, setSecret] = useState('');
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
  const [jumpPassword, setJumpPassword] = useState('');
  const [jumpPassphrase, setJumpPassphrase] = useState('');
  const [hasJumpPassword, setHasJumpPassword] = useState(false);
  const [hasJumpPassphrase, setHasJumpPassphrase] = useState(false);

  // Re-init form state each time the sheet opens (create vs edit).
  useEffect(() => {
    if (!open) return;
    setName(connection?.name ?? '');
    setHost(connection?.host ?? '');
    setPort(connection?.port ?? DEFAULT_PORT);
    setUsername(connection?.username ?? '');
    setAuthMethod(connection?.authMethod ?? 'Password');
    setKeyPath(connection?.keyPath ?? '');
    setGroup(connection?.group ?? '');
    setSecret('');
    setErrors({});
    setSaving(false);
    setUseJump(connection?.useJump ?? false);
    setJumpHost(connection?.jumpHost ?? '');
    setJumpPort(connection?.jumpPort ?? DEFAULT_PORT);
    setJumpUsername(connection?.jumpUsername ?? '');
    setJumpAuthMethod(connection?.jumpAuthMethod ?? 'withTarget');
    setJumpKeyPath(connection?.jumpKeyPath ?? '');
    setJumpPassword('');
    setJumpPassphrase('');
    setHasJumpPassword(false);
    setHasJumpPassphrase(false);
  }, [open, connection]);

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
    keyPath: authMethod === 'PrivateKey' ? keyPath.trim() : undefined,
    group: group.trim() || undefined,
    lastConnected: connection?.lastConnected,
    useJump,
    jumpHost: useJump ? jumpHost.trim() : undefined,
    jumpPort: useJump ? jumpPort : undefined,
    jumpUsername: useJump ? jumpUsername.trim() : undefined,
    jumpAuthMethod: useJump ? jumpAuthMethod : undefined,
    jumpKeyPath:
      useJump && jumpAuthMethod === 'PrivateKey'
        ? jumpKeyPath.trim()
        : undefined,
  });

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = '名称为必填项';
    if (!host.trim()) next.host = '主机为必填项';
    if (!username.trim()) next.username = '用户名为必填项';
    if (port < 1 || port > 65535) next.port = '端口必须在 1-65535 之间';
    if (authMethod === 'PrivateKey' && !keyPath.trim()) {
      next.keyPath = '私钥认证需要密钥路径';
    }
    if (useJump) {
      if (!jumpHost.trim()) next.jumpHost = '跳板机主机为必填项';
      if (!jumpUsername.trim()) next.jumpUsername = '跳板机用户名为必填项';
      if (jumpPort < 1 || jumpPort > 65535)
        next.jumpPort = '端口必须在 1-65535 之间';
      if (jumpAuthMethod === 'PrivateKey' && !jumpKeyPath.trim()) {
        next.jumpKeyPath = '跳板机私钥路径为必填项';
      }
      if (jumpAuthMethod === 'Password' && !jumpPassword && !hasJumpPassword) {
        next.jumpPassword = '请填写跳板机密码';
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  /** Persist secrets to keychain (best-effort, same semantics as desktop). */
  const persistSecrets = async (id: string) => {
    if (secret) {
      if (authMethod === 'Password') {
        await tauri.savePassword(id, secret);
      } else if (authMethod === 'PrivateKey') {
        await tauri.savePassphrase(id, secret);
      }
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
    try {
      try {
        await persistSecrets(saved.id);
      } catch {
        /* keychain optional; connection itself still saves */
      }
      await onSave(saved);
    } finally {
      setSaving(false);
    }
  };

  const secretLabel =
    authMethod === 'Password' ? '密码（可选）' : '密钥密码（可选）';
  const secretPlaceholder = connection?.id
    ? '留空则保持不变'
    : '留空则连接时输入';

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
            className="flex-1 rounded-xl bg-green-600 px-4 py-3 text-sm font-medium text-white active:bg-green-500 disabled:opacity-40"
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
              setAuthMethod(e.target.value);
              setSecret('');
            }}
            className={inputClass}
          >
            <option value="Password">密码</option>
            <option value="PrivateKey">私钥</option>
          </select>
        </Field>

        {authMethod === 'PrivateKey' && (
          <Field label="私钥路径" error={errors.keyPath}>
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

        <Field label={secretLabel}>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={secretPlaceholder}
            autoComplete="new-password"
            className={inputClass}
          />
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
            填写后加密保存到本设备，连接时自动使用。
          </p>
        </Field>

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
                useJump ? 'bg-green-600' : 'bg-zinc-700'
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
                  <Field label="私钥路径" error={errors.jumpKeyPath}>
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
    </MobileSheet>
  );
}
