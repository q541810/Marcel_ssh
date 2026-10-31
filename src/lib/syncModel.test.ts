import { describe, expect, it } from 'vitest';
import type { SyncHistoryEntry, SyncStatus } from './types';
import {
  buildStorageConfig,
  buildStorageSecret,
  canSubmitWizard,
  canTestStorage,
  describeHeld,
  describeHistoryEntry,
  describeStorage,
  describeSyncStatus,
  formatRecoveryKey,
  initialWizardState,
  isJianguoyunUrl,
  isPlausibleRecoveryKey,
  isPlausibleSyncCode,
  needsAttention,
  normalizeRecoveryKey,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from './syncModel';

const NOW = new Date('2026-10-29T12:00:00Z');

function status(partial: Partial<SyncStatus>): SyncStatus {
  return {
    enabled: true,
    state: 'idle',
    lastSyncAt: null,
    lastError: null,
    pendingCount: 0,
    deviceId: 'd1',
    deviceName: '我的电脑',
    storage: null,
    held: null,
    tiers: { config: true, conversation: false, secret: false },
    streams: [],
    ...partial,
  };
}

describe('describeSyncStatus', () => {
  it('没开启', () => {
    expect(describeSyncStatus(status({ enabled: false, state: 'off' }), NOW)).toEqual({
      tone: 'off',
      title: '未开启',
      detail: null,
    });
  });

  it('已同步 · 刚刚 / N 分钟前', () => {
    const justNow = describeSyncStatus(status({ lastSyncAt: '2026-10-29T11:59:50Z' }), NOW);
    expect(justNow).toMatchObject({ tone: 'ok', title: '已同步 · 刚刚' });
    const earlier = describeSyncStatus(status({ lastSyncAt: '2026-10-29T11:55:00Z' }), NOW);
    expect(earlier.title).toBe('已同步 · 5 分钟前');
  });

  it('有等待上传的改动时补一句', () => {
    const view = describeSyncStatus(status({ lastSyncAt: '2026-10-29T11:59:50Z', pendingCount: 3 }), NOW);
    expect(view.detail).toBe('还有 3 项改动等待上传');
  });

  it('同步中', () => {
    expect(describeSyncStatus(status({ state: 'syncing' }), NOW)).toMatchObject({ tone: 'busy', title: '同步中…' });
  });

  it('出错：带原因，并说明会自动重试；原因缺失也不至于一片空白', () => {
    const view = describeSyncStatus(status({ state: 'error', lastError: '网络不通' }), NOW);
    expect(view.tone).toBe('error');
    expect(view.detail).toContain('网络不通');
    expect(view.detail).toContain('自动重试');
    expect(describeSyncStatus(status({ state: 'error', lastError: null }), NOW).detail).toContain('原因未知');
  });

  it('需要升级 / 等待确认', () => {
    expect(describeSyncStatus(status({ state: 'needsUpgrade' }), NOW)).toMatchObject({
      tone: 'warn',
      title: '需要升级到新版本',
    });
    expect(describeSyncStatus(status({ state: 'needsConfirm' }), NOW)).toMatchObject({
      tone: 'warn',
      title: '等待你确认',
    });
  });
});

describe('needsAttention', () => {
  it('只有 出错 / 等待确认 / 需要升级 才打扰', () => {
    expect(needsAttention('error')).toBe(true);
    expect(needsAttention('needsConfirm')).toBe(true);
    expect(needsAttention('needsUpgrade')).toBe(true);
    expect(needsAttention('idle')).toBe(false);
    expect(needsAttention('syncing')).toBe(false);
    expect(needsAttention('off')).toBe(false);
    expect(needsAttention(undefined)).toBe(false);
    expect(needsAttention(null)).toBe(false);
  });
});

describe('describeHeld', () => {
  it('按数据源给量词', () => {
    expect(describeHeld([{ source: 'connections', count: 12 }])).toBe('本机一次删除了 12 个连接');
    expect(
      describeHeld([
        { source: 'connections', count: 3 },
        { source: 'quickCommands', count: 5 },
      ]),
    ).toBe('本机一次删除了 3 个连接、5 条快捷命令');
  });

  it('没有要确认的内容返回 null；未知数据源也能说人话', () => {
    expect(describeHeld(null)).toBeNull();
    expect(describeHeld([{ source: 'connections', count: 0 }])).toBeNull();
    expect(describeHeld([{ source: 'foo', count: 2 }])).toContain('2');
  });
});

describe('describeStorage', () => {
  it('WebDAV 只显示主机和目录，不含账号', () => {
    expect(
      describeStorage({ kind: 'webDav', url: 'https://dav.jianguoyun.com/dav/', username: 'me@x.com', root: 'marcel-sync' }),
    ).toBe('WebDAV · dav.jianguoyun.com · marcel-sync');
  });

  it('SFTP 显示连接名；连接被删时明说', () => {
    expect(describeStorage({ kind: 'sftp', connectionId: 'c1', root: 'sync' }, '我的 VPS')).toBe(
      '我的服务器 · 我的 VPS · sync',
    );
    expect(describeStorage({ kind: 'sftp', connectionId: 'c1', root: 'sync' }, undefined)).toContain('已被删除');
    expect(describeStorage(null)).toBe('');
  });
});

describe('describeHistoryEntry', () => {
  function entry(partial: Partial<SyncHistoryEntry>): SyncHistoryEntry {
    return {
      id: 'h1',
      at: '2026-10-29T11:00:00Z',
      deviceName: '手机',
      source: 'settings',
      path: 'fontSize',
      oldValue: '14',
      newValue: '16',
      kind: 'change',
      undone: false,
      ...partial,
    };
  }

  it('认识的设置字段翻成中文，值原样带出', () => {
    const view = describeHistoryEntry(entry({}));
    expect(view).toMatchObject({ sourceLabel: '设置', fieldLabel: '终端字号', oldValue: '14', newValue: '16', scope: null });
  });

  it('不认识的字段原样显示，不乱猜；路径首段重复同步源名时去掉', () => {
    expect(describeHistoryEntry(entry({ path: 'settings/someNewField' })).fieldLabel).toBe('someNewField');
  });

  it('平台前缀翻成范围标签', () => {
    const view = describeHistoryEntry(entry({ path: '@android/mobileBackgroundSettings' }));
    expect(view.scope).toBe('仅手机端');
  });

  it('id 段缩短，JSON 数组形式的路径也能读', () => {
    const view = describeHistoryEntry(
      entry({ source: 'connections', path: JSON.stringify(['items', { id: '3f2a1b9c-0000-4000-8000-123456789abc' }, 'host']) }),
    );
    expect(view.sourceLabel).toBe('连接');
    expect(view.fieldLabel).toBe('items › #3f2a1b › host');
  });

  it('机密记录用中性文案、不显示值', () => {
    const view = describeHistoryEntry(
      entry({
        source: 'secrets',
        path: 'llm_channel_c1',
        label: "模型渠道『DeepSeek』的 API Key 已从另一台设备更新",
        oldValue: 'sk-old-should-not-render',
        newValue: 'sk-new-should-not-render',
      }),
    );
    expect(view.sourceLabel).toBe('机密');
    expect(view.fieldLabel).toBe("模型渠道『DeepSeek』的 API Key 已从另一台设备更新");
    expect(view.hideValues).toBe(true);
  });

  it('机密记录的旧值 / 新值都为空时正常走 label', () => {
    const view = describeHistoryEntry(
      entry({
        source: 'secrets',
        path: 'server_password_c1',
        oldValue: null,
        newValue: null,
        label: '服务器密码已更新',
      }),
    );
    expect(view).toMatchObject({ fieldLabel: '服务器密码已更新', hideValues: true });
  });

  it('二期新增的同步源也有中文名', () => {
    expect(describeHistoryEntry(entry({ source: 'conversations', path: 'conv/abc' })).sourceLabel).toBe('对话');
    expect(describeHistoryEntry(entry({ source: 'memory', path: 'mem/1' })).sourceLabel).toBe('记忆');
  });
});

describe('恢复密钥', () => {
  const KEY = 'abcd2345efgh6789jkmnpqrstuvwxyz2';

  it('规范化：忽略 - 空白 大小写', () => {
    expect(normalizeRecoveryKey('ABCD-2345 efgh\n6789-JKMN-PQRS-TUVW-XYZ2')).toBe(KEY);
  });

  it('合法性：32 位、只含约定字符集', () => {
    expect(KEY).toHaveLength(32);
    expect(isPlausibleRecoveryKey(KEY)).toBe(true);
    expect(isPlausibleRecoveryKey(formatRecoveryKey(KEY))).toBe(true);
    expect(isPlausibleRecoveryKey(KEY.slice(1))).toBe(false); // 少一位
    expect(isPlausibleRecoveryKey(`${KEY}2`)).toBe(false); // 多一位
    expect(isPlausibleRecoveryKey(`o${KEY.slice(1)}`)).toBe(false); // 字符集里没有 o（易混字符）
    expect(isPlausibleRecoveryKey(`1${KEY.slice(1)}`)).toBe(false);
    expect(isPlausibleRecoveryKey('')).toBe(false);
  });

  it('分组显示：4 个一组；不合法就原样返回', () => {
    expect(formatRecoveryKey(KEY)).toBe('abcd-2345-efgh-6789-jkmn-pqrs-tuvw-xyz2');
    expect(formatRecoveryKey('abc')).toBe('abc');
  });
});

describe('同步码', () => {
  it('前缀 + 足够长才算像样', () => {
    expect(isPlausibleSyncCode('MSYNC1-' + 'a'.repeat(40))).toBe(true);
    expect(isPlausibleSyncCode('  MSYNC1-' + 'a'.repeat(40) + '\n')).toBe(true);
    expect(isPlausibleSyncCode('MSYNC1-abc')).toBe(false);
    expect(isPlausibleSyncCode('hello world, this is long enough but wrong')).toBe(false);
    expect(isPlausibleSyncCode('')).toBe(false);
  });
});

describe('isJianguoyunUrl', () => {
  it('认出坚果云地址', () => {
    expect(isJianguoyunUrl('https://dav.jianguoyun.com/dav/')).toBe(true);
    expect(isJianguoyunUrl('https://cloud.example.com/remote.php/dav')).toBe(false);
  });
});

describe('向导状态机', () => {
  function run(state: WizardState, ...actions: WizardAction[]): WizardState {
    return actions.reduce(wizardReducer, state);
  }
  const filledWebDav: WizardAction[] = [
    { type: 'setWebDav', patch: { url: ' https://dav.jianguoyun.com/dav/ ', username: ' me@x.com ', password: 'app-pass' } },
  ];

  it('开启：存储信息填全并"测试连接"通过之前不能开启', () => {
    let state = initialWizardState('create');
    expect(canSubmitWizard(state)).toBe(false);
    state = run(state, ...filledWebDav);
    expect(canTestStorage(state)).toBe(true);
    expect(canSubmitWizard(state)).toBe(false); // 还没测试
    state = run(state, { type: 'testStart' });
    expect(canSubmitWizard(state)).toBe(false);
    state = run(state, { type: 'testOk' });
    expect(canSubmitWizard(state)).toBe(true);
  });

  it('测试通过后再改任何存储输入，上一次的结论作废', () => {
    let state = run(initialWizardState('create'), ...filledWebDav, { type: 'testOk' });
    expect(state.test.status).toBe('ok');
    state = run(state, { type: 'setWebDav', patch: { root: 'other' } });
    expect(state.test.status).toBe('idle');
    expect(canSubmitWizard(state)).toBe(false);
    state = run(state, { type: 'testOk' }, { type: 'setStorageKind', kind: 'sftp' });
    expect(state.test.status).toBe('idle');
  });

  it('测试失败带上原因；再次修改后清掉', () => {
    let state = run(initialWizardState('create'), ...filledWebDav, { type: 'testFail', message: '账号或密码不对' });
    expect(state.test).toEqual({ status: 'failed', message: '账号或密码不对' });
    state = run(state, { type: 'setWebDav', patch: { password: 'x' } });
    expect(state.test).toEqual({ status: 'idle', message: null });
  });

  it('构造存储配置：去首尾空白，目录为空用默认', () => {
    const state = run(initialWizardState('create'), ...filledWebDav, { type: 'setWebDav', patch: { root: '  ' } });
    expect(buildStorageConfig(state)).toEqual({
      kind: 'webDav',
      url: 'https://dav.jianguoyun.com/dav/',
      username: 'me@x.com',
      root: 'marcel-sync',
    });
    expect(buildStorageSecret(state)).toBe('app-pass');
  });

  it('WebDAV 地址必须是 http(s)；缺账号 / 缺密码都不能测试', () => {
    const base = initialWizardState('create');
    expect(buildStorageConfig(run(base, { type: 'setWebDav', patch: { url: 'dav.example.com', username: 'a', password: 'b' } }))).toBeNull();
    expect(canTestStorage(run(base, { type: 'setWebDav', patch: { url: 'https://x.y/', username: '', password: 'b' } }))).toBe(false);
    expect(canTestStorage(run(base, { type: 'setWebDav', patch: { url: 'https://x.y/', username: 'a', password: '' } }))).toBe(false);
  });

  it('SFTP：选了服务器才能测试，不需要密码；secret 为 null', () => {
    let state = run(initialWizardState('create'), { type: 'setStorageKind', kind: 'sftp' });
    expect(canTestStorage(state)).toBe(false);
    state = run(state, { type: 'setSftp', patch: { connectionId: 'conn-1' } });
    expect(canTestStorage(state)).toBe(true);
    expect(buildStorageConfig(state)).toEqual({ kind: 'sftp', connectionId: 'conn-1', root: 'marcel-sync' });
    expect(buildStorageSecret(state)).toBeNull();
  });

  it('加入（同步码）：粘贴像样的同步码即可，不需要测试连接', () => {
    let state = initialWizardState('join');
    expect(canSubmitWizard(state)).toBe(false);
    state = run(state, { type: 'setSyncCode', value: `MSYNC1-${'a'.repeat(40)}` });
    expect(canSubmitWizard(state)).toBe(true);
  });

  it('加入（手动）：存储填全 + 恢复密钥合法；不强制先测试', () => {
    let state = run(initialWizardState('join'), { type: 'setJoinMethod', method: 'manual' }, ...filledWebDav);
    expect(canSubmitWizard(state)).toBe(false);
    state = run(state, { type: 'setRecoveryKey', value: 'abcd-2345-efgh-6789-jkmn-pqrs-tuvw-xyz2' });
    expect(canSubmitWizard(state)).toBe(true);
    state = run(state, { type: 'setRecoveryKey', value: 'abcd-2345' });
    expect(canSubmitWizard(state)).toBe(false);
  });

  it('提交中不能重复提交；失败后可以改了再来', () => {
    let state = run(initialWizardState('join'), { type: 'setSyncCode', value: `MSYNC1-${'a'.repeat(40)}` });
    state = run(state, { type: 'submitStart' });
    expect(canSubmitWizard(state)).toBe(false);
    state = run(state, { type: 'submitFail', message: '恢复密钥不对' });
    expect(state.submit).toEqual({ status: 'failed', message: '恢复密钥不对' });
    expect(canSubmitWizard(state)).toBe(true);
    state = run(state, { type: 'setSyncCode', value: `MSYNC1-${'b'.repeat(40)}` });
    expect(state.submit.status).toBe('idle');
  });

  it('创建成功：拿到恢复密钥，"已妥善保存"默认没勾', () => {
    let state = run(initialWizardState('create'), { type: 'submitStart' });
    state = run(state, { type: 'created', recoveryKey: 'k', syncCode: 'c' });
    expect(state.created).toEqual({ recoveryKey: 'k', syncCode: 'c' });
    expect(state.acknowledged).toBe(false);
    state = run(state, { type: 'acknowledge', value: true });
    expect(state.acknowledged).toBe(true);
  });

  it('reset 回到干净状态：密码、恢复密钥不留', () => {
    const state = run(
      initialWizardState('create'),
      ...filledWebDav,
      { type: 'created', recoveryKey: 'k', syncCode: 'c' },
      { type: 'reset', mode: 'join' },
    );
    expect(state).toEqual(initialWizardState('join'));
  });
});
