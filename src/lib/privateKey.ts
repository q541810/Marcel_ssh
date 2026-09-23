import { parseAppError } from '@/lib/errors';
import * as tauri from '@/lib/tauri';
import type { SavedConnection } from '@/lib/types';

/**
 * 后端"认证失败原因码"的判断口径，桌面与移动端共用（两处各写一套必然走样）。
 *
 * 这一层的存在是为了修掉一个具体的坑：以前**任何**私钥失败都会弹「私钥密码」框，
 * 于是"密钥文件根本不存在"也会追问密码，用户输完还是失败。现在后端把原因分成了
 * 结构化的 code（`AppError::KeyAuth`），前端只对真正需要密码的那两种追问。
 *
 * 密码认证走的是**同一个**原因码通道（`KeyAuthCode::Rejected`）：在私钥流程里它表示
 * "这把密钥被服务器拒了"，在密码流程里表示"这份密码被服务器拒了"。两条流程各自只问
 * 自己该问的——见 `isPassphraseProblem` 与 `isPasswordRejected`。
 */

/** 后端 `KeyAuthCode` 里"该向用户要密码"的两种（其余都是别的问题）。 */
const PASSPHRASE_CODES = new Set(['needs_passphrase', 'bad_passphrase']);

/** 取错误里的私钥原因码；不是私钥错误则返回 null。 */
export function keyAuthCode(err: unknown): string | null {
  const parsed = parseAppError(err);
  if (parsed.kind !== 'KeyAuth') return null;
  const code = parsed.data?.code;
  return typeof code === 'string' ? code : null;
}

/** 这次失败是不是"密码问题"——决定要不要弹密码框的唯一判据。 */
export function isPassphraseProblem(err: unknown): boolean {
  const code = keyAuthCode(err);
  return code !== null && PASSPHRASE_CODES.has(code);
}

/** 失败的是不是私钥相关（无论哪种原因），用于选择提示措辞。 */
export function isKeyAuthProblem(err: unknown): boolean {
  return keyAuthCode(err) !== null;
}

/**
 * 这次失败是不是"密钥链里存着的那份密码被服务器拒了"——密码流程里唯一该重新追问的情况。
 *
 * 用 `rejected` 这一档（后端 `KeyAuthCode::Rejected` = 服务器拒绝了这份凭据）。只有先
 * 知道是"密码不对"，才敢把浮层再弹一次；网络不通、主机密钥变更这些原因重新要密码是没用的，
 * 用户照着提示也做不对下一步。复问时输入的新密码会覆盖密钥链里那份错的（`savePassword`），
 * 所以打错一个字符不会再把这份错密码永久固化下去。
 *
 * 只在密码认证流程里调用：同一个码在私钥流程里表示"密钥被拒"，那边由
 * `isPassphraseProblem` 负责。
 */
export function isPasswordRejected(err: unknown): boolean {
  return keyAuthCode(err) === 'rejected';
}

/**
 * 这条连接用的私钥是否带密码。
 *
 * 只有从密钥库导入的私钥才"已知"；手填路径的老连接返回 false，此时流程会先不带
 * 密码连一次，由后端明确回报"需要密码"再追问——那一次尝试是有依据的，不是盲试。
 */
export async function keyNeedsPassphrase(
  connection: SavedConnection,
): Promise<boolean> {
  const keyId = connection.keyId;
  if (!keyId) return false;
  try {
    const keys = await tauri.listKeys();
    return keys.some((k) => k.id === keyId && k.encrypted);
  } catch {
    return false;
  }
}

/** 指纹的展示形式：`SHA256:AbCdEf…` 只留前 10 位，够辨认又不占地方。 */
export function shortFingerprint(fingerprint: string): string {
  const separator = fingerprint.indexOf(':');
  if (separator < 0) return `SHA256:${fingerprint.slice(0, 10)}`;
  return `${fingerprint.slice(0, separator)}:${fingerprint.slice(
    separator + 1,
    separator + 11,
  )}`;
}

/** 密钥算法 → 人话。 */
export function describeAlgorithm(algorithm: string): string {
  switch (algorithm) {
    case 'ssh-ed25519':
      return 'Ed25519';
    case 'ssh-rsa':
      return 'RSA';
    case 'ecdsa-sha2-nistp256':
    case 'ecdsa-sha2-nistp384':
    case 'ecdsa-sha2-nistp521':
      return `ECDSA ${algorithm.slice('ecdsa-sha2-'.length)}`;
    default:
      return algorithm;
  }
}
