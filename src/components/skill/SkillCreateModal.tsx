import { useRef, useState, useCallback } from 'react';
import Modal from '@/components/ui/Modal';
import SkillFormFields from './SkillFormFields';
import * as tauri from '@/lib/tauri';
import type { ParsedSkill } from '@/lib/types';
import { useSkillStore } from '@/stores/skillStore';
import { useFileDrop } from '@/hooks/useFileDrop';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SkillCreateModal({ open, onClose }: Props) {
  const addSkill = useSkillStore((s) => s.addSkill);
  const fetchSkills = useSkillStore((s) => s.fetchSkills);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const valid = name.trim().length > 0 && prompt.trim().length > 0;

  const reset = () => {
    setName('');
    setDescription('');
    setPrompt('');
    setImportError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // 从文件路径读取内容并导入 skill
  const handleFilePath = useCallback(async (filePath: string) => {
    setImportError(null);
    try {
      const { readFile } = await import('@tauri-apps/plugin-fs');
      const content = await readFile(filePath);
      const base64 = btoa(String.fromCharCode(...content));
      const fileName = filePath.split(/[/\\]/).pop() || 'file';
      const parsed: ParsedSkill = await tauri.importSkillFile(base64, fileName);
      setName(parsed.name);
      setDescription(parsed.description);
      setPrompt(parsed.prompt);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 从 File 对象读取内容并导入 skill（用于文件选择器）
  const handleFile = async (file: File) => {
    setImportError(null);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));
      const base64 = btoa(String.fromCharCode(...bytes));
      const parsed: ParsedSkill = await tauri.importSkillFile(base64, file.name);
      setName(parsed.name);
      setDescription(parsed.description);
      setPrompt(parsed.prompt);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  };

  // 拖拽上传：使用 useFileDrop hook，只在弹窗打开时启用
  const handleFileDrop = useCallback((paths: string[]) => {
    if (paths.length > 0) {
      handleFilePath(paths[0]);
    }
  }, [handleFilePath]);

  const { isDragging } = useFileDrop(handleFileDrop, open);

  const onFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleConfirm = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await addSkill(name.trim(), description.trim(), prompt.trim());
      await fetchSkills();
      handleClose();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title='创建 Skill'>
      <div className='px-4 pb-4 space-y-4'>
        {/* Upload zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          className={
            'rounded-xl border-2 border-dashed cursor-pointer select-none transition-colors p-5 flex flex-col items-center gap-1.5 ' +
            (isDragging
              ? 'border-indigo-400 bg-indigo-950/30'
              : 'border-zinc-600 hover:border-zinc-500 hover:bg-zinc-700/40')
          }
        >
          <svg className='w-7 h-7 text-zinc-500' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
            <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={1.5}
              d='M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' />
          </svg>
          <span className='text-sm text-zinc-300 font-medium'>
            {isDragging ? '松手导入 skill' : '上传进行智能解析'}
          </span>
          <span className='text-xs text-zinc-500 text-center leading-relaxed'>
            支持 .md 文件或 .zip / .skill 压缩包<br />
            文件需包含 YAML frontmatter
          </span>
          <input
            ref={fileInputRef}
            type='file'
            accept='.md,.zip,.skill'
            onChange={onFilesSelected}
            className='hidden'
          />
        </div>

        {/* Error banner */}
        {importError && (
          <div className='rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-400 whitespace-pre-wrap break-words'>
            {importError}
          </div>
        )}

        {/* Divider */}
        <div className='relative'>
          <div className='absolute inset-0 flex items-center'>
            <div className='w-full border-t border-zinc-700' />
          </div>
          <div className='relative flex justify-center text-xs'>
            <span className='bg-zinc-800 px-2 text-zinc-500'>或手动填写</span>
          </div>
        </div>

        {/* Form */}
        <SkillFormFields
          name={name}
          description={description}
          prompt={prompt}
          onNameChange={setName}
          onDescriptionChange={setDescription}
          onPromptChange={setPrompt}
        />

        {/* Actions */}
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
            {saving ? '保存中...' : '确认'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
