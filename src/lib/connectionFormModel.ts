import type { JumpAuthMethod, SavedConnection } from '@/lib/types';
import { getErrorMessage } from '@/lib/errors';

/**
 * 连接表单的纯逻辑（桌面 ConnectionForm / 移动 MobileConnectionForm 共用）。
 *
 * 这里只放「算什么」：校验规则、保存时派生哪些字段、端口输入怎么解析。**「怎么
 * 渲染」「状态放哪」留在各自组件**——两端 UI 形态不同（桌面 Modal + Input 组件、
 * 移动 MobileSheet + 原生 input），共享的只是这张表单背后的数据模型。
 */

/** 表单里参与校验的那部分字段（两端组件的 useState 同名同义）。 */
export interface ConnectionFormValues {
  name: string;
  host: string;
  username: string;
  port: number;
  authMethod: string;
  keyId: string;
  keyPath: string;
  useJump: boolean;
  jumpHost: string;
  jumpUsername: string;
  jumpPort: number;
  jumpAuthMethod: JumpAuthMethod;
  jumpKeyId: string;
  jumpKeyPath: string;
  jumpPassword: string;
  /** 编辑模式下跳板机密码是否已存过（存过则留空 = 保持不变） */
  hasJumpPassword: boolean;
}

/**
 * 校验连接表单，返回「字段 → 错误文案」；空对象 = 通过。
 *
 * 五条跳板机规则与主连接规则同源：必填三项、端口范围、私钥（密钥库 id 或手填
 * 路径二选一）、跳板机密码（本次没填且以前也没存过才算缺）。
 */
export function validateConnectionForm(
  values: ConnectionFormValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!values.name.trim()) errors.name = '名称为必填项';
  if (!values.host.trim()) errors.host = '主机为必填项';
  if (!values.username.trim()) errors.username = '用户名为必填项';
  if (values.port < 1 || values.port > 65535) {
    errors.port = '端口必须在 1-65535 之间';
  }
  if (values.authMethod === 'PrivateKey' && !values.keyId && !values.keyPath.trim()) {
    errors.keyPath = '请选择或导入一把私钥';
  }
  if (values.useJump) {
    if (!values.jumpHost.trim()) errors.jumpHost = '跳板机主机为必填项';
    if (!values.jumpUsername.trim()) errors.jumpUsername = '跳板机用户名为必填项';
    if (values.jumpPort < 1 || values.jumpPort > 65535) {
      errors.jumpPort = '端口必须在 1-65535 之间';
    }
    if (
      values.jumpAuthMethod === 'PrivateKey' &&
      !values.jumpKeyId &&
      !values.jumpKeyPath.trim()
    ) {
      errors.jumpKeyPath = '请选择或导入跳板机的私钥';
    }
    if (
      values.jumpAuthMethod === 'Password' &&
      !values.jumpPassword &&
      !values.hasJumpPassword
    ) {
      errors.jumpPassword = '请填写跳板机密码';
    }
  }
  return errors;
}

/** 组装 SavedConnection 时从现有连接继承的字段（编辑模式才有）。 */
export interface ConnectionFormDraft {
  existing?: Pick<SavedConnection, 'id' | 'lastConnected'>;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  keyId: string;
  keyPath: string;
  group: string;
  useJump: boolean;
  jumpHost: string;
  jumpPort: number;
  jumpUsername: string;
  jumpAuthMethod: JumpAuthMethod;
  jumpKeyId: string;
  jumpKeyPath: string;
}

/**
 * 表单状态 → 要落盘的 SavedConnection。
 *
 * 派生规则（两端必须一致，否则同一份连接在两端保存出两种形状）：
 * - 选了密钥库里的私钥就不再记路径；反之保留手填路径（老数据与高级用法）
 * - 分组 trim 后为空 = 未分组（落盘为缺省）
 * - 跳板机关闭时所有 jump* 字段一律缺省，不留残值
 */
