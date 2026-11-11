import { useEffect, useState } from 'react';
import type { JumpAuthMethod, SavedConnection, StoredKeyMeta } from '@/lib/types';
import { DEFAULT_PORT } from '@/lib/constants';
import * as tauri from '@/lib/tauri';
import {
  buildSavedConnection,
  keyUsageCount,
  parsePortInput,
  secretSaveFailedMessage,
  shouldResetPortOnBlur,
  validateConnectionForm,
} from '@/lib/connectionFormModel';
import { describeAlgorithm, shortFingerprint } from '@/lib/privateKey';
import { useConnectionStore } from '@/stores/connectionStore';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Modal from '@/components/ui/Modal';
import Select from '@/components/ui/Select';
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
  const [portInput, setPortInput] = useState(String(connection?.port ?? DEFAULT_PORT));
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
   * 它不用来登录（登录用的是私钥），存在的理由是 agent 执行 `sudo` 时可能把它
   * 借去当 sudo 密码（command_exec 的 askpass 桥：同一条连接、sudo 问的正是
   * 登录用户本人时才借，见 `command_exec/sudo.rs`）。
   */
  const [loginPassword, setLoginPassword] = useState('');
  const [hasLoginPassword, setHasLoginPassword] = useState(false);
  const [loginPasswordDirty, setLoginPasswordDirty] = useState(false);
  /** agent 执行 sudo 时用户亲手输过、已加密保存在本设备的密码（值带目标三元组）。 */
  const [hasSudoPassword, setHasSudoPassword] = useState(false);
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
  const [jumpPortInput, setJumpPortInput] = useState(String(connection?.jumpPort ?? DEFAULT_PORT));
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

  // 已保存的密钥密码 / 登录密码 / sudo 密码（编辑模式才问得出来）
  useEffect(() => {
    if (!connection?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const [passphrase, loginPassword, sudoPassword] = await Promise.all([
          tauri.hasPassphrase(connection.id),
          tauri.hasPassword(connection.id),
          tauri.hasSudoPassword(connection.id),
        ]);
        if (!cancelled) {
          setHasPassphrase(passphrase);
          setHasLoginPassword(loginPassword);
          setHasSudoPassword(sudoPassword);
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

  const buildSaved = (): SavedConnection =>
    buildSavedConnection({
      existing: connection,
      name,
      host,
      port,
      username,
      authMethod,
      keyId,
      keyPath,
      group,
      useJump,
      jumpHost,
      jumpPort,
      jumpUsername,
      jumpAuthMethod,
      jumpKeyId,
      jumpKeyPath,
    });

  const validate = (): boolean => {
    const next = validateConnectionForm({
      name,
      host,
      username,
      port,
      authMethod,
      keyId,
      keyPath,
      useJump,
      jumpHost,
      jumpUsername,
      jumpPort,
      jumpAuthMethod,
      jumpKeyId,
      jumpKeyPath,
      jumpPassword,
      hasJumpPassword,
    });
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  /** 有几条连接在用这把私钥（含作为跳板机私钥），删除前要提醒清楚。 */
  const keyUsage = (id: string) => keyUsageCount(connections, id);

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

  /** 只清 sudo 密码，不动登录凭据——它俩是两条独立的密钥链条目。 */
  const clearSudoPassword = async () => {
    if (!connection?.id) return;
    try {
      await tauri.deleteSudoPassword(connection.id);
      setHasSudoPassword(false);
    } catch (err) {
      console.warn('清除已保存的 sudo 密码失败:', err);
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
      secretWarning = secretSaveFailedMessage('凭证', err, 'form');
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
    <div className="px-4 pb-4 pt-1 space-y-4">
      <Input
        label="名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="我的服务器"
        error={errors.name}
      />

      <div className="grid grid-cols-3 gap-3">
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
          value={portInput}
          onChange={(e) => {
            const val = e.target.value;
            setPortInput(val);
            const parsed = parsePortInput(val);
            if (parsed !== null) {
              setPort(parsed);
            }
          }}
          onBlur={() => {
            if (shouldResetPortOnBlur(portInput)) {
              setPortInput(String(DEFAULT_PORT));
              setPort(DEFAULT_PORT);
            }
          }}
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
        <label className="block text-meta font-medium text-fg-secondary mb-1">
          认证方式
        </label>
        <div className="flex gap-2 items-center">
          <Select
            className="flex-1"
            ariaLabel="认证方式"
            value={authMethod}
            onChange={setAuthMethod}
            options={[
              { value: 'Password', label: '密码' },
              { value: 'PrivateKey', label: '私钥' },
            ]}
          />
          {/* 还没存过密码才给这个入口；存过则下面有「密码：已保存 / 修改 / 清除」 */}
          {authMethod === 'Password' && connection?.id && !hasLoginPassword && (
            <Button
              variant="secondary"
              onClick={() => setPasswordPromptOpen(true)}
              size="lg"
              className="whitespace-nowrap"
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
          <span className="text-body text-fg-secondary">密码：已保存</span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPasswordPromptOpen(true)}
            >
              修改
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void clearLoginPassword()}
            >
              清除
            </Button>
          </div>
        </div>
      )}

      {/* agent 跑 sudo 时用户亲手输过、且已加密保存的密码。跟登录密码是两个槽位，
          只清这一条；改了地址 / 用户名后旧的那份不再匹配，会重新问。 */}
      {connection?.id && hasSudoPassword && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-body text-fg-secondary">sudo 密码：已保存</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void clearSudoPassword()}
          >
            清除
          </Button>
        </div>
      )}

      {authMethod === 'PrivateKey' && (
        <>
          <div>
            <label className="block text-meta font-medium text-fg-secondary mb-1">
              私钥
            </label>
            <div className="flex gap-2 items-center">
              <Select
                className="min-w-0 flex-1"
                ariaLabel="私钥"
                value={keyId}
                onChange={(v) => {
                  setKeyId(v);
                  if (v) setKeyPath('');
                }}
                options={[
                  {
                    value: '',
                    label: keys.length > 0 ? '未选择（也可在下方直接填路径）' : '还没有导入私钥',
                  },
                  ...keys.map((key) => ({
                    value: key.id,
                    label: `${key.name}（${describeAlgorithm(key.algorithm)}${key.encrypted ? ' · 带密码' : ''}）`,
                  })),
                ]}
              />
              <Button
                variant="secondary"
                onClick={() => setKeyManagerTarget('main')}
                size="lg"
              className="whitespace-nowrap"
              >
                选择 / 导入…
              </Button>
            </div>
            {selectedKey && (
              <p className="mt-1 text-meta text-fg-tertiary">
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
              <span className="text-body text-fg-secondary">密钥密码：已保存</span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPassphraseDirty(true)}
                >
                  修改
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
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
              <span className="text-body text-fg-secondary">登录密码：已保存</span>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setLoginPasswordDirty(true)}
                >
                  修改
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
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
              <p className="mt-1 text-meta text-fg-tertiary">
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
      <div className="rounded-xl border border-field-edge">
        <button
          type="button"
          onClick={() => setUseJump((v) => !v)}
          className="focus-ring w-full flex items-center justify-between rounded-xl px-3 h-11 text-body text-fg"
        >
          <span className="font-medium">跳板机（可选）</span>
          <span
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 ease-standard ${
              useJump ? 'bg-indigo-600' : 'bg-fill-strong'
            }`}
            role="switch"
            aria-checked={useJump}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-raised transition-transform duration-200 ease-standard ${
                useJump ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </span>
        </button>

        {useJump && (
          <div className="px-3 pb-3 space-y-4 border-t border-field-edge pt-3">
            <div className="grid grid-cols-3 gap-3">
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
                value={jumpPortInput}
                onChange={(e) => {
                  const val = e.target.value;
                  setJumpPortInput(val);
                  const parsed = parsePortInput(val);
                  if (parsed !== null) {
                    setJumpPort(parsed);
                  }
                }}
                onBlur={() => {
                  if (shouldResetPortOnBlur(jumpPortInput)) {
                    setJumpPortInput(String(DEFAULT_PORT));
                    setJumpPort(DEFAULT_PORT);
                  }
                }}
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
              <label className="block text-meta font-medium text-fg-secondary mb-1">
                认证方式
              </label>
              <Select<JumpAuthMethod>
                className="w-full"
                ariaLabel="跳板机认证方式"
                value={jumpAuthMethod}
                onChange={(v) => {
                  setJumpAuthMethod(v);
                  setJumpCredDirty(false);
                  setJumpPassword('');
                  setJumpPassphrase('');
                }}
                options={[
                  { value: 'withTarget', label: '和目标相同' },
                  { value: 'Password', label: '密码' },
                  { value: 'PrivateKey', label: '私钥' },
                ]}
              />
            </div>

            {jumpAuthMethod === 'Password' && (
              <div>
                {hasJumpPassword && !jumpCredDirty && !jumpPassword ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-body text-fg-secondary">密码：已设置</span>
                    <Button
                      variant="secondary"
                      size="sm"
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
                  <label className="block text-meta font-medium text-fg-secondary mb-1">
                    私钥
                  </label>
                  <div className="flex gap-2 items-center">
                    <Select
                      className="min-w-0 flex-1"
                      ariaLabel="跳板机私钥"
                      value={jumpKeyId}
                      onChange={(v) => {
                        setJumpKeyId(v);
                        if (v) setJumpKeyPath('');
                      }}
                      options={[
                        {
                          value: '',
                          label:
                            keys.length > 0 ? '未选择（也可在下方直接填路径）' : '还没有导入私钥',
                        },
                        ...keys.map((key) => ({
                          value: key.id,
                          label: `${key.name}（${describeAlgorithm(key.algorithm)}）`,
                        })),
                      ]}
                    />
                    <Button
                      variant="secondary"
                      onClick={() => setKeyManagerTarget('jump')}
                      size="lg"
              className="whitespace-nowrap"
                    >
                      选择 / 导入…
                    </Button>
                  </div>
                  {selectedJumpKey && (
                    <p className="mt-1 text-meta text-fg-tertiary">
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
                    <span className="text-body text-fg-secondary">密钥密码：已设置</span>
                    <Button
                      variant="secondary"
                      size="sm"
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
                setPasswordSaveError(secretSaveFailedMessage('密码', err, 'form'));
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
