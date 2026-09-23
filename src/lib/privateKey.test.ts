import { describe, it, expect } from 'vitest';
import {
  describeAlgorithm,
  isPassphraseProblem,
  isPasswordRejected,
  keyAuthCode,
  shortFingerprint,
} from './privateKey';

/**
 * 后端源码。用 vite 的 raw glob 读原文做文本比对（与 `turnState.test.ts` /
 * `disposition.test.ts` 同一手法，测试里不引 node API）：
 * - `error.rs`：`KeyAuthCode` 变体与序列化写法（决定 data.code 的字符串）
 * - `ssh/key_store.rs`：`StoredKeyMeta` 字段名（决定 IPC 上的 camelCase 名）
 * - `ssh/key_material.rs`：哪些情况产出"需要密码"这个判定
 * - `ssh/manager.rs`：认证失败时产出哪个原因码（密码被拒也要结构化，否则前端无从复问）
 */
const RUST = import.meta.glob(
  [
    '/src-tauri/src/error.rs',
    '/src-tauri/src/ssh/key_store.rs',
    '/src-tauri/src/ssh/key_material.rs',
    '/src-tauri/src/ssh/manager.rs',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const errorRs = RUST['/src-tauri/src/error.rs'] ?? '';
const keyStoreRs = RUST['/src-tauri/src/ssh/key_store.rs'] ?? '';
const keyMaterialRs = RUST['/src-tauri/src/ssh/key_material.rs'] ?? '';
const managerRs = RUST['/src-tauri/src/ssh/manager.rs'] ?? '';

/** 去掉空白再比对：断的是"结构在不在"，不是排版。 */
function flat(src: string): string {
  return src.replace(/\s+/g, ' ');
}

/** 抽 `pub enum <name> { … }` 里的变体名（每个变体独占一行）。 */
function parseEnumVariants(src: string, enumName: string): string[] {
  const start = src.indexOf(`pub enum ${enumName} {`);
  expect(start, `找不到 \`pub enum ${enumName}\``).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  const variants: string[] = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^\s{4}([A-Z][A-Za-z0-9]*),?\s*$/);
    if (match) variants.push(match[1]);
  }
  return variants;
}

/** Rust snake_case 字段名 → IPC 上的 camelCase 名。 */
function toCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

describe('私钥失败原因的判定', () => {
  it('只对"缺密码 / 密码错"追问，其他原因不追问', () => {
    const keyAuth = (code: string) => ({ kind: 'KeyAuth', message: 'x', data: { code } });

    expect(isPassphraseProblem(keyAuth('needs_passphrase'))).toBe(true);
    expect(isPassphraseProblem(keyAuth('bad_passphrase'))).toBe(true);

    // 这几类追问密码是没意义的——用户照着提示也做不对下一步
    expect(isPassphraseProblem(keyAuth('key_not_found'))).toBe(false);
    expect(isPassphraseProblem(keyAuth('key_unreadable'))).toBe(false);
    expect(isPassphraseProblem(keyAuth('unsupported_key'))).toBe(false);
    expect(isPassphraseProblem(keyAuth('key_missing_from_store'))).toBe(false);
    expect(isPassphraseProblem(keyAuth('rejected'))).toBe(false);
  });

  it('非私钥错误、裸字符串、Error 都不算密码问题', () => {
    expect(isPassphraseProblem({ kind: 'Ssh', message: 'boom' })).toBe(false);
    expect(isPassphraseProblem('boom')).toBe(false);
    expect(isPassphraseProblem(new Error('boom'))).toBe(false);
    expect(isPassphraseProblem(undefined)).toBe(false);
    // 有 kind 但没有 code：不能因为 kind 对就当密码问题
    expect(isPassphraseProblem({ kind: 'KeyAuth', message: 'x' })).toBe(false);
  });

  it('keyAuthCode 只认自己的 kind', () => {
    expect(keyAuthCode({ kind: 'KeyAuth', message: 'x', data: { code: 'rejected' } })).toBe(
      'rejected',
    );
    expect(keyAuthCode({ kind: 'Ssh', message: 'x' })).toBeNull();
    expect(keyAuthCode({ kind: 'KeyAuth', message: 'x' })).toBeNull();
  });
});

/**
 * 密码被服务器拒绝 = 密钥链里那份密码是错的，唯一该重新追问的情况。
 *
 * 判据只认 `rejected` 这一档：`needs_passphrase` / `bad_passphrase` 是私钥那条流程的，
 * 而网络不通、主机密钥变更这些原因重新要密码没用（用户照着提示也做不对下一步）。
 */
describe('密码被拒的判定', () => {
  it('只对"服务器拒绝了这份凭据"为真', () => {
    const keyAuth = (code: string) => ({ kind: 'KeyAuth', message: 'x', data: { code } });

    expect(isPasswordRejected(keyAuth('rejected'))).toBe(true);

    // 私钥流程那两档：密码框不该被它们触发
    expect(isPasswordRejected(keyAuth('needs_passphrase'))).toBe(false);
    expect(isPasswordRejected(keyAuth('bad_passphrase'))).toBe(false);
    // 与密码无关的失败
    expect(isPasswordRejected(keyAuth('key_not_found'))).toBe(false);
    expect(isPasswordRejected(keyAuth('unsupported_key'))).toBe(false);
  });

  it('非结构化错误（网络错误、裸字符串）一律不追问', () => {
    expect(isPasswordRejected({ kind: 'Ssh', message: '连接失败: Network is unreachable' })).toBe(
      false,
    );
    expect(isPasswordRejected('boom')).toBe(false);
    expect(isPasswordRejected(new Error('boom'))).toBe(false);
    expect(isPasswordRejected(undefined)).toBe(false);
    // 有 kind 但没有 code：不能因为 kind 对就当密码问题
    expect(isPasswordRejected({ kind: 'KeyAuth', message: 'x' })).toBe(false);
  });
});

