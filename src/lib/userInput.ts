import type { UserInputMetadata, UserReplyRef, UserSkillRef, UserTextAttachment } from './types';
import { wrapTextAttachment } from './attachmentAttach';

/** 手动引用的 skill 在模型输入里的包裹形式（与文本附件同为「正文之后的段落」）。 */
export function wrapSkillRef(name: string, content: string): string {
  return `\n\n===== 用户指定使用的 Skill: ${name} =====\n${content}`;
}

/** 回信给模型看的开头：交代这是对哪张建议卡片的回复（模型不一定还记得自己问了什么）。 */
export function wrapReplyNote(question: string): string {
  return `（这是对你刚才放的建议卡片「${question}」的回复）
`;
}

/** 完整模型输入的唯一拼装入口；不 trim 文件内容，不从普通文本猜附件。 */
export function composeUserInput(input: UserInputMetadata): string {
  return (input.replyTo ? wrapReplyNote(input.replyTo.question) : '')
    + input.text
    + input.textAttachments
      .map((file) => wrapTextAttachment(file.name, file.content))
      .join('')
    + (input.skills ?? [])
      .map((skill) => wrapSkillRef(skill.name, skill.content))
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
  const skills: UserSkillRef[] = [];
  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills)) return undefined;
    for (const skill of value.skills) {
      if (!isRecord(skill) || typeof skill.id !== 'string' || skill.id.length === 0
        || ids.has(skill.id) || typeof skill.skillId !== 'string'
        || typeof skill.name !== 'string' || skill.name.length === 0
        || typeof skill.content !== 'string') return undefined;
      ids.add(skill.id);
      skills.push({ id: skill.id, skillId: skill.skillId, name: skill.name, content: skill.content });
    }
  }
  let replyTo: UserReplyRef | undefined;
  if (value.replyTo !== undefined) {
    const r = value.replyTo;
    if (!isRecord(r) || typeof r.toolCallId !== 'string' || r.toolCallId.length === 0
      || typeof r.question !== 'string') return undefined;
    replyTo = { toolCallId: r.toolCallId, question: r.question };
  }
  const input: UserInputMetadata = {
    version: 1,
    text: value.text,
    textAttachments,
    ...(skills.length > 0 ? { skills } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
  return composeUserInput(input) === content ? input : undefined;
}
