import { useEffect, useMemo, useRef, useState } from 'react';
import { CloudDownload, FileUp, Plus } from 'lucide-react';
import type { DiscoveredSkill, ParsedSkill, Skill, SkillResource } from '@/lib/types';
import { useSkillStore } from '@/stores/skillStore';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import { isBuiltinSkill, sortSkillsForDisplay } from '@/lib/builtinSkills';
import { useLongPressDrag } from '../useLongPressDrag';
import Toggle from '@/components/ui/Toggle';
import MobileSheet from '../ui/MobileSheet';
import { isCancelledError, useSkillImportProgress } from '@/hooks/useSkillImportProgress';
import SkillImportProgressBar from '@/components/skill/SkillImportProgressBar';
import GithubImportGuide, {
  GithubImportGuideButton,
} from '@/components/skill/GithubImportGuide';
import SkillResourcesEditor from '@/components/skill/SkillResourcesEditor';

interface FormState {
  id?: string;
  name: string;
  description: string;
  prompt: string;
  /** 附属资源文件 */
  resources?: SkillResource[];
  /** 内置 skill：只读查看，不可编辑/删除 */
  readonly?: boolean;
}

const EMPTY_FORM: FormState = { name: '', description: '', prompt: '' };

const inputClass =
  'w-full rounded-lg border border-edge-strong bg-field px-3 py-2.5 text-body text-fg outline-none placeholder:text-fg-tertiary focus:border-indigo-500';

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
  const reorderSkills = useSkillStore((s) => s.reorderSkills);
  const discoverFromUrl = useSkillStore((s) => s.discoverFromUrl);
  const importFromUrl = useSkillStore((s) => s.importFromUrl);

  const [form, setForm] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Skill | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // GitHub 导入
  const [ghOpen, setGhOpen] = useState(false);
  const [ghUrl, setGhUrl] = useState('');
  const [ghBusy, setGhBusy] = useState(false);
  const imp = useSkillImportProgress();
  const [guideOpen, setGuideOpen] = useState(false);
  const [ghStatus, setGhStatus] = useState<string | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);
  const [found, setFound] = useState<{ repo: string; skills: DiscoveredSkill[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 展示顺序：内置置顶，用户按手动排序
  const sorted = useMemo(() => sortSkillsForDisplay(skills), [skills]);
  const userIds = useMemo(
    () => sorted.filter((s) => !isBuiltinSkill(s)).map((s) => s.id),
    [sorted],
  );

  const drag = useLongPressDrag({
    orderedIds: userIds,
    onCommit: (ids) => void reorderSkills(ids),
  });

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
        resources: parsed.resources,
      });
    } catch (err) {
      setMessage(`导入失败：${getErrorMessage(err)}`);
    }
  };

  /** 把解析结果填进表单（预览后由用户确认保存）。 */
  const fillForm = (parsed: ParsedSkill) => {
    setForm({
      name: parsed.name,
      description: parsed.description,
      prompt: parsed.prompt,
      resources: parsed.resources,
    });
  };

  const closeGh = () => {
    if (imp.active) imp.cancel();
    setGhOpen(false);
    setGhUrl('');
    setGhStatus(null);
    setGhError(null);
    setFound(null);
    setSelected(new Set());
    setGuideOpen(false);
  };

  /** 地址里带 tree/blob 段 = 已指向具体目录/文件，直接拉取，不必先发现。 */
  const ghHasExplicitPath = (url: string) => /\/(tree|blob)\//.test(url);

  const handleGhFetch = async () => {
    const url = ghUrl.trim();
    if (!url) return;
    setGhError(null);
    setFound(null);
    setSelected(new Set());
    setGhBusy(true);
    setGhStatus('正在从 GitHub 拉取…');
    const importId = imp.begin();
    try {
      if (ghHasExplicitPath(url)) {
        const parsed = await importFromUrl(url, undefined, importId);
        closeGh();
        fillForm(parsed);
        return;
      }
      const discovery = await discoverFromUrl(url, importId);
      if (discovery.skills.length === 1) {
        const parsed = await importFromUrl(url, discovery.skills[0].subpath, importId);
        closeGh();
        fillForm(parsed);
        return;
      }
      setFound(discovery);
      setSelected(new Set(discovery.skills.map((s) => s.subpath)));
      setGhStatus(`在 ${discovery.repo} 发现 ${discovery.skills.length} 个 skill`);
    } catch (err) {
      if (isCancelledError(err)) {
        setGhStatus('已取消');
      } else {
        setGhError(getErrorMessage(err));
        setGhStatus(null);
      }
    } finally {
      imp.end();
      setGhBusy(false);
    }
  };

  const toggleSelected = (subpath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(subpath)) next.delete(subpath);
      else next.add(subpath);
      return next;
    });
  };

  const handleGhImportSelected = async () => {
    if (!found || selected.size === 0) return;
    const targets = found.skills.filter((s) => selected.has(s.subpath));
    setGhError(null);
    setGhBusy(true);
    let ok = 0;
    const failed: string[] = [];
    const importId = imp.begin();
    for (let i = 0; i < targets.length; i++) {
      if (imp.isCancelled()) break;
      const t = targets[i];
      setGhStatus(`正在导入 ${i + 1}/${targets.length}：${t.name}…`);
      try {
        const parsed = await importFromUrl(ghUrl.trim(), t.subpath, importId);
        await addSkill(parsed.name, parsed.description, parsed.prompt, parsed.resources ?? []);
        ok++;
      } catch (err) {
        if (isCancelledError(err)) break;
        failed.push(`${t.name}（${getErrorMessage(err)}）`);
      }
    }
    const cancelled = imp.isCancelled();
    imp.end();
    setGhBusy(false);
    if (cancelled) {
      setGhStatus(`已取消（已导入 ${ok} 个）`);
      if (failed.length > 0) setGhError(`失败 ${failed.length} 个：\n${failed.join('\n')}`);
    } else if (failed.length > 0) {
      setGhError(`成功 ${ok} 个，失败 ${failed.length} 个：\n${failed.join('\n')}`);
      setGhStatus(null);
    } else {
      closeGh();
    }
  };

  const handleSubmit = async () => {
    if (!form || form.readonly) return;
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
          form.resources ?? [],
        );
      } else {
        await addSkill(form.name.trim(), form.description.trim(), form.prompt, form.resources);
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
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center justify-center gap-1.5 rounded-xl min-h-11 border border-dashed border-edge px-2 py-3 text-body text-fg-secondary pressable active:bg-surface"
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
          className="flex items-center justify-center gap-1.5 rounded-xl min-h-11 border border-dashed border-edge px-2 py-3 text-body text-fg-secondary pressable active:bg-surface"
        >
          <Plus className="h-4 w-4" />
          手动创建
        </button>
        <button
          type="button"
          onClick={() => {
            setMessage(null);
            closeGh();
            setGhOpen(true);
          }}
          className="flex items-center justify-center gap-1.5 rounded-xl min-h-11 border border-dashed border-edge px-2 py-3 text-body text-fg-secondary pressable active:bg-surface"
        >
          <CloudDownload className="h-4 w-4" />
          GitHub
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.txt,.markdown,.zip,.skill"
        onChange={(e) => void handleFileSelected(e)}
        className="hidden"
      />

      {displayError && (
        <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-meta text-red-300">
          {displayError}
        </div>
      )}

      {loading && skills.length === 0 && (
        <p className="py-8 text-center text-body text-fg-tertiary">加载 Skills…</p>
      )}

      {!loading && skills.length === 0 && !displayError && (
        <p className="py-8 text-center text-body text-fg-tertiary">
          暂无 Skills，可导入 SKILL.md 文件或手动创建。
        </p>
      )}

      {sorted.map((skill) => {
        const builtin = isBuiltinSkill(skill);
        const isDragged = drag.draggingId === skill.id;
        return (
          <div
            key={skill.id}
            ref={builtin ? undefined : drag.registerItem(skill.id)}
            onTouchStart={builtin ? undefined : drag.onTouchStart(skill.id)}
            onTouchMove={drag.onTouchMovePending}
            onTouchEnd={drag.onTouchEndPending}
            style={{ transform: drag.translateFor(skill.id) }}
            className={
              'relative flex touch-pan-y items-center gap-3 rounded-xl border border-edge-subtle bg-surface px-3 py-3' +
              (drag.isDragging && !isDragged
                ? ' transition-transform duration-200 ease-out motion-reduce:transition-none'
                : '') +
              (isDragged
                ? ' z-50 shadow-raised shadow-black/40 ring-1 ring-indigo-400/60'
                : '')
            }
          >
          <button
            type="button"
            onClick={() => {
              if (drag.shouldSuppressClick()) return;
              setMessage(null);
              setForm({
                id: skill.id,
                name: skill.name,
                description: skill.description,
                prompt: skill.prompt,
                resources: skill.resources,
                readonly: builtin,
              });
            }}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="truncate text-body font-medium text-fg">
                {skill.name}
              </span>
              {builtin && (
                <span className="flex-shrink-0 rounded border border-edge bg-surface-raised px-1 py-px text-caption leading-4 text-fg-secondary">
                  内置
                </span>
              )}
              {skill.resources && skill.resources.length > 0 && (
                <span className="flex-shrink-0 rounded border border-edge bg-surface-raised px-1 py-px text-caption leading-4 text-fg-secondary">
                  {skill.resources.length} 资源
                </span>
              )}
            </div>
            {skill.description ? (
              <div className="mt-0.5 line-clamp-2 text-meta text-fg-tertiary">
                {skill.description}
              </div>
            ) : (
              <div className="mt-0.5 text-meta italic text-fg-disabled">无描述</div>
            )}
          </button>
          {/* Toggle 区域不参与长按拖拽 */}
          <div data-nodrag className="flex-shrink-0">
            <Toggle
              checked={skill.enabled}
              onChange={() => void toggleSkill(skill.id)}
            />
          </div>
          </div>
        );
      })}

      {/* Create / edit sheet */}
      <MobileSheet
        open={form != null}
        onClose={() => setForm(null)}
        title={form?.readonly ? '查看 Skill（内置）' : form?.id ? '编辑 Skill' : '新建 Skill'}
        footer={
          form?.readonly ? (
            <button
              type="button"
              onClick={() => setForm(null)}
              className="w-full rounded-xl bg-surface-raised px-4 py-3 text-body text-fg-secondary active:bg-state-mid"
            >
              关闭
            </button>
          ) : (
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
                  className="rounded-xl bg-surface-raised px-4 py-3 text-body text-red-300 active:bg-state-mid"
                >
                  删除
                </button>
              )}
              <button
                type="button"
                onClick={() => setForm(null)}
                className="flex-1 rounded-xl bg-surface-raised px-4 py-3 text-body text-fg-secondary active:bg-state-mid"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={saving}
                className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-body font-medium text-white active:bg-indigo-500 disabled:opacity-40"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          )
        }
      >
        {form && (
          <div className="space-y-3 px-4 pb-3">
            {message && (
              <div className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-meta text-red-300">
                {message}
              </div>
            )}
            {form.readonly && (
              <p className="text-meta text-fg-tertiary">
                内置 Skill 由应用维护并随版本自动更新，不可编辑或删除，可在列表中启用/禁用。
              </p>
            )}
            <div>
              <label className="mb-1 block text-meta text-fg-secondary">名称</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如：docker-debug"
                readOnly={form.readonly}
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-meta text-fg-secondary">
                描述（帮助 Agent 判断何时使用）
              </label>
              <input
                type="text"
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="排查 Docker 容器问题时使用"
                readOnly={form.readonly}
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1 block text-meta text-fg-secondary">
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
                readOnly={form.readonly}
                className={`${inputClass} resize-none font-mono text-meta leading-relaxed`}
              />
            </div>
            <SkillResourcesEditor
              resources={form.resources ?? []}
              onChange={(resources) => setForm({ ...form, resources })}
              readOnly={form.readonly}
              touch
            />
          </div>
        )}
      </MobileSheet>

      {/* GitHub import sheet */}
      <MobileSheet
        open={ghOpen}
        onClose={closeGh}
        title="从 GitHub 导入"
        footer={
          found ? (
            <button
              type="button"
              onClick={() => void handleGhImportSelected()}
              disabled={ghBusy || selected.size === 0}
              className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-body font-medium text-white active:bg-indigo-500 disabled:opacity-40"
            >
              {ghBusy ? '导入中…' : `导入选中（${selected.size}）`}
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={closeGh}
                className="flex-1 rounded-xl bg-surface-raised px-4 py-3 text-body text-fg-secondary active:bg-state-mid"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleGhFetch()}
                disabled={ghBusy || !ghUrl.trim()}
                className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-body font-medium text-white active:bg-indigo-500 disabled:opacity-40"
              >
                {ghBusy ? '拉取中…' : '拉取'}
              </button>
            </div>
          )
        }
      >
        <div className="space-y-3 px-4 pb-3">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-meta text-fg-secondary">仓库 / 目录 / 文件地址</label>
              <GithubImportGuideButton
                open={guideOpen}
                onToggle={() => setGuideOpen((v) => !v)}
                touch
              />
            </div>
            <input
              type="text"
              value={ghUrl}
              onChange={(e) => setGhUrl(e.target.value)}
              placeholder="https://github.com/owner/repo[/tree/main/skills]"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={ghBusy}
              className={inputClass}
            />
            <p className="mt-1 text-caption text-fg-tertiary">
              仓库根地址会列出其中所有 skill 供勾选；指向具体目录/文件的地址直接导入。
            </p>
          </div>
          {guideOpen && <GithubImportGuide touch />}

          {ghStatus && <div className="text-meta text-fg-tertiary">{ghStatus}</div>}
          {imp.active && (
            <SkillImportProgressBar progress={imp.progress} onCancel={imp.cancel} touch />
          )}

          {ghError && (
            <div className="whitespace-pre-wrap break-words rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-meta text-red-300">
              {ghError}
            </div>
          )}

          {found && (
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {found.skills.map((s) => (
                <label
                  key={s.subpath}
                  className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 active:bg-surface"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(s.subpath)}
                    onChange={() => toggleSelected(s.subpath)}
                    className="mt-0.5 accent-indigo-500"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-fg">{s.name}</span>
                    <span className="block truncate text-caption text-fg-tertiary">
                      {s.subpath}
                      {s.resourceCount > 0 ? ` · ${s.resourceCount} 个资源文件` : ''}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      </MobileSheet>

      {/* Delete confirm sheet */}
      <MobileSheet
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title="确认删除"
      >
        <div className="flex flex-col gap-2 px-4 pb-4">
          <p className="pb-1 text-body text-fg-secondary">
            删除 Skill「{deleteTarget?.name}」？此操作不可撤销。
          </p>
          <button
            type="button"
            onClick={() => void handleDelete()}
            className="rounded-xl bg-red-600 px-4 py-3 text-body font-medium text-white active:bg-red-500"
          >
            删除
          </button>
          <button
            type="button"
            onClick={() => setDeleteTarget(null)}
            className="rounded-xl px-4 py-3 text-body text-fg-secondary active:bg-state-soft"
          >
            取消
          </button>
        </div>
      </MobileSheet>
    </div>
  );
}
