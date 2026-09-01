// LLM 参数校验与序列化辅助 —— 桌面端 / 移动端共用。
//
// 原 ModelRetrySection / ModelServiceSection 里的校验函数收敛到这里，
// 多渠道模型服务下每个渠道/模型编辑表单复用同一套规则。

/** 校验重试 HTTP 状态码串（逗号分隔的状态码或范围，如 "408, 429, 500-599"）。
 *  返回错误文案；null 表示合法（空串合法 = 不按状态码重试）。 */
export function validateRetryHttpStatuses(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null; // empty is valid (no HTTP retry)

  for (const entry of trimmed.split(',')) {
    const entryTrimmed = entry.trim();
    if (!entryTrimmed) continue;

    if (entryTrimmed.includes('-')) {
      const parts = entryTrimmed.split('-');
      if (parts.length !== 2) return `无效范围: "${entryTrimmed}"（使用格式 lo-hi）`;
      const lo = Number(parts[0].trim());
      const hi = Number(parts[1].trim());
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return `无法解析范围: "${entryTrimmed}"`;
      if (lo < 100 || lo > 599 || hi < 100 || hi > 599) return `状态码超出范围 (100-599): "${entryTrimmed}"`;
      if (hi < lo) return `范围需从小到大: "${entryTrimmed}"`;
    } else {
      const code = Number(entryTrimmed);
      if (!Number.isFinite(code)) return `无效状态码: "${entryTrimmed}"`;
      if (code < 100 || code > 599) return `状态码超出范围 (100-599): "${entryTrimmed}"`;
    }
  }
  return null;
}

/** 校验 extraBody 文本是否为合法 JSON 对象。返回错误文案；null 表示合法。 */
export function validateExtraBodyJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null; // empty = "not set" = valid
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return '必须是 JSON 对象（{}），不能是数组、null 或基本类型';
  }
  return null;
}

/**
 * Convert extraBody to a text representation for the textarea.
 *
 * Only `null` / `undefined` (not set) collapses to an empty string.
 * An empty object `{}` is a legitimate user choice and is preserved as `'{}'`
 * — the backend treats it as a no-op and the validator explicitly accepts
 * `{}` as valid JSON. Collapsing `{}` to `''` would silently discard input.
 */
export function extraBodyToText(extraBody: Record<string, unknown> | null | undefined): string {
  if (extraBody == null) return '';
  return JSON.stringify(extraBody, null, 2);
}

/** Parse textarea text back to extraBody value. Empty/invalid → null (not set). */
export function textToExtraBody(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = JSON.parse(trimmed);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
