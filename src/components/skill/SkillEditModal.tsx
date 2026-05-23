import { useState } from 'react';
import Modal from '@/components/ui/Modal';
import { useSkillStore } from '@/stores/skillStore';
import type { Skill } from '@/lib/types';

interface Props {
  skill: Skill;
  open: boolean;
  onClose: () => void;
}

const PLACEHOLDER_NAME = '为该技能起一个简短、易识别的名称（例如 codemap）';
const PLACEHOLDER_DESC = '该技能应该在何时使用？例如：当用户询问项目结构或文件关系时';
const PLACEHOLDER_PROMPT =
  'Commands:\n  -\nWhen to Use:\n  -\nOutput Interpretation:\n  -\nExamples:\n  -';

export default function SkillEditModal({ skill, open, onClose }: Props) {
  const updateSkill = useSkillStore((s) => s.updateSkill);

  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [prompt, setPrompt] = useState(skill.prompt);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const valid = name.trim().length > 0 && prompt.trim().length > 0;

  const handleClose = () => {
    setName(skill.name);
    setDescription(skill.description);
    setPrompt(skill.prompt);
    setSaveError(null);
    onClose();
  };

  const handleConfirm = async () => {
    if (!valid) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateSkill(skill.id, name.trim(), description.trim(), prompt.trim());
      handleClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    'w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 ' +
    'placeholder-zinc-500 focus:outline-none focus:border-indigo-500 resize-none';

  return (
    <Modal open={open} onClose={handleClose} title='编辑技能'>
      <div className='px-4 pb-4 space-y-4'>
        {saveError && (
          <div className='rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400 whitespace-pre-wrap break-words'>
            {saveError}
          </div>
        )}

        <div className='space-y-4'>
          <div>
            <label className='block text-xs text-zinc-400 mb-1'>
              <span className='text-red-400'>*</span> 技能名称
            </label>
            <input
              type='text'
              className={inputCls}
              placeholder={PLACEHOLDER_NAME}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className='block text-xs text-zinc-400 mb-1'>
              <span className='text-red-400'>*</span> 描述
            </label>
            <textarea
              className={inputCls + ' min-h-20'}
              placeholder={PLACEHOLDER_DESC}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div>
            <label className='block text-xs text-zinc-400 mb-1'>
              <span className='text-red-400'>*</span> 指令
            </label>
            <textarea
              className={inputCls + ' min-h-40 font-mono'}
              placeholder={PLACEHOLDER_PROMPT}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
        </div>

        <div className='flex justify-end gap-2 pt-2'>
          <button
            onClick={handleClose}
            className='px-4 py-1.5 text-sm rounded-lg bg-zinc-700 text-zinc-200 hover:bg-zinc-600 transition-colors'
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={!valid || saving}
            className='px-4 py-1.5 text-sm rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors'
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
