import { useState } from 'react';
import type { SavedConnection } from '@/lib/types';
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

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = '名称为必填项';
    if (!host.trim()) newErrors.host = '主机为必填项';
    if (!username.trim()) newErrors.username = '用户名为必填项';
    if (port < 1 || port > 65535) newErrors.port = '端口必须在 1-65535 之间';
    if (authMethod === 'PrivateKey' && !keyPath.trim()) {
      newErrors.keyPath = '私钥认证需要密钥路径';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = () => {
    if (!validate()) return;
    const saved: SavedConnection = {
      id: connection?.id ?? crypto.randomUUID(),
      name: name.trim(),
      host: host.trim(),
      port,
      username: username.trim(),
      authMethod,
      keyPath: authMethod === 'PrivateKey' ? keyPath.trim() : undefined,
      group: group.trim() || undefined,
      lastConnected: connection?.lastConnected,
    };
    onSave(saved);
  };

  const handleTest = () => {
    if (!validate()) return;
    const saved: SavedConnection = {
      id: connection?.id ?? crypto.randomUUID(),
      name: name.trim(),
      host: host.trim(),
      port,
      username: username.trim(),
      authMethod,
      keyPath: authMethod === 'PrivateKey' ? keyPath.trim() : undefined,
      group: group.trim() || undefined,
    };
    onTestConnection?.(saved);
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
        <Button variant="primary" onClick={handleSave}>
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
