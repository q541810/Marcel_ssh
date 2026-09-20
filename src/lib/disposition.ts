import type { Disposition } from './types';

/**
 * 把任何来源的处置档位字符串归一到 {@link Disposition}。
 *
 * 需要它是因为这个值跨了三处持久化边界，其中两处躺着历史数据：
 *  - 数据库 `tool_calls_json` 里老的键名是 `risk_level`、值是五档严重度；
 *  - 插件 manifest 的 `riskLevel` 同理（那份是已发布的插件契约）；
 *  - 只有新写入的才是四档。
 *
 * 认不出的值一律落到 `Approval`（保守：宁可多问一句），而不是抛错 —— 一条读不懂的
 * 历史记录不该让整个会话打不开。
 */
export function normalizeDisposition(raw: unknown): Disposition {
  switch (raw) {
    case 'Allow':
    case 'ReadOnly':
    case 'LowRisk':
      return 'Allow';
    case 'Approval':
    case 'Moderate':
      return 'Approval';
    case 'ForceApproval':
    case 'HighRisk':
    case 'Destructive':
      return 'ForceApproval';
    case 'Deny':
      return 'Deny';
    default:
      return 'Approval';
  }
}
