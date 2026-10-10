import type { UserInputMetadata, UserTextAttachment } from './types';
import { wrapTextAttachment } from './attachmentAttach';

/** 完整模型输入的唯一拼装入口；不 trim 文件内容，不从普通文本猜附件。 */
export function composeUserInput(input: UserInputMetadata): string {
  return input.text + input.textAttachments
    .map((file) => wrapTextAttachment(file.name, file.content))
    .join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 元数据只用于改变展示，不能隐藏或丢失 content 中任何一个字。
 * 缺失、未来版本、坏数据或重组不一致时不采用元数据，由调用方保留原文。
 */
export function validateUserInput(
  content: string,
  value: unknown,
): UserInputMetadata | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.text !== 'string'
    || !Array.isArray(value.textAttachments)) return undefined;

  const ids = new Set<string>();
  const textAttachments: UserTextAttachment[] = [];
  for (const file of value.textAttachments) {
    if (!isRecord(file) || typeof file.id !== 'string' || file.id.length === 0
      || ids.has(file.id) || typeof file.name !== 'string' || file.name.length === 0
      || typeof file.content !== 'string'
      || (file.size !== undefined && (typeof file.size !== 'number'
        || !Number.isSafeInteger(file.size) || file.size < 0))) return undefined;
    ids.add(file.id);
    textAttachments.push({
      id: file.id,
      name: file.name,
      content: file.content,
      ...(file.size !== undefined ? { size: file.size } : {}),
    });
  }
  const input: UserInputMetadata = { version: 1, text: value.text, textAttachments };
  return composeUserInput(input) === content ? input : undefined;
}
