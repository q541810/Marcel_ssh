import type React from 'react';
import type { SkillResource } from '@/lib/types';
import SkillResourcesEditor from './SkillResourcesEditor';

interface Props {
  name: string;
  description: string;
  prompt: string;
  onNameChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onPromptChange: (v: string) => void;
  /** 附属资源文件；传 onResourcesChange 即可编辑 */
  resources?: SkillResource[];
  onResourcesChange?: (v: SkillResource[]) => void;
  disabled?: boolean;
}

const PLACEHOLDER_NAME = '为该 skill 起一个简短、易识别的名称（例如 codemap）';
const PLACEHOLDER_DESC = '该 skill 应该在何时使用？例如：当用户询问项目结构或文件关系时';
const PLACEHOLDER_PROMPT =
  'Commands:\n  -\nWhen to Use:\n  -\nOutput Interpretation:\n  -\nExamples:\n  -';

const inputCls =
  'w-full rounded-lg bg-field border border-edge-strong px-3 py-2 text-body text-fg ' +
  'placeholder-fg-tertiary focus:outline-none focus:border-indigo-500 resize-none';

export default function SkillFormFields({
  name,
  description,
  prompt,
  onNameChange,
  onDescriptionChange,
  onPromptChange,
  resources,
  onResourcesChange,
  disabled = false,
}: Props) {
  return (
    <div className='space-y-4'>
      <div>
        <label className='block text-meta text-fg-secondary mb-1'>
          <span className='text-red-400'>*</span> Skill 名称
        </label>
        <input
          type='text'
          className={inputCls}
          placeholder={PLACEHOLDER_NAME}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          disabled={disabled}
        />
      </div>

      <div>
        <label className='block text-meta text-fg-secondary mb-1'>
          <span className='text-red-400'>*</span> 描述
        </label>
        <textarea
          className={inputCls + ' min-h-20'}
          placeholder={PLACEHOLDER_DESC}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          disabled={disabled}
        />
      </div>

      <div>
        <label className='block text-meta text-fg-secondary mb-1'>
          <span className='text-red-400'>*</span> 指令
        </label>
        <textarea
          className={inputCls + ' min-h-40 font-mono'}
          placeholder={PLACEHOLDER_PROMPT}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          disabled={disabled}
        />
      </div>

      {onResourcesChange ? (
        <SkillResourcesEditor
          resources={resources ?? []}
          onChange={onResourcesChange}
          readOnly={disabled}
        />
      ) : (
        resources &&
        resources.length > 0 && (
          <SkillResourcesEditor resources={resources} onChange={() => {}} readOnly />
        )
      )}
    </div>
  );
}
