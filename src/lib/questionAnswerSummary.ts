/**
 * 把 `ask_user` 的工具结果（回喂给模型的那段文本）压成一行「已回答」摘要。
 *
 * 结果格式（后端 `question.rs`）：
 *   单行：`1. [标题] 回答`；未答：`1. [标题] 用户未回答`；
 *   多选：`1. [标题]` 后跟 `   - 选项` 行和可选的补充文字行。
 * 只读展示用，解析不了就原样压成一行，不会因格式变化丢信息。
 */
export interface AnswerSummary {
  /** answered = 至少答了一题；skipped = 全部跳过 / 取消。 */
  readonly state: 'answered' | 'skipped';
  readonly text: string;
}

export function summarizeAnswers(result: string, success: boolean): AnswerSummary {
  if (!success) return { state: 'skipped', text: '' };
  const answers: string[] = [];
  let parts: string[] | null = null;
  const flush = () => {
    if (parts && parts.length) answers.push(parts.join('、'));
    parts = null;
  };
  for (const raw of result.split(/\r?\n/)) {
    const head = /^\d+\.\s*\[[^\]]*\]\s*(.*)$/.exec(raw);
    if (head) {
      flush();
      const body = head[1].trim();
      if (body === '用户未回答') parts = null;
      else parts = body ? [body] : [];
    } else if (parts) {
      const line = raw.trim().replace(/^-\s*/, '');
      if (line) parts.push(line);
    }
  }
  flush();
  if (answers.length === 0) {
    // 解析不出结构：有文本就整体压成一行，否则视为跳过
    const flat = result.replace(/\s+/g, ' ').trim();
    return flat && !/用户未回答|取消/.test(flat) ? { state: 'answered', text: flat } : { state: 'skipped', text: '' };
  }
  return { state: 'answered', text: answers.join(' · ') };
}
