import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import type { UserSkillRef } from '@/lib/types';
import type { AttachmentItem } from '@/stores/agentDraftStore';
import AttachmentPreview from './AttachmentPreview';

interface Props {
  skills: readonly UserSkillRef[];
  mobile?: boolean;
  /** 省略 = 只读展示（已发送的消息）。 */
  onRemove?: (id: string) => void;
  justify?: 'start' | 'end';
}

/** 手动引用的 skill 标签：输入区可删，已发送消息只读；点开预览发给模型的指令全文。 */
export default function SkillChips({ skills, mobile = false, onRemove, justify = 'start' }: Props) {
  const [preview, setPreview] = useState<AttachmentItem | null>(null);
  if (skills.length === 0) return null;
  return <>
    <ul
      aria-label="引用的 Skill"
      className={`m-0 flex min-w-0 max-w-full list-none flex-wrap gap-1.5 p-0 ${justify === 'end' ? 'justify-end' : ''}`}
    >
      {skills.map((skill) => (
        <li
          key={skill.id}
          data-skill-chip={skill.skillId}
          className="flex min-w-0 max-w-full items-center overflow-hidden rounded-full border border-indigo-500/40 bg-indigo-500/10 text-indigo-200"
        >
          <button
            type="button"
            onClick={() => setPreview({
              id: skill.id, name: skill.name, kind: 'text', status: 'ready', content: skill.content,
            })}
            aria-label={`预览 Skill ${skill.name}`}
            title={`预览 ${skill.name} 的指令`}
            className={`flex min-w-0 items-center gap-1.5 pl-2.5 text-meta font-medium transition-colors hover:bg-indigo-500/15 active:bg-indigo-500/20 ${onRemove ? 'pr-1' : 'pr-3'} ${mobile ? 'h-9' : 'h-7'}`}
          >
            <Sparkles aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{skill.name}</span>
          </button>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(skill.id)}
              aria-label={`移除 Skill ${skill.name}`}
              title={`移除 ${skill.name}`}
              className={`flex shrink-0 items-center justify-center text-indigo-300/80 transition-colors hover:bg-indigo-500/20 hover:text-indigo-100 active:bg-indigo-500/25 ${mobile ? 'h-9 w-9' : 'h-7 w-7'}`}
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          )}
        </li>
      ))}
    </ul>
    <AttachmentPreview item={preview} mobile={mobile} onClose={() => setPreview(null)} />
  </>;
}
