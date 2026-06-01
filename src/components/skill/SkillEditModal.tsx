import { useState } from 'react';
import Modal from '@/components/ui/Modal';
import SkillFormFields from './SkillFormFields';
import { useSkillStore } from '@/stores/skillStore';
import type { Skill } from '@/lib/types';

interface Props {
  skill: Skill;
  open: boolean;
  onClose: () => void;
}

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

  return (
    <Modal open={open} onClose={handleClose} title='编辑技能'>
      <div className='px-4 pb-4 space-y-4'>
        {saveError && (
          <div className='rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400 whitespace-pre-wrap break-words'>
            {saveError}
          </div>
        )}

        <SkillFormFields
          name={name}
          description={description}
          prompt={prompt}
          onNameChange={setName}
          onDescriptionChange={setDescription}
          onPromptChange={setPrompt}
        />

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
