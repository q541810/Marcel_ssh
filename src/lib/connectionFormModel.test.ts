import { describe, expect, it } from 'vitest';
import {
  buildSavedConnection,
  keyUsageCount,
  parsePortInput,
  secretSaveFailedMessage,
  shouldResetPortOnBlur,
  validateConnectionForm,
} from '@/lib/connectionFormModel';
import type { SavedConnection } from '@/lib/types';

/** 一份能通过校验的完整表单值，各用例在其上覆盖差异字段。 */
const validValues = {
  name: '生产机',
  host: '10.0.0.1',
  username: 'root',
  port: 22,
  authMethod: 'Password',
  keyId: '',
  keyPath: '',
  group: '',
  useJump: false,
  jumpHost: '',
  jumpUsername: '',
  jumpPort: 22,
  jumpAuthMethod: 'withTarget' as const,
  jumpKeyId: '',
  jumpKeyPath: '',
  jumpPassword: '',
  hasJumpPassword: false,
};

describe('validateConnectionForm', () => {
  it('合法表单返回空错误表', () => {
    expect(validateConnectionForm(validValues)).toEqual({});
  });

  it('名称 / 主机 / 用户名为必填', () => {
    const errors = validateConnectionForm({
      ...validValues,
      name: '  ',
      host: '',
      username: '',
    });
    expect(errors.name).toBe('名称为必填项');
    expect(errors.host).toBe('主机为必填项');
    expect(errors.username).toBe('用户名为必填项');
  });

  it('端口越界（0 与 65536）报 1-65535', () => {
    expect(validateConnectionForm({ ...validValues, port: 0 }).port).toBe(
      '端口必须在 1-65535 之间',
    );
    expect(validateConnectionForm({ ...validValues, port: 65536 }).port).toBe(
      '端口必须在 1-65535 之间',
    );
    expect(validateConnectionForm({ ...validValues, port: 65535 }).port).toBeUndefined();
  });

  it('私钥认证：密钥库 id 与手填路径二选一', () => {
    const errors = validateConnectionForm({
      ...validValues,
      authMethod: 'PrivateKey',
    });
    expect(errors.keyPath).toBe('请选择或导入一把私钥');
    expect(
      validateConnectionForm({
        ...validValues,
        authMethod: 'PrivateKey',
        keyId: 'k1',
      }).keyPath,
    ).toBeUndefined();
    expect(
      validateConnectionForm({
        ...validValues,
        authMethod: 'PrivateKey',
        keyPath: ' ~/.ssh/id_rsa ',
      }).keyPath,
    ).toBeUndefined();
  });

  it('跳板机五条校验：主机 / 用户名 / 端口 / 私钥 / 密码', () => {
    const errors = validateConnectionForm({
      ...validValues,
      useJump: true,
      jumpHost: '',
      jumpUsername: '',
      jumpPort: 0,
      jumpAuthMethod: 'PrivateKey',
      jumpKeyId: '',
      jumpKeyPath: '',
    });
    expect(errors.jumpHost).toBe('跳板机主机为必填项');
    expect(errors.jumpUsername).toBe('跳板机用户名为必填项');
    expect(errors.jumpPort).toBe('端口必须在 1-65535 之间');
    expect(errors.jumpKeyPath).toBe('请选择或导入跳板机的私钥');
  });

  it('跳板机密码认证：本次没填且以前也没存过才算缺', () => {
    const base = {
      ...validValues,
      useJump: true,
      jumpHost: 'bastion',
      jumpUsername: 'jump',
      jumpAuthMethod: 'Password' as const,
    };
    expect(validateConnectionForm(base).jumpPassword).toBe('请填写跳板机密码');
    expect(
      validateConnectionForm({ ...base, hasJumpPassword: true }).jumpPassword,
    ).toBeUndefined();
    expect(
      validateConnectionForm({ ...base, jumpPassword: 'pw' }).jumpPassword,
    ).toBeUndefined();
  });

  it('跳板机关闭时不校验任何 jump 字段', () => {
    const errors = validateConnectionForm({
      ...validValues,
      useJump: false,
      jumpHost: '',
      jumpUsername: '',
      jumpPort: 0,
    });
    expect(errors.jumpHost).toBeUndefined();
    expect(errors.jumpPort).toBeUndefined();
  });
});

