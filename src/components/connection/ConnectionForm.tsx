import { useState } from 'react';
import type { SavedConnection } from '@/lib/types';
import { DEFAULT_PORT } from '@/lib/constants';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';

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
        <select
          value={authMethod}
          onChange={(e) => setAuthMethod(e.target.value)}
          className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-indigo-500"
        >
          <option value="Password">密码</option>
          <option value="PrivateKey">私钥</option>
        </select>
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
    </div>
  );
}
