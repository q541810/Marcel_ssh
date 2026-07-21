import { useEffect, useRef, useState } from 'react';
import { FileUp, Plus } from 'lucide-react';
import type { Skill } from '@/lib/types';
import { useSkillStore } from '@/stores/skillStore';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import Toggle from '@/components/ui/Toggle';
import MobileSheet from '../ui/MobileSheet';

interface FormState {
  id?: string;
  name: string;
  description: string;
  prompt: string;
}

const EMPTY_FORM: FormState = { name: '', description: '', prompt: '' };

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-indigo-500';

/** Skill management for mobile: import file / create / edit / toggle / delete. */
export function MobileSkillSection() {
  const skills = useSkillStore((s) => s.skills);
  const loading = useSkillStore((s) => s.loading);
  const storeError = useSkillStore((s) => s.error);
  const fetchSkills = useSkillStore((s) => s.fetchSkills);
  const addSkill = useSkillStore((s) => s.addSkill);
  const updateSkill = useSkillStore((s) => s.updateSkill);
  const toggleSkill = useSkillStore((s) => s.toggleSkill);
  const deleteSkill = useSkillStore((s) => s.deleteSkill);

  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetchSkills();
  }, [fetchSkills]);

  // WebView-native file picker — works on Android without the dialog plugin.
  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;
    setMessage(null);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      const parsed = await tauri.importSkillFile(btoa(binary), file.name);
      setForm({
        name: parsed.name,
        description: parsed.description,
        prompt: parsed.prompt,
      });
    } catch (err) {
      setMessage(`导入失败：${getErrorMessage(err)}`);
    }
  };

  const handleSubmit = async () => {
    if (!form) return;
    if (!form.name.trim() || !form.prompt.trim()) {
      setMessage('名称和提示词不能为空');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      if (form.id) {
        await updateSkill(
          form.id,
          form.name.trim(),
          form.description.trim(),
          form.prompt,
        );
      } else {
        await addSkill(form.name.trim(), form.description.trim(), form.prompt);
      }
      setForm(null);
    } catch (err) {
      setMessage(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteSkill(deleteTarget.id);
    setDeleteTarget(null);
  };

  const displayError = message ?? storeError;

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 px-3 py-3 text-sm text-zinc-300 transition-colors duration-100 active:scale-[0.99] active:bg-zinc-900"
        >
          <FileUp className="h-4 w-4" />
          导入文件
        </button>
        <button
          type="button"
          onClick={() => {
            setMessage(null);
            setForm(EMPTY_FORM);
          }}
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-700 px-3 py-3 text-sm text-zinc-300 transition-colors duration-100 active:scale-[0.99] active:bg-zinc-900"
        >
          <Plus className="h-4 w-4" />
          手动创建
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.txt,.markdown"
        onChange={(e) => void handleFileSelected(e)}
        className="hidden"
      />

      {displayError && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {displayError}
        </div>
      )}

      {loading && skills.length === 0 && (
        <p className="py-8 text-center text-sm text-zinc-500">加载 Skills…</p>
      )}

      {!loading && skills.length === 0 && !displayError && (
        <p className="py-8 text-center text-sm text-zinc-500">
          暂无 Skills，可导入 SKILL.md 文件或手动创建。
        </p>
      )}

      {skills.map((skill) => (
        <div
          key={skill.id}
          className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-3"
        >
          <button
            type="button"
            onClick={() => {
              setMessage(null);
              setForm({
                id: skill.id,
                name: skill.name,
                description: skill.description,
                prompt: skill.prompt,
              });
            }}
            className="min-w-0 flex-1 text-left"
          >
            <div className="truncate text-sm font-medium text-zinc-100">
              {skill.name}
            </div>
            {skill.description ? (
              <div className="mt-0.5 line-clamp-2 text-xs text-zinc-500">
                {skill.description}
              </div>
            ) : (
              <div className="mt-0.5 text-xs italic text-zinc-600">无描述</div>
            )}
          </button>
          <Toggle
            checked={skill.enabled}
            onChange={() => void toggleSkill(skill.id)}
          />
        </div>
      ))}

      {/* Create / edit sheet */}
      <MobileSheet
        open={form != null}
        onClose={() => setForm(null)}
        title={form?.id ? '编辑 Skill' : '新建 Skill'}
        footer={
          <div className="flex gap-2">
            {form?.id && (
              <button
                type="button"
                onClick={() => {
                  const target = skills.find((s) => s.id === form.id);
                  if (target) {
                    setForm(null);
                    setDeleteTarget(target);
                  }
                }}
                className="rounded-xl bg-zinc-800 px-4 py-3 text-sm text-red-300 active:bg-zinc-700"
              >
                删除
              </button>
            )}
            <button
              type="button"
              onClick={() => setForm(null)}
              className="flex-1 rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300 active:bg-zinc-700"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={saving}
              className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-medium text-white active:bg-indigo-500 disabled:opacity-40"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        }
      >
        {form && (
          <div className="space-y-3 px-4 pb-3">
            {message && (
              <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                {message}
              </div>
            )}
            <div>
              <label className="mb-1 block text-xs text-zinc-400">名称</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：docker-debug"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                描述（帮助 Agent 判断何时使用）
              </label>
              <input
                type="text"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="排查 Docker 容器问题时使用"
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                提示词内容
              </label>
              <textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                rows={10}
                placeholder="# Skill 指令…"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className={`${inputClass} resize-none font-mono text-xs leading-relaxed`}
              />
            </div>
          </div>
        )}
      </MobileSheet>

      {/* Delete confirm sheet */}
      <MobileSheet
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title="确认删除"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className="pb-1 text-sm text-zinc-400">
            删除 Skill「{deleteTarget?.name}」？此操作不可撤销。
          </p>
          <button
            type="button"
            onClick={() => void handleDelete()}
            className="rounded-xl bg-red-600 px-4 py-3 text-sm font-medium text-white active:bg-red-500"
          >
            删除
          </button>
          <button
            type="button"
            onClick={() => setDeleteTarget(null)}
            className="rounded-xl px-4 py-3 text-sm text-zinc-400 active:bg-zinc-800"
          >
            取消
          </button>
        </div>
      </MobileSheet>
    </div>
  );
}
