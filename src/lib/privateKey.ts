import { parseAppError } from '@/lib/errors';
import * as tauri from '@/lib/tauri';
import type { SavedConnection } from '@/lib/types';

/**
 * 私钥连接的判断与展示口径，桌面与移动端共用（两处各写一套必然走样）。
 *
 * 这一层的存在是为了修掉一个具体的坑：以前**任何**私钥失败都会弹「私钥密码」框，
 * 于是"密钥文件根本不存在"也会追问密码，用户输完还是失败。现在后端把原因分成了
 * 结构化的 code（`AppError::KeyAuth`），前端只对真正需要密码的那两种追问。
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
