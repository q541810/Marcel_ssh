import { useEffect, useState } from 'react';
import type { JumpAuthMethod, SavedConnection, StoredKeyMeta } from '@/lib/types';
import { DEFAULT_PORT } from '@/lib/constants';
import * as tauri from '@/lib/tauri';
import { describeAlgorithm, shortFingerprint } from '@/lib/privateKey';
import { useConnectionStore } from '@/stores/connectionStore';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import PasswordPrompt from './PasswordPrompt';
import KeyManager from './KeyManager';

interface Props {
  connection?: SavedConnection;
  onSave: (connection: SavedConnection) => void;
  onCancel: () => void;
  onTestConnection?: (connection: SavedConnection) => void;
}

export default function ConnectionForm({
  connection,
  onSave,
  onCancel,
  onTestConnection,
}: Props) {
  const [name, setName] = useState(connection?.name ?? '');
  const [host, setHost] = useState(connection?.host ?? '');
  const [port, setPort] = useState(connection?.port ?? DEFAULT_PORT);
  const [username, setUsername] = useState(connection?.username ?? '');
  const [authMethod, setAuthMethod] = useState(connection?.authMethod ?? 'Password');
  const [keyPath, setKeyPath] = useState(connection?.keyPath ?? '');
  const [keyId, setKeyId] = useState(connection?.keyId ?? '');
  const [passphrase, setPassphrase] = useState('');
  const [hasPassphrase, setHasPassphrase] = useState(false);
  const [passphraseDirty, setPassphraseDirty] = useState(false);
  const [keys, setKeys] = useState<StoredKeyMeta[]>([]);
  const [keyManagerTarget, setKeyManagerTarget] = useState<'main' | 'jump' | null>(
    null,
  );
  const [group, setGroup] = useState(connection?.group ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);

  // Jump host
  const [useJump, setUseJump] = useState(connection?.useJump ?? false);
  const [jumpHost, setJumpHost] = useState(connection?.jumpHost ?? '');
  const [jumpPort, setJumpPort] = useState(connection?.jumpPort ?? DEFAULT_PORT);
  const [jumpUsername, setJumpUsername] = useState(connection?.jumpUsername ?? '');
  const [jumpAuthMethod, setJumpAuthMethod] = useState<JumpAuthMethod>(
    connection?.jumpAuthMethod ?? 'withTarget',
  );
  const [jumpKeyPath, setJumpKeyPath] = useState(connection?.jumpKeyPath ?? '');
  const [jumpKeyId, setJumpKeyId] = useState(connection?.jumpKeyId ?? '');
  const [jumpPassword, setJumpPassword] = useState('');
  const [jumpPassphrase, setJumpPassphrase] = useState('');
  const [hasJumpPassword, setHasJumpPassword] = useState(false);
  const [hasJumpPassphrase, setHasJumpPassphrase] = useState(false);
  const [jumpCredDirty, setJumpCredDirty] = useState(false);

  const connections = useConnectionStore((s) => s.connections);

  // 密钥库列表：进入表单时载入；密钥库弹层关闭后重载（期间可能刚导入或删过）。
  // keyManagerTarget 回到 null 就是"弹层刚关上"，这样导入完立刻能在下拉里看到。
  useEffect(() => {
    if (keyManagerTarget !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await tauri.listKeys();
        if (!cancelled) setKeys(list);
      } catch (err) {
        console.warn('读取私钥库失败:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keyManagerTarget]);

  // 是否已保存密钥密码（编辑模式才问得出来）
  useEffect(() => {
    if (!connection?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const has = await tauri.hasPassphrase(connection.id);
        if (!cancelled) setHasPassphrase(has);
      } catch (err) {
        console.warn('检查已保存的密钥密码失败:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection?.id]);

  useEffect(() => {
    if (!connection?.id || !connection.useJump) return;
    let cancelled = false;
    (async () => {
      try {
        const [pw, pp] = await Promise.all([
          tauri.hasJumpPassword(connection.id),
          tauri.hasJumpPassphrase(connection.id),
        ]);
        if (!cancelled) {
          setHasJumpPassword(pw);
          setHasJumpPassphrase(pp);
        }
      } catch (err) {
        console.warn('检查跳板机凭证失败:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection?.id, connection?.useJump]);

  const buildSaved = (): SavedConnection => ({
    id: connection?.id ?? crypto.randomUUID(),
    name: name.trim(),
    host: host.trim(),
    port,
    username: username.trim(),
    authMethod,
    // 选了密钥库里的私钥就不再记路径；反之保留手填路径（老数据与高级用法）
    keyPath:
      authMethod === 'PrivateKey' && !keyId ? keyPath.trim() : undefined,
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
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = '名称为必填项';
    if (!host.trim()) newErrors.host = '主机为必填项';
    if (!username.trim()) newErrors.username = '用户名为必填项';
    if (port < 1 || port > 65535) newErrors.port = '端口必须在 1-65535 之间';
    if (authMethod === 'PrivateKey' && !keyId && !keyPath.trim()) {
      newErrors.keyPath = '请选择或导入一把私钥';
    }
    if (useJump) {
      if (!jumpHost.trim()) newErrors.jumpHost = '跳板机主机为必填项';
      if (!jumpUsername.trim()) newErrors.jumpUsername = '跳板机用户名为必填项';
      if (jumpPort < 1 || jumpPort > 65535) newErrors.jumpPort = '端口必须在 1-65535 之间';
      if (jumpAuthMethod === 'PrivateKey' && !jumpKeyId && !jumpKeyPath.trim()) {
        newErrors.jumpKeyPath = '请选择或导入跳板机的私钥';
      }
      if (jumpAuthMethod === 'Password' && !jumpPassword && !hasJumpPassword) {
        newErrors.jumpPassword = '请填写跳板机密码';
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  /** 有几条连接在用这把私钥（含作为跳板机私钥），删除前要提醒清楚。 */
  const keyUsage = (id: string) =>
    connections.filter(
      (c) => c.keyId === id || (c.useJump && c.jumpKeyId === id),
    ).length;

  const persistSecrets = async (id: string) => {
    // 主连接的密钥密码：只在用户这次真的填了才写，留空表示"保持已保存的那把"
    if (authMethod === 'PrivateKey' && passphrase) {
      await tauri.savePassphrase(id, passphrase);
    }
    if (!useJump) {
      // Best-effort cleanup when jump is turned off
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

  const clearPassphrase = async () => {
    if (!connection?.id) return;
    try {
      await tauri.deletePassphrase(connection.id);
      setHasPassphrase(false);
      setPassphrase('');
      setPassphraseDirty(false);
    } catch (err) {
      console.warn('清除已保存的密钥密码失败:', err);
    }
  };

  const handleSave = async () => {
    if (!validate()) return;
    const saved = buildSaved();
    try {
      await persistSecrets(saved.id);
    } catch (err) {
      console.warn('保存凭证失败:', err);
    }
    onSave(saved);
  };

  const handleTest = () => {
    if (!validate()) return;
    onTestConnection?.(buildSaved());
  };

  const selectedKey = keys.find((k) => k.id === keyId);
  const selectedJumpKey = keys.find((k) => k.id === jumpKeyId);

  return (
    <div className="p-4 space-y-4">
      <Input
        label="名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="我的服务器"
        error={errors.name}
      />

      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2">
          <Input
            label="主机"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.100"
            error={errors.host}
          />
        </div>
        <Input
          label="端口"
          type="number"
          value={String(port)}
          onChange={(e) => setPort(parseInt(e.target.value, 10) || DEFAULT_PORT)}
          error={errors.port}
        />
      </div>

      <Input
        label="用户名"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="root"
        error={errors.username}
      />

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-1">
          认证方式
        </label>
        <div className="flex gap-2 items-center">
          <select
            value={authMethod}
            onChange={(e) => setAuthMethod(e.target.value)}
            className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
          >
            <option value="Password">密码</option>
            <option value="PrivateKey">私钥</option>
          </select>
          {authMethod === 'Password' && connection?.id && (
            <Button
              variant="secondary"
              onClick={() => setPasswordPromptOpen(true)}
              className="whitespace-nowrap py-2"
            >
              重设密码
            </Button>
          )}
        </div>
      </div>

      {authMethod === 'PrivateKey' && (
        <>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">
              私钥
            </label>
            <div className="flex gap-2 items-center">
              <select
                value={keyId}
                onChange={(e) => {
                  setKeyId(e.target.value);
                  if (e.target.value) setKeyPath('');
                }}
                className="min-w-0 flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
              >
                <option value="">
                  {keys.length > 0 ? '未选择（也可在下方直接填路径）' : '还没有导入私钥'}
                </option>
                {keys.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.name}（{describeAlgorithm(key.algorithm)}
                    {key.encrypted ? ' · 带密码' : ''}）
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                onClick={() => setKeyManagerTarget('main')}
                className="whitespace-nowrap py-2"
              >
                选择 / 导入…
              </Button>
            </div>
            {selectedKey && (
              <p className="mt-1 text-xs text-zinc-500">
                {describeAlgorithm(selectedKey.algorithm)} ·{' '}
                {shortFingerprint(selectedKey.fingerprint)} · 共{' '}
                {keyUsage(selectedKey.id)} 条连接在用
              </p>
            )}
          </div>

          {!keyId && (
            <Input
              label="私钥路径（高级）"
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="~/.ssh/id_rsa"
              error={errors.keyPath}
            />
          )}

          {hasPassphrase && !passphraseDirty && !passphrase ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-zinc-400">密钥密码：已保存</span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="py-1.5 text-xs"
                  onClick={() => setPassphraseDirty(true)}
                >
                  修改
                </Button>
                <Button
                  variant="ghost"
                  className="py-1.5 text-xs"
                  onClick={() => void clearPassphrase()}
                >
                  清除
                </Button>
              </div>
            </div>
          ) : (
            <Input
              label="密钥密码（可选）"
              type="password"
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setPassphraseDirty(true);
              }}
              placeholder={
                connection?.id ? '留空则保持不变' : '留空则连接时输入'
              }
              autoComplete="new-password"
            />
          )}
        </>
      )}

      <Input
        label="分组（可选）"
        value={group}
        onChange={(e) => setGroup(e.target.value)}
        placeholder="生产环境"
      />

      {/* Jump host (ProxyJump) */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
        <button
          type="button"
          onClick={() => setUseJump((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800/50 rounded-lg transition-colors"
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
          <div className="px-3 pb-3 space-y-3 border-t border-zinc-800 pt-3">
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2">
                <Input
                  label="主机"
                  value={jumpHost}
                  onChange={(e) => setJumpHost(e.target.value)}
                  placeholder="bastion.example.com"
                  error={errors.jumpHost}
                />
              </div>
              <Input
                label="端口"
                type="number"
                value={String(jumpPort)}
                onChange={(e) =>
                  setJumpPort(parseInt(e.target.value, 10) || DEFAULT_PORT)
                }
                error={errors.jumpPort}
              />
            </div>

            <Input
              label="用户名"
              value={jumpUsername}
              onChange={(e) => setJumpUsername(e.target.value)}
              placeholder="jumpuser"
              error={errors.jumpUsername}
            />

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">
                认证方式
              </label>
              <select
                value={jumpAuthMethod}
                onChange={(e) => {
                  setJumpAuthMethod(e.target.value as JumpAuthMethod);
                  setJumpCredDirty(false);
                  setJumpPassword('');
                  setJumpPassphrase('');
                }}
                className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
              >
                <option value="withTarget">和目标相同</option>
                <option value="Password">密码</option>
                <option value="PrivateKey">私钥</option>
              </select>
            </div>

            {jumpAuthMethod === 'Password' && (
              <div>
                {hasJumpPassword && !jumpCredDirty && !jumpPassword ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-zinc-400">密码：已设置</span>
                    <Button
                      variant="secondary"
                      className="py-1.5 text-xs"
                      onClick={() => setJumpCredDirty(true)}
                    >
                      修改
                    </Button>
                  </div>
                ) : (
                  <Input
                    label="密码"
                    type="password"
                    value={jumpPassword}
                    onChange={(e) => {
                      setJumpPassword(e.target.value);
                      setJumpCredDirty(true);
                    }}
                    placeholder="跳板机密码"
                    error={errors.jumpPassword}
                    autoComplete="new-password"
                  />
                )}
              </div>
            )}

            {jumpAuthMethod === 'PrivateKey' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-1">
                    私钥
                  </label>
                  <div className="flex gap-2 items-center">
                    <select
                      value={jumpKeyId}
                      onChange={(e) => {
                        setJumpKeyId(e.target.value);
                        if (e.target.value) setJumpKeyPath('');
                      }}
                      className="min-w-0 flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="">
                        {keys.length > 0
                          ? '未选择（也可在下方直接填路径）'
                          : '还没有导入私钥'}
                      </option>
                      {keys.map((key) => (
                        <option key={key.id} value={key.id}>
                          {key.name}（{describeAlgorithm(key.algorithm)}）
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="secondary"
                      onClick={() => setKeyManagerTarget('jump')}
                      className="whitespace-nowrap py-2"
                    >
                      选择 / 导入…
                    </Button>
                  </div>
                  {selectedJumpKey && (
                    <p className="mt-1 text-xs text-zinc-500">
                      {describeAlgorithm(selectedJumpKey.algorithm)} ·{' '}
                      {shortFingerprint(selectedJumpKey.fingerprint)}
                    </p>
                  )}
                </div>

                {!jumpKeyId && (
                  <Input
                    label="私钥路径（高级）"
                    value={jumpKeyPath}
                    onChange={(e) => setJumpKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_rsa"
                    error={errors.jumpKeyPath}
                  />
                )}
                {hasJumpPassphrase && !jumpCredDirty && !jumpPassphrase ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-zinc-400">密钥密码：已设置</span>
                    <Button
                      variant="secondary"
                      className="py-1.5 text-xs"
                      onClick={() => setJumpCredDirty(true)}
                    >
                      修改
                    </Button>
                  </div>
                ) : (
                  <Input
                    label="密钥密码（可选）"
                    type="password"
                    value={jumpPassphrase}
                    onChange={(e) => {
                      setJumpPassphrase(e.target.value);
                      setJumpCredDirty(true);
                    }}
                    placeholder="私钥 passphrase"
                    autoComplete="new-password"
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        {onTestConnection && (
          <Button variant="secondary" onClick={handleTest}>
            测试连接
          </Button>
        )}
        <Button variant="primary" onClick={() => void handleSave()}>
          保存
        </Button>
      </div>

      {/* Password reset prompt (edit mode, password auth only) */}
      {connection?.id && (
        <PasswordPrompt
          open={passwordPromptOpen}
          title="重设密码"
          description="密码会加密保存到本设备，新连接自动使用。"
          submitLabel="保存"
          onSubmit={(password) => {
            tauri.savePassword(connection.id, password).catch(console.warn);
            setPasswordPromptOpen(false);
          }}
          onCancel={() => setPasswordPromptOpen(false)}
        />
      )}

      {/* 私钥库：选文件 / 粘贴内容 / 重命名 / 删除都在同一个界面里 */}
      <Modal
        open={keyManagerTarget !== null}
        onClose={() => setKeyManagerTarget(null)}
        title="私钥"
      >
        <KeyManager
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
      </Modal>
    </div>
  );
}