describe('buildSavedConnection', () => {
  it('新建连接生成新 id；编辑连接继承 id 与 lastConnected', () => {
    const fresh = buildSavedConnection({ ...validValues, name: ' a ' });
    expect(fresh.id).toMatch(/[0-9a-f-]{36}/);
    expect(fresh.name).toBe('a');

    const existing: SavedConnection = {
      id: 'c1',
      name: '旧名',
      host: 'h',
      port: 1,
      username: 'u',
      authMethod: 'Password',
      lastConnected: '2026-01-01T00:00:00Z',
    };
    const edited = buildSavedConnection({
      ...validValues,
      existing,
      name: '新名',
    });
    expect(edited.id).toBe('c1');
    expect(edited.lastConnected).toBe('2026-01-01T00:00:00Z');
  });

  it('密码认证：keyPath / keyId 一律缺省', () => {
    const saved = buildSavedConnection({
      ...validValues,
      authMethod: 'Password',
      keyId: '',
      keyPath: '/tmp/key',
    });
    expect(saved.keyId).toBeUndefined();
    expect(saved.keyPath).toBeUndefined();
  });

  it('私钥认证：选了密钥库就丢路径，没选就保留 trim 后的路径', () => {
    const withKey = buildSavedConnection({
      ...validValues,
      authMethod: 'PrivateKey',
      keyId: 'k1',
      keyPath: '/tmp/key',
    });
    expect(withKey.keyId).toBe('k1');
    expect(withKey.keyPath).toBeUndefined();

    const withPath = buildSavedConnection({
      ...validValues,
      authMethod: 'PrivateKey',
      keyId: '',
      keyPath: ' ~/.ssh/id_rsa ',
    });
    expect(withPath.keyId).toBeUndefined();
    expect(withPath.keyPath).toBe('~/.ssh/id_rsa');
  });

  it('分组 trim 后为空 = 未分组（缺省）', () => {
    expect(
      buildSavedConnection({ ...validValues, group: ' 生产 ' }).group,
    ).toBe('生产');
    expect(buildSavedConnection({ ...validValues, group: '   ' }).group).toBeUndefined();
  });

  it('跳板机关闭：所有 jump 字段缺省，不留残值', () => {
    const saved = buildSavedConnection({
      ...validValues,
      useJump: false,
      jumpHost: 'bastion',
      jumpPort: 2222,
      jumpUsername: 'jump',
      jumpAuthMethod: 'PrivateKey',
      jumpKeyId: 'k9',
      jumpKeyPath: '/k',
    });
    expect(saved.useJump).toBe(false);
    expect(saved.jumpHost).toBeUndefined();
    expect(saved.jumpPort).toBeUndefined();
    expect(saved.jumpUsername).toBeUndefined();
    expect(saved.jumpAuthMethod).toBeUndefined();
    expect(saved.jumpKeyId).toBeUndefined();
    expect(saved.jumpKeyPath).toBeUndefined();
  });

  it('跳板机 withTarget：只记主机三元组，不记私钥字段', () => {
    const saved = buildSavedConnection({
      ...validValues,
      useJump: true,
      jumpHost: ' bastion ',
      jumpPort: 2222,
      jumpUsername: ' jump ',
      jumpAuthMethod: 'withTarget',
      jumpKeyId: 'k9',
    });
    expect(saved.jumpHost).toBe('bastion');
    expect(saved.jumpPort).toBe(2222);
    expect(saved.jumpUsername).toBe('jump');
    expect(saved.jumpAuthMethod).toBe('withTarget');
    expect(saved.jumpKeyId).toBeUndefined();
    expect(saved.jumpKeyPath).toBeUndefined();
  });

  it('跳板机私钥：与主连接同一套「选库丢路径」派生', () => {
    const withKey = buildSavedConnection({
      ...validValues,
      useJump: true,
      jumpHost: 'bastion',
      jumpUsername: 'jump',
      jumpAuthMethod: 'PrivateKey',
      jumpKeyId: 'k9',
      jumpKeyPath: '/k',
    });
    expect(withKey.jumpKeyId).toBe('k9');
    expect(withKey.jumpKeyPath).toBeUndefined();

    const withPath = buildSavedConnection({
      ...validValues,
      useJump: true,
      jumpHost: 'bastion',
      jumpUsername: 'jump',
      jumpAuthMethod: 'PrivateKey',
      jumpKeyId: '',
      jumpKeyPath: ' /home/me/key ',
    });
    expect(withPath.jumpKeyId).toBeUndefined();
    expect(withPath.jumpKeyPath).toBe('/home/me/key');
  });
});

