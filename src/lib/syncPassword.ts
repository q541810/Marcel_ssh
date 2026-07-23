/** 账户密码规则（与 Rust crypto::MIN_ACCOUNT_PASSWORD_LEN 对齐） */
export const MIN_SYNC_ACCOUNT_PASSWORD_LEN = 8;

/** 新账户：校验密码与确认密码。返回错误文案，通过则 null。 */
export function validateNewAccountPassword(
  password: string,
  confirm: string,
): string | null {
  const len = [...password].length;
  if (len < MIN_SYNC_ACCOUNT_PASSWORD_LEN) {
    return `账户密码至少 ${MIN_SYNC_ACCOUNT_PASSWORD_LEN} 位`;
  }
  if (password !== confirm) {
    return '两次输入的密码不一致';
  }
  return null;
}
