import { useEffect, useMemo, type Dispatch } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import MobileSelect from '@/mobile/ui/MobileSelect';
import { useConnectionStore } from '@/stores/connectionStore';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { isDebugConnection } from '@/lib/debugServer';
import { formatConnLabel } from '@/lib/privacy';
import {
  DEFAULT_SYNC_ROOT,
  isJianguoyunUrl,
  type StorageKind,
  type WizardAction,
  type WizardState,
} from '@/lib/syncModel';
import { Callout, SyncChoice, type SyncVariant } from './syncUi';

const STORAGE_OPTIONS = [
  { value: 'webDav', label: 'WebDAV', desc: '坚果云、Nextcloud 等网盘' },
  { value: 'sftp', label: '我的服务器', desc: '用已保存的 SSH 服务器（SFTP）' },
] as const;

/** 字段下方的一行说明。 */
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-meta leading-relaxed text-fg-tertiary">{children}</p>;
}

/**
 * 「同步数据放在哪」的表单：开启向导与"手动加入"共用。
 *
 * 存储的任何输入一变，上一次"测试连接"的结论就作废（reducer 里统一处理），
 * 所以这里只管把输入交给 dispatch，不自己记测试状态。
 */
export function StorageForm({
  variant,
  state,
  dispatch,
  disabled,
}: {
  variant: SyncVariant;
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  disabled?: boolean;
}) {
  const connections = useConnectionStore((s) => s.connections);
  const connectionsLoaded = useConnectionStore((s) => s.loaded);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const privacyMode = usePrivacyMode();

  useEffect(() => {
    if (!connectionsLoaded) void fetchConnections();
  }, [connectionsLoaded, fetchConnections]);

  const options = useMemo(
    () =>
      connections
        .filter((c) => !isDebugConnection(c.id))
        .map((c) => ({
          value: c.id,
          label: c.name || `${c.username}@${c.host}`,
          hint: formatConnLabel(c.username, c.host, c.port, privacyMode),
        })),
    [connections, privacyMode],
  );
  const selected = connections.find((c) => c.id === state.sftp.connectionId);
  const kind: StorageKind = state.storageKind;
  const jianguoyun = isJianguoyunUrl(state.webDav.url);
  // 坚果云不允许在**根目录**下直接新建文件夹（它会拒绝 MKCOL），所以同步文件夹必须放进
  // 一个已存在的目录里。它默认给每个账号建好的是「我的坚果云」，因此那里才是默认落点。
  const jgyDefaultRoot = `我的坚果云/${DEFAULT_SYNC_ROOT}`;
  const rootPlaceholder = kind === 'webDav' && jianguoyun ? jgyDefaultRoot : DEFAULT_SYNC_ROOT;

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-2 text-body font-medium text-fg-secondary">同步数据放在哪</div>
        <SyncChoice
          variant={variant}
          options={STORAGE_OPTIONS}
          value={kind}
          onChange={(value) => dispatch({ type: 'setStorageKind', kind: value })}
          ariaLabel="同步数据存放位置"
          disabled={disabled}
        />
      </div>

      {kind === 'webDav' ? (
        <div className="space-y-3">
          <div>
            <Input
              label="WebDAV 地址"
              value={state.webDav.url}
              onChange={(e) => {
                const url = e.target.value;
                // 一填坚果云的地址就把同步文件夹推到「我的坚果云/」下面：它的根目录不允许建文件夹，
                // 留在默认值上必然失败，而这时用户还没被迫读懂这条规则。
                const patch: Partial<WizardState['webDav']> = { url };
                if (isJianguoyunUrl(url) && state.webDav.root.trim() === DEFAULT_SYNC_ROOT) {
                  patch.root = jgyDefaultRoot;
                }
                dispatch({ type: 'setWebDav', patch });
              }}
              placeholder="https://dav.jianguoyun.com/dav/"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={disabled}
            />
            <Hint>
              坚果云填 <code className="text-fg-secondary">https://dav.jianguoyun.com/dav/</code>；
              Nextcloud 等填各自的 WebDAV 地址。
            </Hint>          </div>
          <div>
            <Input
              label="账号"
              value={state.webDav.username}
              onChange={(e) => dispatch({ type: 'setWebDav', patch: { username: e.target.value } })}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={disabled}
            />
          </div>
          <div>
            <Input
              label={jianguoyun ? '应用密码' : '密码'}
              type="password"
              value={state.webDav.password}
              onChange={(e) => dispatch({ type: 'setWebDav', patch: { password: e.target.value } })}
              autoComplete="new-password"
              disabled={disabled}
            />
            {jianguoyun ? (
              <Hint>
                坚果云要用「应用密码」，不是登录密码：在坚果云网页端的 账户信息 → 安全选项 → 第三方应用管理 里添加一个，
                把生成的密码填在这里。
              </Hint>
            ) : (
              <Hint>密码只用来连接这个位置，保存在系统密钥链里，不会写进配置文件，也不会被同步。</Hint>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-body font-medium text-fg-secondary">选择一台已保存的服务器</div>
            {options.length === 0 ? (
              <Callout tone="warn">
                还没有已保存的服务器。先到「连接」里添加一台，再回来选；或者改用 WebDAV。
              </Callout>
            ) : variant === 'desktop' ? (
              <Select
                value={state.sftp.connectionId}
                onChange={(value) => dispatch({ type: 'setSftp', patch: { connectionId: value } })}
                options={options}
                placeholder="选择服务器…"
                ariaLabel="同步用的服务器"
                disabled={disabled}
              />
            ) : (
              <MobileSelect
                value={state.sftp.connectionId}
                onChange={(value) => dispatch({ type: 'setSftp', patch: { connectionId: value } })}
                options={options}
                placeholder="选择服务器…"
                ariaLabel="同步用的服务器"
                title="选择同步用的服务器"
                disabled={disabled}
              />
            )}
            <Hint>
              同步文件会存在这台服务器上（默认在登录用户的家目录下），加密后才上传，服务器上只有看不懂的密文。
            </Hint>
          </div>
          {selected?.authMethod === 'PrivateKey' && (
            <Callout>
              这台服务器用私钥登录。之后在新设备上加入时，要先在新设备上添加这台服务器并导入私钥，再用恢复密钥加入
              （私钥不会经同步码传递）。
            </Callout>
          )}
        </div>
      )}

      <div>
        <Input
          label="同步文件夹"
          value={kind === 'webDav' ? state.webDav.root : state.sftp.root}
          onChange={(e) =>
            dispatch(
              kind === 'webDav'
                ? { type: 'setWebDav', patch: { root: e.target.value } }
                : { type: 'setSftp', patch: { root: e.target.value } },
            )
          }
          placeholder={rootPlaceholder}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={disabled}
        />
        {kind === 'webDav' && jianguoyun ? (
          <Hint>
            坚果云不允许在根目录下直接新建文件夹，所以这里要写进已有的「我的坚果云」里，例如{' '}
            <code className="text-fg-secondary">{jgyDefaultRoot}</code>。不存在会自动创建。
          </Hint>
        ) : (
          <Hint>同步数据都放在这个文件夹里；不存在会自动创建。一般保持默认即可。</Hint>
        )}
      </div>
    </div>
  );
}

/** 「测试连接」的结果行。 */
export function TestResult({ state }: { state: WizardState['test'] }) {
  if (state.status === 'testing') {
    return (
      <p className="flex items-center gap-2 text-meta text-fg-secondary" aria-live="polite">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
        正在连接并检查读写权限…
      </p>
    );
  }
  if (state.status === 'ok') {
    return (
      <p className="flex items-center gap-2 text-meta text-emerald-400" aria-live="polite">
        <Check className="h-3.5 w-3.5" aria-hidden />
        连接正常，可以读写
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <p className="flex items-start gap-2 text-meta text-red-400" role="alert">
        <CircleAlert className="mt-1 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
        <span>{state.message || '连接失败'}</span>
      </p>
    );
  }
  return null;
}
