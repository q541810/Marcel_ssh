import { useEffect, useState } from 'react';
import type { JumpAuthMethod, SavedConnection, StoredKeyMeta } from '@/lib/types';
import { DEFAULT_PORT } from '@/lib/constants';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
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
  /**
   * 密钥链写入失败的出路。
   *
   * 表单保存后**立刻关闭**，自己那条提示活不到用户看见；所以失败要说给外面的既有
   * 报错面（连接列表那条红条）。密钥链不可用不拦保存——连接本身照样存下来。
   */
  onSecretsSaveError: (message: string) => void;
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

export default function ConnectionForm({
  connection,
  onSave,
  onCancel,
  onTestConnection,
  onSecretsSaveError,
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
  /**
   * 登录密码：**私钥连接也能存一个**。
   *
   * 它不用来登录（登录用的是私钥），存在的唯一理由是 agent 执行 `sudo` 时把它
   * 自动填给远端 —— bash 工具的 sudo 改写读的就是密钥链里 account = 连接 id 的
   * 这条（`agent/tools/bash.rs::lookup_password`），而那条以前只有密码认证才会写，
   * 于是私钥用户跑 sudo 必然失败（我们的 exec 通道没有 PTY，sudo 也没法回头问人）。
   */
  const [loginPassword, setLoginPassword] = useState('');
  const [hasLoginPassword, setHasLoginPassword] = useState(false);
  const [loginPasswordDirty, setLoginPasswordDirty] = useState(false);
  const [keys, setKeys] = useState<StoredKeyMeta[]>([]);
  const [keyManagerTarget, setKeyManagerTarget] = useState<'main' | 'jump' | null>(
    null,
  );
  const [group, setGroup] = useState(connection?.group ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  /** 「重设密码」浮层上一次保存失败的原因（浮层留在原地让用户重试）。 */
  const [passwordSaveError, setPasswordSaveError] = useState<string | null>(null);

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

  // 已保存的密钥密码 / 登录密码（编辑模式才问得出来）
  useEffect(() => {
    if (!connection?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const [passphrase, loginPassword] = await Promise.all([
          tauri.hasPassphrase(connection.id),
          tauri.hasPassword(connection.id),
        ]);
        if (!cancelled) {
          setHasPassphrase(passphrase);
          setHasLoginPassword(loginPassword);
        }
      } catch (err) {
        console.warn('检查已保存的凭证失败:', err);
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
    // 登录密码（私钥连接下供 agent 的 sudo 自动填充用）。与密钥密码是两个账号，
    // 千万别写串：写错账号会让 sudo 静默失效、或者让连接拿密钥密码去当登录密码。
    if (authMethod === 'PrivateKey' && loginPassword) {
      await tauri.savePassword(id, loginPassword);
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

  /** 删掉 account = 连接 id 的那条：密码认证下它就是登录密码，私钥连接下它是给
   *  agent 的 sudo 自动填充用的登录密码——同一个账号，两个分支共用这一个清除动作。 */
  const clearLoginPassword = async () => {
    if (!connection?.id) return;
    try {
      await tauri.deletePassword(connection.id);
      setHasLoginPassword(false);
      setLoginPassword('');
      setLoginPasswordDirty(false);
    } catch (err) {
      console.warn('清除已保存的登录密码失败:', err);
    }
  };

  const handleSave = async () => {
    if (!validate()) return;
    const saved = buildSaved();
    let secretWarning: string | null = null;
    try {
      await persistSecrets(saved.id);
    } catch (err) {
      console.warn('保存凭证失败:', err);
      // 凭证没进密钥链这件事必须让用户知道（否则他以为已经记住了，下次又得输）。
      // 连接本身照存——这是既有的取舍：密钥链不可用不该挡着保存/连接。
      secretWarning = secretSaveFailedMessage('凭证', err);
    }
    onSave(saved);
    // 报给宿主放在 onSave **之后**：宿主可能在自己的 onSave 里清错误（连接列表就是），
    // 先说再清等于没说。
    if (secretWarning) onSecretsSaveError(secretWarning);
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
          {/* 还没存过密码才给这个入口；存过则下面有「密码：已保存 / 修改 / 清除」 */}
          {authMethod === 'Password' && connection?.id && !hasLoginPassword && (
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

      {/*
        密码认证下已保存的凭证：密钥链里 account = 连接 id 的那条（登录时用的就是
        它）。以前桌面只在私钥分支拿它当 sudo 登录密码、带「清除」，密码认证分支
        既不写也不删——于是 PasswordPrompt 里「要清掉已保存的凭证，用连接设置里的
        「清除」」在桌面密码认证场景指向一个不存在的控件。这里补上与移动端对称的
        「已保存 / 修改 / 清除」。
      */}
      {authMethod === 'Password' && connection?.id && hasLoginPassword && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-zinc-400">密码：已保存</span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="py-1.5 text-xs"
              onClick={() => setPasswordPromptOpen(true)}
            >
              修改
            </Button>
            <Button
              variant="ghost"
              className="py-1.5 text-xs"
              onClick={() => void clearLoginPassword()}
            >
              清除
            </Button>
          </div>
        </div>
      )}

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

          {/* 登录密码：与 SSH 登录无关，只给 agent 执行 sudo 时用 */}
          {hasLoginPassword && !loginPasswordDirty && !loginPassword ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-zinc-400">登录密码：已保存</span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  className="py-1.5 text-xs"
                  onClick={() => setLoginPasswordDirty(true)}
                >
                  修改
                </Button>
                <Button
                  variant="ghost"
                  className="py-1.5 text-xs"
                  onClick={() => void clearLoginPassword()}
                >
                  清除
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Input
                label="登录密码（可选）"
                type="password"
                value={loginPassword}
                onChange={(e) => {
                  setLoginPassword(e.target.value);
                  setLoginPasswordDirty(true);
                }}
                placeholder={
                  connection?.id ? '留空则保持不变' : '留空则不自动填充'
                }
                autoComplete="new-password"
              />
              <p className="mt-1 text-xs text-zinc-500">
                本连接用私钥登录，用不到这个密码。填了之后，agent 执行
                sudo 时会自动把它填给远端（我们自己的通道没有终端，sudo 没法回来问你）。
              </p>
            </div>
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
          description={
            '密码会加密保存到本设备，新连接自动使用。' +
            (passwordSaveError ? `上次没能保存：${passwordSaveError}` : '')
          }
          submitLabel="保存"
          onSubmit={(password) => {
            void tauri
              .savePassword(connection.id, password)
              .then(() => {
                setHasLoginPassword(true);
                setPasswordSaveError(null);
                setPasswordPromptOpen(false);
              })
              .catch((err) => {
                console.warn('保存密码到密钥链失败:', err);
                // 浮层留在原地、把原因写进描述：用户刚输入的内容还在，直接再点一次
                // 「保存」即可重试。关掉才算成功，绝不能"关了但没存上"。
                setPasswordSaveError(secretSaveFailedMessage('密码', err));
              });
          }}
          onCancel={() => {
            setPasswordSaveError(null);
            setPasswordPromptOpen(false);
          }}
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