describe('密钥信息的展示', () => {
  it('指纹截断到够辨认的长度且保留算法前缀', () => {
    const short = shortFingerprint('SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd');
    expect(short).toBe('SHA256:AbCdEfGhIj');
    // 没有前缀时按 SHA256 兜底，不能把整串吐出去
    expect(shortFingerprint('AbCdEfGhIjKl')).toBe('SHA256:AbCdEfGhIj');
  });

  it('算法名给成人话，认不出的照原样显示', () => {
    expect(describeAlgorithm('ssh-ed25519')).toBe('Ed25519');
    expect(describeAlgorithm('ssh-rsa')).toBe('RSA');
    expect(describeAlgorithm('ecdsa-sha2-nistp256')).toBe('ECDSA nistp256');
    expect(describeAlgorithm('ssh-whatever')).toBe('ssh-whatever');
  });
});

describe('与后端的契约', () => {
  it('后端源码能被读到（防止 glob 写错后整组测试空转）', () => {
    expect(errorRs.length).toBeGreaterThan(0);
    expect(keyStoreRs.length).toBeGreaterThan(0);
    expect(keyMaterialRs.length).toBeGreaterThan(0);
    expect(managerRs.length).toBeGreaterThan(0);
  });

  it('前端追问密码用到的两个 code 在后端确实存在，且按 snake_case 序列化', () => {
    const variants = parseEnumVariants(errorRs, 'KeyAuthCode');
    expect(variants.length).toBeGreaterThan(0);
    expect(variants).toContain('NeedsPassphrase');
    expect(variants).toContain('BadPassphrase');

    // 变体名 → 线上字符串（snake_case）的依据
    const enumStart = errorRs.indexOf('pub enum KeyAuthCode {');
    const header = errorRs.slice(Math.max(0, enumStart - 200), enumStart);
    expect(header).toContain('#[serde(rename_all = "snake_case")]');

    // 前端 set 里那两个字面量必须就是后端会发出来的字符串
    // （Rust 的 snake_case 规则：小写/数字后跟大写才插下划线）
    const snake = (v: string) =>
      v.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    expect(snake('NeedsPassphrase')).toBe('needs_passphrase');
    expect(snake('BadPassphrase')).toBe('bad_passphrase');
  });

  it('错误对象把原因码放在 data.code 上（前端的读取路径）', () => {
    // 前端读的是 parsed.data.code；后端序列化时若改名，这里会红
    expect(errorRs).toContain('AppError::KeyAuth { code, .. }');
    expect(errorRs).toContain('"code": code');
  });

  it('密码认证被拒也带原因码（否则前端只能把那份错密码一直重放）', () => {
    // 密码分支若退回 AppError::Ssh("认证失败：…") 这种纯字符串，前端就再也认不出
    // "该重新追问密码"，本组测试与 ConnectionList / MobileConnectionList 的复问一起红
    expect(flat(managerRs)).toContain(
      'AuthMethod::Password { .. } => AppError::KeyAuth { code: KeyAuthCode::Rejected',
    );
  });

  it('带跳板机时原因码要活着到前端（只改写文案，不压成字符串）', () => {
    // 目标机那一段的错误会被 map_target_err 加上「目标服务器 x」的前缀；连原因码一起
    // 压成 AppError::Ssh 就等于把复问的机会丢掉（私钥的复问也一样会失效）
    expect(flat(managerRs)).toContain(
      'AppError::KeyAuth { code, message } if via_jump => AppError::KeyAuth { code,',
    );
  });

  it('"需要密码"这个判定确实由加密检测产出（前端据此不再盲试）', () => {
    expect(keyMaterialRs).toContain('KeyAuthCode::NeedsPassphrase');
    expect(keyMaterialRs).toContain('KeyAuthCode::BadPassphrase');
  });

  it('StoredKeyMeta 的字段在 TS 类型里按 camelCase 逐一存在', () => {
    const start = keyStoreRs.indexOf('pub struct StoredKeyMeta {');
    expect(start, '找不到 `pub struct StoredKeyMeta`').toBeGreaterThan(-1);
    const body = keyStoreRs.slice(start, keyStoreRs.indexOf('\n}', start));
    const fields: string[] = [];
    for (const line of body.split('\n')) {
      const match = line.match(/^\s{4}pub ([a-z][a-z0-9_]*):/);
      if (match) fields.push(match[1]);
    }
    expect(fields.length).toBeGreaterThan(0);

    // 从后端源头构造 camelCase 名，再要求它们出现在前端类型定义里
    const typesSource = frontendTypesSource();
    for (const field of fields) {
      expect(
        typesSource.includes(`${toCamel(field)}`),
        `前端 StoredKeyMeta 缺少字段 ${toCamel(field)}（后端有 ${field}）`,
      ).toBe(true);
    }
  });
});

/**
 * 前端类型源码。后端加了字段、前端没跟上，上面那条断言就红；
 * 单独抽出来只是为了让断言读起来是一句完整的话。
 */
function frontendTypesSource(): string {
  const TYPES = import.meta.glob(['/src/lib/types.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const source = TYPES['/src/lib/types.ts'] ?? '';
  expect(source.length).toBeGreaterThan(0);
  return source;
}