describe('keyUsageCount', () => {
  const conns: SavedConnection[] = [
    { id: 'a', name: 'a', host: 'h', port: 22, username: 'u', authMethod: 'PrivateKey', keyId: 'k1' },
    { id: 'b', name: 'b', host: 'h', port: 22, username: 'u', authMethod: 'Password', useJump: true, jumpKeyId: 'k1' },
    { id: 'c', name: 'c', host: 'h', port: 22, username: 'u', authMethod: 'Password', useJump: true, jumpKeyId: 'k2' },
    { id: 'd', name: 'd', host: 'h', port: 22, username: 'u', authMethod: 'Password' },
  ];

  it('主连接私钥与跳板机私钥都计数', () => {
    expect(keyUsageCount(conns, 'k1')).toBe(2);
    expect(keyUsageCount(conns, 'k2')).toBe(1);
    expect(keyUsageCount(conns, 'ghost')).toBe(0);
  });

  it('useJump 为假时 jumpKeyId 不计数（老数据无此字段）', () => {
    expect(keyUsageCount([{ ...conns[2], useJump: false }], 'k2')).toBe(0);
  });
});

describe('parsePortInput / shouldResetPortOnBlur', () => {
  it('onChange 规则：正整数才采纳，越界值也先放行（保存时校验拦）', () => {
    expect(parsePortInput('22')).toBe(22);
    expect(parsePortInput('65535')).toBe(65535);
    expect(parsePortInput('65536')).toBe(65536);
    expect(parsePortInput('22abc')).toBe(22);
    expect(parsePortInput('0')).toBeNull();
    expect(parsePortInput('-5')).toBeNull();
    expect(parsePortInput('abc')).toBeNull();
    expect(parsePortInput('')).toBeNull();
  });

  it('onBlur 规则：只有完全不是数字（或为空）才回落默认端口', () => {
    expect(shouldResetPortOnBlur('')).toBe(true);
    expect(shouldResetPortOnBlur('abc')).toBe(true);
    // 「0」「-5」「22abc」能解析出数字：保留用户输入，交由保存校验拦截
    expect(shouldResetPortOnBlur('0')).toBe(false);
    expect(shouldResetPortOnBlur('-5')).toBe(false);
    expect(shouldResetPortOnBlur('22abc')).toBe(false);
    expect(shouldResetPortOnBlur('22')).toBe(false);
  });
});

describe('secretSaveFailedMessage', () => {
  const err = { kind: 'Config', message: 'access denied' };

  it('form 变体：不提「本次连接照常进行」', () => {
    const text = secretSaveFailedMessage('凭证', err, 'form');
    expect(text).toBe(
      '凭证没能保存到本设备（access denied）。下次连接和「重连」还得再输一次。',
    );
  });

  it('connect 变体：多说一句「本次连接照常进行」', () => {
    const text = secretSaveFailedMessage('密码', err, 'connect');
    expect(text).toBe(
      '密码没能保存到本设备（access denied）。本次连接照常进行，但下次连接和「重连」还得再输一次。',
    );
  });

  it('两个变体只差「本次连接照常进行，但」这一句', () => {
    const form = secretSaveFailedMessage('密钥密码', err, 'form');
    const connect = secretSaveFailedMessage('密钥密码', err, 'connect');
    expect(connect).toBe(form.replace('）。下次', '）。本次连接照常进行，但下次'));
  });
});