export function buildSavedConnection(draft: ConnectionFormDraft): SavedConnection {
  return {
    id: draft.existing?.id ?? crypto.randomUUID(),
    name: draft.name.trim(),
    host: draft.host.trim(),
    port: draft.port,
    username: draft.username.trim(),
    authMethod: draft.authMethod,
    keyPath:
      draft.authMethod === 'PrivateKey' && !draft.keyId
        ? draft.keyPath.trim()
        : undefined,
    keyId: draft.authMethod === 'PrivateKey' ? draft.keyId || undefined : undefined,
    group: draft.group.trim() || undefined,
    lastConnected: draft.existing?.lastConnected,
    useJump: draft.useJump,
    jumpHost: draft.useJump ? draft.jumpHost.trim() : undefined,
    jumpPort: draft.useJump ? draft.jumpPort : undefined,
    jumpUsername: draft.useJump ? draft.jumpUsername.trim() : undefined,
    jumpAuthMethod: draft.useJump ? draft.jumpAuthMethod : undefined,
    jumpKeyPath:
      draft.useJump && draft.jumpAuthMethod === 'PrivateKey' && !draft.jumpKeyId
        ? draft.jumpKeyPath.trim()
        : undefined,
    jumpKeyId:
      draft.useJump && draft.jumpAuthMethod === 'PrivateKey'
        ? draft.jumpKeyId || undefined
        : undefined,
  };
}

/** 有几条连接在用这把私钥（含作为跳板机私钥），删除前要提醒清楚。 */
export function keyUsageCount(
  connections: ReadonlyArray<{ keyId?: string; useJump?: boolean; jumpKeyId?: string }>,
  id: string,
): number {
  return connections.filter(
    (c) => c.keyId === id || (c.useJump && c.jumpKeyId === id),
  ).length;
}

/**
 * 端口输入框 onChange 的解析规则：能解析出**正整数**才采纳，否则返回 null =
 * 保持当前 port 不动。
 *
 * 刻意不做范围检查：65536 这类越界值先照单全收，由 validateConnectionForm 在
 * 保存时拦下并提示「1-65535」——边打边报错会打断输入。
 */
export function parsePortInput(raw: string): number | null {
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
}

/**
 * 端口输入框 onBlur 的回落规则：**完全不是数字**（或整个为空）才回落到默认端口。
 *
 * 与 parsePortInput 是两条不同的规则，这是既有行为：「0」「-5」这类能解析出数字
 * 的输入失焦时**不**回落（保留用户打的字，保存时由校验拦），只有乱码才还原成 22。
 */
export function shouldResetPortOnBlur(raw: string): boolean {
  return !raw || Number.isNaN(parseInt(raw, 10));
}

/** 密钥链写入失败提示的两种口径：表单里存凭证 vs 连接途中存凭证。 */
export type SecretSaveMessageVariant = 'form' | 'connect';

/**
 * 密钥链写入失败的提示文案。
 *
 * 只说这件事本身——不回显、不记录任何凭据（错误文案来自后端密钥链，只有系统层面
 * 的原因）。历史上这条提示在桌面/移动的表单与列表里各抄一份（共四处），现在收敛
 * 到这里：
 * - `form`：表单保存后立刻关闭，说「下次连接还得再输一次」就够了；
 * - `connect`：连接途中的保存失败不拦连接，要多说一句「本次连接照常进行」，
 *   否则用户看到红条会以为这次连接也黄了。
 */
export function secretSaveFailedMessage(
  what: string,
  err: unknown,
  variant: SecretSaveMessageVariant,
): string {
  const reason = getErrorMessage(err);
  if (variant === 'connect') {
    return `${what}没能保存到本设备（${reason}）。本次连接照常进行，但下次连接和「重连」还得再输一次。`;
  }
  return `${what}没能保存到本设备（${reason}）。下次连接和「重连」还得再输一次。`;
}
