import { useEffect, useRef, useState } from 'react';
import { useSkillStore } from '@/stores/skillStore';
import type { Skill } from '@/lib/types';

// ---------- Helpers: file parsing ----------

interface ParsedSkill {
  name: string;
  description: string;
  prompt: string;
}

function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}

/**
 * Parse a single imported file into one or more skills.
 * Supports:
 *  - .json: { name, description?, prompt } OR { skills: [...] } OR an array
 *  - .md / .txt / fallback: filename as name; first `# heading` (if any) overrides;
 *    rest of file is the prompt.
 */
function parseFile(name: string, content: string): ParsedSkill[] {
  const lower = name.toLowerCase();
  const trimmed = content.trim();

  if (lower.endsWith('.json')) {
    try {
      const data = JSON.parse(trimmed);
      const items: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray((data as { skills?: unknown[] }).skills)
        ? (data as { skills: unknown[] }).skills
        : [data];
      return items
        .map((it) => {
          const o = it as Record<string, unknown>;
          const skillName = typeof o.name === 'string' && o.name.trim().length > 0
            ? o.name.trim()
            : stripExtension(name);
          const prompt = typeof o.prompt === 'string' ? o.prompt : '';
          const description = typeof o.description === 'string' ? o.description : '';
          if (!prompt.trim()) return null;
          return { name: skillName, description, prompt };
        })
        .filter((x): x is ParsedSkill => x !== null);
    } catch {
      throw new Error('JSON 解析失败: ' + name);
    }
  }

  // Markdown / plain text fallback.
  let skillName = stripExtension(name);
  let body = trimmed;
  const firstLineEnd = body.indexOf('\n');
  const firstLine = (firstLineEnd === -1 ? body : body.slice(0, firstLineEnd)).trim();
  const headingMatch = /^#\s+(.+)$/.exec(firstLine);
  if (headingMatch) {
    skillName = headingMatch[1].trim();
    body = firstLineEnd === -1 ? '' : body.slice(firstLineEnd + 1).trim();
  }
  if (!body) throw new Error('文件内容为空: ' + name);
  return [{ name: skillName, description: '', prompt: body }];
}

// ---------- SkillCard ----------

interface SkillCardProps {
  skill: Skill;
  onToggle: () => void;
  onDelete: () => void;
}

function SkillCard({ skill, onToggle, onDelete }: SkillCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={
        'group rounded-lg border transition-colors px-2 py-2 ' +
        (skill.enabled
          ? 'bg-indigo-900/20 border-indigo-700/50'
          : 'bg-zinc-800/40 border-transparent hover:border-zinc-700')
      }
    >
      <div className='flex items-center gap-2'>
        <button
          onClick={onToggle}
          title={skill.enabled ? '禁用' : '启用'}
          className={
            'flex-shrink-0 relative w-7 h-4 rounded-full transition-colors ' +
            (skill.enabled ? 'bg-indigo-500' : 'bg-zinc-700')
          }
        >
          <span
            className={
              'absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ' +
              (skill.enabled ? 'left-3.5' : 'left-0.5')
            }
          />
        </button>
        <button
          onClick={() => setExpanded((v) => !v)}
          className='flex-1 min-w-0 text-left'
        >
          <div className='text-sm font-medium text-zinc-200 truncate'>{skill.name}</div>
          {skill.description && (
            <div className='text-xs text-zinc-500 truncate'>{skill.description}</div>
          )}
        </button>
        <button
          onClick={onDelete}
          title='删除'
          className='flex-shrink-0 p-1 rounded-md text-zinc-500 hover:text-red-400 hover:bg-zinc-800 opacity-0 group-hover:opacity-100 transition-all'
        >
          <svg className='w-3.5 h-3.5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
            <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3' />
          </svg>
        </button>
      </div>
      {expanded && (
        <pre className='mt-2 text-xs text-zinc-400 whitespace-pre-wrap break-words font-sans px-1'>
{skill.prompt}
        </pre>
      )}
    </div>
  );
}

// ---------- Main ----------

export default function SkillList() {
  const skills = useSkillStore((s) => s.skills);
  const loading = useSkillStore((s) => s.loading);
  const error = useSkillStore((s) => s.error);
  const fetchSkills = useSkillStore((s) => s.fetchSkills);
  const addSkill = useSkillStore((s) => s.addSkill);
  const toggleSkill = useSkillStore((s) => s.toggleSkill);
  const deleteSkill = useSkillStore((s) => s.deleteSkill);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const filtered = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.description.toLowerCase().includes(searchQuery.toLowerCase()),
  );
  const enabledCount = skills.filter((s) => s.enabled).length;

  const handleImport = () => {
    setImportError(null);
    fileInputRef.current?.click();
  };

  const onFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setImporting(true);
    setImportError(null);
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const text = await file.text();
        const parsed = parseFile(file.name, text);
        for (const p of parsed) {
          await addSkill(p.name, p.description, p.prompt);
        }
      } catch (err) {
        errors.push(String(err instanceof Error ? err.message : err));
      }
    }
    if (errors.length > 0) setImportError(errors.join('\n'));
    setImporting(false);
    // Reset input so the same file can be re-imported later
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='flex items-center justify-between px-3 py-2 border-b border-zinc-800'>
        <h2 className='text-xs font-semibold text-zinc-400 uppercase tracking-wider'>
          技能
        </h2>
        <button
          onClick={handleImport}
          disabled={importing}
          className='p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 disabled:opacity-50 transition-colors'
          title='从文件导入技能'
          aria-label='从文件导入技能'
        >
          <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
            <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5-5m0 0l5 5m-5-5v12' />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type='file'
          multiple
          accept='.md,.txt,.json'
          onChange={onFilesSelected}
          className='hidden'
        />
      </div>

      {/* Search */}
      <div className='p-2 border-b border-zinc-800'>
        <input
          type='text'
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder='搜索技能...'
          className='w-full rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500'
        />
      </div>

      {/* Status row */}
      {(skills.length > 0 || importError || error) && (
        <div className='px-3 py-1.5 border-b border-zinc-800/50 text-xs text-zinc-500'>
          {skills.length > 0 && (
            <span>{skills.length} 个技能 · {enabledCount} 个已启用</span>
          )}
          {importError && (
            <div className='mt-1 text-red-400 whitespace-pre-wrap'>{importError}</div>
          )}
          {error && !importError && (
            <div className='mt-1 text-red-400'>{error}</div>
          )}
        </div>
      )}

      {/* List */}
      <div className='flex-1 overflow-y-auto p-2 space-y-1'>
        {loading && skills.length === 0 && (
          <p className='text-sm text-zinc-500 text-center mt-4'>加载中...</p>
        )}

        {!loading && skills.length === 0 && (
          <div className='text-center mt-6 px-3'>
            <p className='text-sm text-zinc-500 mb-3'>暂无技能</p>
            <button
              onClick={handleImport}
              className='text-xs text-indigo-400 hover:text-indigo-300 underline'
            >
              从文件导入技能
            </button>
            <p className='text-xs text-zinc-600 mt-3 leading-relaxed'>
              支持 .md / .txt / .json 文件。<br />
              JSON 可包含单个对象或 skills 数组。
            </p>
          </div>
        )}

        {filtered.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            onToggle={() => toggleSkill(skill.id)}
            onDelete={() => {
              if (confirm('确定删除技能 ' + skill.name + ' ?')) deleteSkill(skill.id);
            }}
          />
        ))}

        {!loading && skills.length > 0 && filtered.length === 0 && (
          <p className='text-sm text-zinc-500 text-center mt-4'>无匹配技能</p>
        )}
      </div>
    </div>
  );
}