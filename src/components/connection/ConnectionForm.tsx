import { useEffect, useState } from 'react';
import type { JumpAuthMethod, SavedConnection } from '@/lib/types';
import { DEFAULT_PORT } from '@/lib/constants';
import * as tauri from '@/lib/tauri';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import PasswordPrompt from './PasswordPrompt';

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
  const [jumpPassword, setJumpPassword] = useState('');
  const [jumpPassphrase, setJumpPassphrase] = useState('');
  const [hasJumpPassword, setHasJumpPassword] = useState(false);
  const [hasJumpPassphrase, setHasJumpPassphrase] = useState(false);
  const [jumpCredDirty, setJumpCredDirty] = useState(false);

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
    keyPath: authMethod === 'PrivateKey' ? keyPath.trim() : undefined,
    group: group.trim() || undefined,
    lastConnected: connection?.lastConnected,
    useJump,
    jumpHost: useJump ? jumpHost.trim() : undefined,
    jumpPort: useJump ? jumpPort : undefined,
    jumpUsername: useJump ? jumpUsername.trim() : undefined,
    jumpAuthMethod: useJump ? jumpAuthMethod : undefined,
    jumpKeyPath:
      useJump && jumpAuthMethod === 'PrivateKey' ? jumpKeyPath.trim() : undefined,
  });

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = '名称为必填项';
    if (!host.trim()) newErrors.host = '主机为必填项';
    if (!username.trim()) newErrors.username = '用户名为必填项';
    if (port < 1 || port > 65535) newErrors.port = '端口必须在 1-65535 之间';
    if (authMethod === 'PrivateKey' && !keyPath.trim()) {
      newErrors.keyPath = '私钥认证需要密钥路径';
    }
    if (useJump) {
      if (!jumpHost.trim()) newErrors.jumpHost = '跳板机主机为必填项';
      if (!jumpUsername.trim()) newErrors.jumpUsername = '跳板机用户名为必填项';
      if (jumpPort < 1 || jumpPort > 65535) newErrors.jumpPort = '端口必须在 1-65535 之间';
      if (jumpAuthMethod === 'PrivateKey' && !jumpKeyPath.trim()) {
        newErrors.jumpKeyPath = '跳板机私钥路径为必填项';
      }
      if (jumpAuthMethod === 'Password' && !jumpPassword && !hasJumpPassword) {
        newErrors.jumpPassword = '请填写跳板机密码';
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const persistJumpSecrets = async (id: string) => {
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

  const handleSave = async () => {
    if (!validate()) return;
    const saved = buildSaved();
    try {
      await persistJumpSecrets(saved.id);
    } catch (err) {
      console.warn('保存跳板机凭证失败:', err);
    }
    onSave(saved);
  };

  const handleTest = () => {
    if (!validate()) return;
    onTestConnection?.(buildSaved());
  };

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
          {connection?.id && (
            <Button
              variant="secondary"
              onClick={() => setPasswordPromptOpen(true)}
              className="whitespace-nowrap py-2"
            >
              {authMethod === 'Password' ? '重设密码' : '重设密钥密码'}
            </Button>
          )}
        </div>
      </div>

      {authMethod === 'PrivateKey' && (
        <Input
          label="私钥路径"
          value={keyPath}
          onChange={(e) => setKeyPath(e.target.value)}
          placeholder="~/.ssh/id_rsa"
          error={errors.keyPath}
        />
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
                <Input
                  label="私钥路径"
                  value={jumpKeyPath}
                  onChange={(e) => setJumpKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_rsa"
                  error={errors.jumpKeyPath}
                />
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

      {/* Password / passphrase reset prompt (edit mode only) */}
      {connection?.id && (
        <PasswordPrompt
          open={passwordPromptOpen}
          title={authMethod === 'Password' ? '重设密码' : '重设密钥密码'}
          description={`${authMethod === 'Password' ? '密码' : '密钥密码'}会保存到系统密钥链，新连接自动使用。`}
          submitLabel="保存"
          onSubmit={(password) => {
            if (authMethod === 'Password') {
              tauri.savePassword(connection.id, password).catch(console.warn);
            } else {
              tauri.savePassphrase(connection.id, password).catch(console.warn);
            }
            setPasswordPromptOpen(false);
          }}
          onCancel={() => setPasswordPromptOpen(false)}
        />
      )}
    </div>
  );
}
