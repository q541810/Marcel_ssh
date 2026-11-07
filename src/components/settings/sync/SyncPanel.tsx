import { useEffect, useState, type ReactNode } from 'react';
import { useSyncStore } from '@/stores/syncStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { describeStorage, describeSyncStatus, type WizardMode } from '@/lib/syncModel';
import type { SyncStatus } from '@/lib/types';
import { getErrorMessage } from '@/lib/errors';
import { SyncWizard } from './SyncWizard';
import { SyncHeldBanner } from './SyncHeldBanner';
import { SyncStopDialog } from './SyncStopDialog';
import { AddDeviceBlock, RecoveryKeyBlock } from './SyncSecretBlocks';
import { DeviceNameEditor, DevicesList } from './SyncDevicesBlock';
import { HistoryList } from './SyncHistoryBlock';
import { ScopeList } from './SyncScopeList';
import { Callout, StatusDot, SyncBlock, SyncButton, SyncRow, type SyncVariant } from './syncUi';

/** 相对时间（"3 分钟前"）每隔多久重算一次。 */
const CLOCK_TICK_MS = 30_000;
/** 面板上的"已开启 / 已加入"提示停留多久。 */
const NOTICE_MS = 6_000;

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function StatusBlock({ variant, status, now }: { variant: SyncVariant; status: SyncStatus; now: Date }) {
  const syncNow = useSyncStore((s) => s.syncNow);
  const syncingNow = useSyncStore((s) => s.syncingNow);
  const connections = useConnectionStore((s) => s.connections);
  const [error, setError] = useState<string | null>(null);

  const view = describeSyncStatus(status, now);
  const busy = syncingNow || status.state === 'syncing';
  const storage = status.storage;
  const sftpName =
    storage?.kind === 'sftp' ? connections.find((c) => c.id === storage.connectionId)?.name : undefined;
  const storageLine = describeStorage(storage, sftpName);

  const run = async () => {
    setError(null);
    try {
      await syncNow();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-body font-medium text-fg" aria-live="polite">
        <StatusDot tone={view.tone} />
        <span>{view.title}</span>
      </div>
      {view.detail && (
        <p className={`text-meta leading-relaxed ${view.tone === 'error' ? 'text-red-300' : 'text-fg-secondary'}`}>
          {view.detail}
        </p>
      )}
      {storageLine && <p className="break-all text-meta text-fg-tertiary">存放位置：{storageLine}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <SyncButton variant={variant} kind={status.state === 'error' ? 'primary' : 'secondary'} loading={busy} onClick={() => void run()}>
          {status.state === 'error' ? '重试' : '立即同步'}
        </SyncButton>
      </div>
      {error && (
        <p className="text-meta text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 「同步」设置的全部内容（桌面设置页 Card 里的行 / 手机设置页的卡片共用）。
 *
 * 三种形态：还没拿到状态（含后端不可用）、未开启（介绍 + 两个入口）、已开启（状态 / 范围 /
 * 添加设备 / 恢复密钥 / 设备 / 记录 / 停止）。命令报错时只在本面板里说明，不影响设置页其它部分。
 */
export function SyncPanel({ variant }: { variant: SyncVariant }) {
  const status = useSyncStore((s) => s.status);
  const statusError = useSyncStore((s) => s.statusError);
  const refreshStatus = useSyncStore((s) => s.refreshStatus);
  const devices = useSyncStore((s) => s.devices);
  const devicesLoading = useSyncStore((s) => s.devicesLoading);
  const devicesError = useSyncStore((s) => s.devicesError);
  const history = useSyncStore((s) => s.history);
  const historyLoading = useSyncStore((s) => s.historyLoading);
  const historyError = useSyncStore((s) => s.historyError);
  const loadDevices = useSyncStore((s) => s.loadDevices);
  const loadHistory = useSyncStore((s) => s.loadHistory);

  const now = useNow(CLOCK_TICK_MS);
  const [wizard, setWizard] = useState<{ mode: WizardMode; open: boolean }>({ mode: 'create', open: false });
  const [stopOpen, setStopOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const enabled = status?.enabled === true;
  const lastSyncAt = status?.lastSyncAt ?? null;
  // 每次同步完成（lastSyncAt 变了）就重新拉设备与记录——别的设备的改动正是在同步里落进来的。
  useEffect(() => {
    if (!enabled) return;
    void loadDevices();
    void loadHistory();
  }, [enabled, lastSyncAt, loadDevices, loadHistory]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const openWizard = (mode: WizardMode) => setWizard({ mode, open: true });
  const wizardNode = (
    <SyncWizard
      variant={variant}
      mode={wizard.mode}
      open={wizard.open}
      onClose={() => setWizard((w) => ({ ...w, open: false }))}
      onFinished={(mode) =>
        setNotice(mode === 'create' ? '跨设备同步已开启。' : '已加入同步，正在合并云端数据。')
      }
    />
  );

  // 向导必须挂在**所有分支共同的固定位置**：创建成功的瞬间 `enabled` 翻成 true，面板会从
  // 「未开启」分支切到「已开启」分支；如果向导跟着分支走，它会在这一刻被卸载重建，
  // 刚展示出来的恢复密钥就丢了。
  let body: ReactNode;

  if (!status) {
    // ───── 还没拿到状态 ─────
    body = (
      <SyncRow variant={variant} id="sync-status-loading" label="跨设备同步">
        {statusError ? (
          <div className="space-y-2">
            <Callout tone="error">读取同步状态失败：{statusError}</Callout>
            <SyncButton variant={variant} kind="secondary" onClick={() => void refreshStatus()}>
              重试
            </SyncButton>
          </div>
        ) : (
          <p className="text-meta text-fg-tertiary">正在读取同步状态…</p>
        )}
      </SyncRow>
    );
  } else if (!enabled) {
    // ───── 未开启 ─────
    body = (
      <>
        <SyncRow
          variant={variant}
          id="sync-enable"
          label="跨设备同步"
          description="把连接、设置、快捷命令、技能和 MCP 服务同步到你的其它设备。"
          keywords={['同步', 'sync', 'webdav', '坚果云', '加密', '多设备', '开启同步', '加入同步']}
        >
          <div className="space-y-3">
            {notice && <Callout>{notice}</Callout>}
            <ul className="space-y-2 text-meta leading-relaxed text-fg-secondary">
              <li>端到端加密：数据在你的设备上加密之后才上传，存储方只看得到一堆看不懂的密文。</li>
              <li>数据放在你自己选的地方（WebDAV 网盘，或你自己的服务器），没有我们的服务器。</li>
              <li>开启后可以按需同步对话与记忆、以及密码 / 私钥 / API Key 这类机密，机密档默认关闭。</li>
            </ul>
            <div className="flex flex-wrap gap-2">
              <SyncButton variant={variant} kind="primary" onClick={() => openWizard('create')}>
                开启同步
              </SyncButton>
              <SyncButton variant={variant} kind="secondary" onClick={() => openWizard('join')}>
                加入已有同步
              </SyncButton>
            </div>
          </div>
        </SyncRow>
      </>
    );
  } else {
    // ───── 已开启 ─────
    body = (
      <>
        {status.state === 'needsConfirm' && <SyncHeldBanner variant={variant} held={status.held} />}
        {notice && (
          <div className={variant === 'desktop' ? 'px-6 pt-4' : ''}>
            <Callout>{notice}</Callout>
          </div>
        )}

        <SyncRow
          variant={variant}
          id="sync-status"
          label="同步状态"
          keywords={['同步', 'sync', '立即同步', '状态']}
        >
          <StatusBlock variant={variant} status={status} now={now} />
        </SyncRow>

        <SyncRow
          variant={variant}
          id="sync-scope"
          label="同步范围"
          description="普通配置始终同步；对话与记忆、机密按需开启。"
          keywords={['同步范围', '对话', '记忆', '机密']}
        >
          <ScopeList variant={variant} status={status} />
        </SyncRow>

        <SyncRow
          variant={variant}
          id="sync-add-device"
          label="添加设备"
          description="在新设备上选「加入已有同步」，输入这里的同步码。"
          keywords={['添加设备', '同步码', '二维码', '新设备']}
        >
          <AddDeviceBlock variant={variant} />
        </SyncRow>

        <SyncRow
          variant={variant}
          id="sync-recovery-key"
          label="恢复密钥"
          description="云端数据的解锁钥匙，请妥善保管。"
          keywords={['恢复密钥', '密钥', '备份']}
        >
          <RecoveryKeyBlock variant={variant} />
        </SyncRow>

        <SyncRow
          variant={variant}
          id="sync-device-name"
          label="本设备名称"
          description="在其它设备的设备列表和同步记录里，靠它认出这台设备。"
          keywords={['设备名称', '设备名']}
        >
          <DeviceNameEditor variant={variant} name={status.deviceName ?? ''} />
        </SyncRow>

        <SyncBlock variant={variant} title="已加入同步的设备">
          <DevicesList devices={devices} loading={devicesLoading} error={devicesError} />
        </SyncBlock>

        <SyncBlock
          variant={variant}
          title="同步记录"
          description="其它设备对这台设备做过的改动。不想要的可以撤销。"
        >
          <HistoryList variant={variant} history={history} loading={historyLoading} error={historyError} />
        </SyncBlock>

        <SyncRow
          variant={variant}
          id="sync-stop"
          label="停止同步"
          description="这台设备不再同步，本机现有数据保留。"
          keywords={['停止同步', '关闭同步', '退出同步']}
        >
          <SyncButton variant={variant} kind="danger" onClick={() => setStopOpen(true)}>
            停止同步…
          </SyncButton>
        </SyncRow>

        <SyncStopDialog variant={variant} open={stopOpen} onClose={() => setStopOpen(false)} />
      </>
    );
  }

  return (
    <>
      {body}
      {wizardNode}
    </>
  );
}
