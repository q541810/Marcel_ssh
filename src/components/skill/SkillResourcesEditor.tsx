import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  FolderPlus,
} from 'lucide-react';
import type { SkillResource } from '@/lib/types';
import { blobToText } from '@/lib/attachmentAttach';
import { getErrorMessage } from '@/lib/errors';
import {
  buildResourcePath,
  buildResourceTree,
  byteLength,
  findResourceDir,
  normalizeResourcePath,
  removeResourceDir,
  resourceDir,
  uniqueResourcePath,
  validateResourceBudget,
  validateResourcePath,
  type ResourceDirNode,
  type ResourceTreeNode,
} from '@/lib/skillResources';

interface Props {
  resources: SkillResource[];
  onChange: (next: SkillResource[]) => void;
  /** 内置 skill 等只读场景：只能看树和内容，没有任何操作 */
  readOnly?: boolean;
  /** 触屏尺寸（手机端）：所有可点元素 ≥ 44px */
  touch?: boolean;
}

type Creating = 'doc' | 'folder' | null;
interface Selection {
  kind: 'dir' | 'file';
  /** 目录路径（根为空串）或文件的完整路径 */
  path: string;
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * skill 附属资源（.md）编辑器，文件树形态。桌面编辑弹窗、新建弹窗与手机编辑 sheet 共用。
 *
 * 交互模型只有一个「当前选中项」：
 * - 树只负责选择与导航：点行 = 选中；点箭头 = 展开/折叠（两者互不干扰）；行内没有任何按钮。
 * - 所有操作集中在树下面的操作面板，作用于选中项：
 *   选中文件夹 → 导入文件 / 新建文档 / 新建文件夹 / 删除文件夹；
 *   选中文件 → 改路径（改名或移动）/ 编辑内容 / 删除文件。
 * - 删除一律两步：点一下变成「确认删除」，3 秒内不确认就还原（空文件夹直接删）。
 *
 * 路径的作用：Agent 读到 SKILL.md 后按「路径」取其中某个文档，所以路径要和正文里的引用
 * 一致；文件夹只是路径的一段，不对应真实目录，因此空文件夹不会随 skill 保存。
 */
export default function SkillResourcesEditor({
  resources,
  onChange,
  readOnly = false,
  touch = false,
}: Props) {
  const [selection, setSelection] = useState<Selection>({ kind: 'dir', path: '' });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  // 刚建、还没放文件的文件夹（只在编辑界面里存在）
  const [emptyDirs, setEmptyDirs] = useState<readonly string[]>([]);
  const [creating, setCreating] = useState<Creating>(null);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // 两步删除：3 秒内不确认就还原
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  if (readOnly && resources.length === 0) return null;

  const tree = buildResourceTree(resources, emptyDirs);

  // 选中项可能已不存在（文件被删、改名、文件夹被清空）→ 逐级回退到仍存在的最近祖先
  const effective = ((): Selection => {
    let sel = selection;
    if (sel.kind === 'file') {
      if (resources.some((r) => r.path === sel.path)) return sel;
      sel = { kind: 'dir', path: resourceDir(sel.path) };
    }
    while (sel.path && !findResourceDir(tree, sel.path)) {
      sel = { kind: 'dir', path: resourceDir(sel.path) };
    }
    return sel;
  })();
  const selDirNode = effective.kind === 'dir' ? findResourceDir(tree, effective.path) : null;
  const fileIndex =
    effective.kind === 'file' ? resources.findIndex((r) => r.path === effective.path) : -1;
  const selFile = fileIndex >= 0 ? resources[fileIndex] : null;

  const inputCls =
    'w-full rounded-lg bg-surface border border-edge px-3 text-fg font-mono ' +
    'placeholder-fg-tertiary focus:outline-none focus:border-indigo-500 ' +
    (touch ? 'py-3 text-body' : 'py-2 text-meta');
  // 外形与伸缩分开：并排的操作按钮 flex-1 均分；输入行里的「创建」定宽不换行
  const btnShape =
    'flex items-center justify-center gap-2 rounded-lg px-2 text-meta font-medium whitespace-nowrap ' +
    'transition-colors ' +
    (touch ? 'min-h-11' : 'h-8');
  const btnFill = 'bg-indigo-600 text-white hover:bg-indigo-500 active:bg-indigo-500';
  const btnPrimary = `${btnShape} min-w-0 flex-1 ${btnFill}`;
  const btnGhost = `${btnShape} min-w-0 flex-1 border border-edge text-fg hover:bg-state-soft active:bg-state-soft`;
  const btnCreate = `${btnShape} shrink-0 px-4 ${btnFill} disabled:opacity-40`;

  const clearMessages = () => {
    setError(null);
    setNotice(null);
  };

  /** 换选中项：输入行、删除确认、提示一并复位，避免上一个对象的状态残留。 */
  const select = (next: Selection) => {
    setSelection(next);
    setCreating(null);
    setNewName('');
    setConfirmDelete(null);
    clearMessages();
  };

  const apply = (next: SkillResource[]) => {
    const budget = validateResourceBudget(next);
    if (budget) {
      setError(budget);
      return false;
    }
    setError(null);
    onChange(next);
    return true;
  };

  const expandDir = (path: string) =>
    setCollapsed((old) => {
      if (!old.has(path)) return old;
      const next = new Set(old);
      next.delete(path);
      return next;
    });

  const toggleDir = (path: string) => {
    const willCollapse = !collapsed.has(path);
    setCollapsed((old) => {
      const next = new Set(old);
      if (willCollapse) next.add(path);
      else next.delete(path);
      return next;
    });
    // 折叠了包含选中项的文件夹 → 选中移到该文件夹，避免面板指向一个看不见的东西
    if (willCollapse && effective.path.startsWith(`${path}/`)) select({ kind: 'dir', path });
  };

  const handlePickFiles = async (dir: string, files: FileList | null) => {
    if (!files || files.length === 0) return;
    clearMessages();
    const taken = new Set(resources.map((r) => r.path));
    const added: SkillResource[] = [];
    const failed: string[] = [];
    let renamed = 0;
    for (const file of Array.from(files)) {
      try {
        const content = await blobToText(file);
        const wanted = buildResourcePath(dir, file.name);
        const invalid = validateResourcePath(wanted, []);
        if (invalid) throw new Error(invalid);
        const path = uniqueResourcePath(wanted, taken);
        if (path !== wanted) renamed++;
        taken.add(path);
        added.push({ path, content });
      } catch (e) {
        failed.push(`${file.name}：${getErrorMessage(e)}`);
      }
    }
    if (added.length && apply([...resources, ...added])) {
      expandDir(dir);
      setNotice(
        `已添加 ${added.length} 个文件` + (renamed ? `（${renamed} 个同名文件已自动改名）` : ''),
      );
    }
    if (failed.length) setError((old) => [old, ...failed].filter(Boolean).join('\n'));
  };

  const handleCreate = (dir: string) => {
    if (creating === 'folder') {
      const rel = normalizeResourcePath(newName).replace(/\/+$/, '');
      const path = joinPath(dir, rel);
      const err = rel ? validateResourcePath(`${path}/x.md`, []) : '请填写文件夹名';
      if (err) {
        setError(err.replace('资源路径', '文件夹路径'));
        return;
      }
      if (!emptyDirs.includes(path)) setEmptyDirs([...emptyDirs, path]);
      expandDir(dir);
      expandDir(path);
      select({ kind: 'dir', path });
    } else {
      const path = uniqueResourcePath(
        buildResourcePath(dir, newName),
        new Set(resources.map((r) => r.path)),
      );
      const err = validateResourcePath(path, resources);
      if (err) {
        setError(err);
        return;
      }
      if (!apply([...resources, { path, content: '' }])) return;
      expandDir(dir);
      select({ kind: 'file', path });
    }
  };

  const handleRename = (index: number, raw: string) => {
    const path = normalizeResourcePath(raw);
    if (path === resources[index].path) return;
    const err = validateResourcePath(path, resources, index);
    if (err) {
      setError(err);
      return;
    }
    if (apply(resources.map((r, i) => (i === index ? { ...r, path } : r)))) {
      setSelection({ kind: 'file', path });
    }
  };

  const handleDeleteFile = (index: number) => {
    const path = resources[index].path;
    if (confirmDelete !== `file:${path}`) {
      setConfirmDelete(`file:${path}`);
      return;
    }
    select({ kind: 'dir', path: resourceDir(path) });
    onChange(resources.filter((_, j) => j !== index));
  };

  const handleDeleteDir = (node: ResourceDirNode) => {
    // 空文件夹没有可丢的东西，直接删；有文件则两步确认
    if (node.fileCount > 0 && confirmDelete !== `dir:${node.path}`) {
      setConfirmDelete(`dir:${node.path}`);
      return;
    }
    setEmptyDirs((old) => old.filter((d) => d !== node.path && !d.startsWith(`${node.path}/`)));
    select({ kind: 'dir', path: resourceDir(node.path) });
    if (node.fileCount > 0) onChange(removeResourceDir(resources, node.path));
  };

  const indentGuides = (depth: number) =>
    Array.from({ length: depth }, (_, i) => (
      <span key={i} aria-hidden className='ml-2 w-3.5 shrink-0 border-l border-edge-subtle' />
    ));
  const rowHeight = touch ? 'min-h-11' : 'min-h-7';
  const slot = touch ? 'w-9' : 'w-5';

  /** 树里的一行：[缩进线][箭头按钮（仅文件夹）][选中按钮：图标+名称][右侧附注] */
  const row = (opts: {
    key: string;
    depth: number;
    selected: boolean;
    onSelect?: () => void;
    chevron?: { collapsed: boolean; onToggle: () => void; label: string };
    /** 根目录：始终展开，箭头只是占位对齐，不可点 */
    fixedOpen?: boolean;
    children: ReactNode;
    aside?: ReactNode;
  }) => (
    <li key={opts.key}>
      <div
        className={`flex items-stretch pl-2 pr-3 transition-colors ${rowHeight} ${
          opts.selected ? 'bg-indigo-500/15' : ''
        }`}
      >
        {indentGuides(opts.depth)}
        {opts.chevron ? (
          <button
            type='button'
            aria-label={opts.chevron.label}
            aria-expanded={!opts.chevron.collapsed}
            onClick={opts.chevron.onToggle}
            className={`flex shrink-0 items-center justify-center text-fg-tertiary hover:text-fg-secondary ${slot}`}
          >
            {opts.chevron.collapsed ? (
              <ChevronRight className='h-3.5 w-3.5' />
            ) : (
              <ChevronDown className='h-3.5 w-3.5' />
            )}
          </button>
        ) : opts.fixedOpen ? (
          <span aria-hidden className={`flex shrink-0 items-center justify-center text-fg-disabled ${slot}`}>
            <ChevronDown className='h-3.5 w-3.5' />
          </span>
        ) : (
          <span className={`shrink-0 ${slot}`} />
        )}
        <button
          type='button'
          onClick={opts.onSelect}
          disabled={!opts.onSelect}
          aria-current={opts.selected || undefined}
          className={`flex min-w-0 flex-1 items-center gap-2 py-1 text-left disabled:cursor-default ${
            opts.selected || !opts.onSelect ? '' : 'hover:text-fg'
          }`}
        >
          {opts.children}
        </button>
        {opts.aside !== undefined && (
          <span className='flex shrink-0 items-center pl-2 text-caption text-fg-tertiary'>{opts.aside}</span>
        )}
      </div>
    </li>
  );

  const renderNode = (node: ResourceTreeNode, depth: number): ReactNode => {
    if (node.kind === 'file') {
      const r = resources[node.index];
      const selected = effective.kind === 'file' && effective.path === r.path;
      return row({
        key: `f:${r.path}`,
        depth,
        selected,
        onSelect: () => select({ kind: 'file', path: r.path }),
        aside: fmtSize(byteLength(r.content)),
        children: (
          <>
            <FileText className='h-3.5 w-3.5 shrink-0 text-fg-tertiary' />
            <span className={`truncate font-mono text-meta ${selected ? 'text-white' : 'text-fg-secondary'}`}>
              {node.name}
            </span>
          </>
        ),
      });
    }
    const isCollapsed = collapsed.has(node.path);
    const selected = effective.kind === 'dir' && effective.path === node.path;
    return (
      <Fragment key={`d:${node.path}`}>
        {row({
          key: `d:${node.path}`,
          depth,
          selected,
          onSelect: () => select({ kind: 'dir', path: node.path }),
          chevron: {
            collapsed: isCollapsed,
            onToggle: () => toggleDir(node.path),
            label: `${isCollapsed ? '展开' : '折叠'} ${node.name}`,
          },
          aside: node.fileCount === 0 ? '空' : node.fileCount,
          children: (
            <>
              {isCollapsed ? (
                <Folder className='h-3.5 w-3.5 shrink-0 text-fg-secondary' />
              ) : (
                <FolderOpen className='h-3.5 w-3.5 shrink-0 text-fg-secondary' />
              )}
              <span className={`truncate font-mono text-meta ${selected ? 'text-white' : 'text-fg'}`}>
                {node.name}
              </span>
            </>
          ),
        })}
        {!isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
      </Fragment>
    );
  };

  const rootSelected = effective.kind === 'dir' && effective.path === '';

  // ── 操作面板：选中文件夹 ──
  const dirPanel = (node: ResourceDirNode) => {
    const isRoot = node.path === '';
    const confirming = confirmDelete === `dir:${node.path}`;
    return (
      <div className='mt-2 space-y-2 rounded-xl border border-edge-subtle bg-surface/50 p-3'>
        <div className='flex items-center gap-2'>
          <FolderOpen className='h-4 w-4 shrink-0 text-fg-secondary' />
          <span className='min-w-0 flex-1 truncate font-mono text-meta text-fg'>
            {isRoot ? '根目录（与 SKILL.md 同级）' : `${node.path}/`}
          </span>
          <span className='shrink-0 text-caption text-fg-tertiary'>{node.fileCount} 个文件</span>
        </div>

        <div className='flex gap-2'>
          <button type='button' onClick={() => fileInput.current?.click()} className={btnPrimary}>
            <FileUp className='h-4 w-4 shrink-0 max-[380px]:hidden' />
            导入文件
          </button>
          <button
            type='button'
            onClick={() => {
              setCreating((v) => (v === 'doc' ? null : 'doc'));
              setNewName('');
              setError(null);
            }}
            aria-expanded={creating === 'doc'}
            className={btnGhost}
          >
            <FilePlus2 className='h-4 w-4 shrink-0 max-[380px]:hidden' />
            新建文档
          </button>
          <button
            type='button'
            onClick={() => {
              setCreating((v) => (v === 'folder' ? null : 'folder'));
              setNewName('');
              setError(null);
            }}
            aria-expanded={creating === 'folder'}
            className={btnGhost}
          >
            <FolderPlus className='h-4 w-4 shrink-0 max-[380px]:hidden' />
            新建文件夹
          </button>
          <input
            ref={fileInput}
            type='file'
            multiple
            accept='.md,.markdown,.txt,text/markdown,text/plain'
            className='hidden'
            onChange={(e) => {
              const input = e.target;
              void handlePickFiles(node.path, input.files).finally(() => {
                input.value = '';
              });
            }}
          />
        </div>

        {creating && (
          <div className='flex gap-2'>
            <input
              type='text'
              value={newName}
              autoFocus
              onChange={(e) => {
                setNewName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleCreate(node.path);
                }
              }}
              placeholder={creating === 'folder' ? '文件夹名，如 references' : '文件名，如 api（自动补 .md）'}
              spellCheck={false}
              autoCapitalize='off'
              autoCorrect='off'
              className={inputCls + ' min-w-0 flex-1'}
            />
            <button
              type='button'
              onClick={() => handleCreate(node.path)}
              disabled={!newName.trim()}
              className={btnCreate}
            >
              创建
            </button>
          </div>
        )}

        {node.fileCount === 0 && !isRoot && (
          <p className='text-caption text-fg-tertiary'>空文件夹不会随 skill 保存，放入文件后才会保留。</p>
        )}

        {!isRoot && (
          <div className='flex justify-end border-t border-edge-subtle pt-2'>
            <button
              type='button'
              onClick={() => handleDeleteDir(node)}
              className={
                'rounded-lg px-3 text-meta font-medium transition-colors ' +
                (touch ? 'min-h-11 ' : 'h-7 ') +
                (confirming
                  ? 'bg-red-600 text-white hover:bg-red-500'
                  : 'text-red-400 hover:bg-red-500/10 active:bg-red-500/10')
              }
            >
              {confirming ? `确认删除（含 ${node.fileCount} 个文件）` : '删除文件夹'}
            </button>
          </div>
        )}
      </div>
    );
  };

  // ── 操作面板：选中文件 ──
  const filePanel = (r: SkillResource, index: number) => {
    const confirming = confirmDelete === `file:${r.path}`;
    return (
      <div className='mt-2 rounded-xl border border-edge-subtle bg-surface/50 p-3'>
        <div className='mb-2'>
          {readOnly ? (
            <span className='block truncate font-mono text-meta text-fg'>{r.path}</span>
          ) : (
            <input
              key={r.path}
              type='text'
              defaultValue={r.path}
              onBlur={(e) => handleRename(index, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              aria-label='资源路径（改它即可改名或移动到其他文件夹）'
              spellCheck={false}
              autoCapitalize='off'
              autoCorrect='off'
              className={inputCls}
            />
          )}
        </div>
        <textarea
          value={r.content}
          readOnly={readOnly}
          onChange={(e) =>
            apply(resources.map((x, j) => (j === index ? { ...x, content: e.target.value } : x)))
          }
          spellCheck={false}
          autoCapitalize='off'
          autoCorrect='off'
          rows={touch ? 9 : 10}
          placeholder='# 文档内容…'
          className={inputCls + ' min-h-32 resize-y leading-relaxed'}
        />
        <div className='mt-2 flex items-center justify-between gap-2'>
          <span className='text-caption text-fg-tertiary'>
            {fmtSize(byteLength(r.content))}
            {!readOnly && ' · 改上方路径即可改名或移动'}
          </span>
          {!readOnly && (
            <button
              type='button'
              onClick={() => handleDeleteFile(index)}
              className={
                'shrink-0 rounded-lg px-3 text-meta font-medium transition-colors ' +
                (touch ? 'min-h-11 ' : 'h-7 ') +
                (confirming
                  ? 'bg-red-600 text-white hover:bg-red-500'
                  : 'text-red-400 hover:bg-red-500/10 active:bg-red-500/10')
              }
            >
              {confirming ? '确认删除' : '删除文件'}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      <label className='mb-1 block text-meta text-fg-secondary'>附属资源文件（{resources.length}）</label>
      <p className='text-caption leading-relaxed text-fg-tertiary'>
        Agent 读完 SKILL.md 后，按路径读取这些文档。
      </p>
      <details className='group mb-2 text-caption text-fg-tertiary'>
        <summary className='inline-flex cursor-pointer select-none list-none items-center gap-1 py-1 text-indigo-300/80 hover:text-indigo-300 [&::-webkit-details-marker]:hidden'>
          <ChevronRight className='h-3 w-3 transition-transform group-open:rotate-90' />
          路径有什么用？
        </summary>
        <p className='rounded-lg bg-surface/60 px-3 py-2 leading-relaxed'>
          路径必须和 SKILL.md 正文里的引用一致。例如正文写了「详见 references/api.md」，就把文件放进
          references 文件夹，文件名为 api.md；Agent 会用这个路径去读。文件夹只是路径的一段，并不是真实目录。
        </p>
      </details>

      <ul className='overflow-hidden rounded-xl border border-edge-subtle bg-surface/50 py-1'>
        {row({
          key: 'root',
          depth: 0,
          selected: rootSelected,
          onSelect: readOnly ? undefined : () => select({ kind: 'dir', path: '' }),
          fixedOpen: true,
          children: (
            <>
              <FolderOpen className='h-3.5 w-3.5 shrink-0 text-fg-secondary' />
              <span className={`font-mono text-meta ${rootSelected ? 'text-white' : 'text-fg'}`}>
                根目录
              </span>
            </>
          ),
        })}
        {row({
          key: 'skill-md',
          depth: 1,
          selected: false,
          aside: '入口',
          children: (
            <>
              <FileText className='h-3.5 w-3.5 shrink-0 text-indigo-400' />
              <span className='font-mono text-meta text-fg'>SKILL.md</span>
              <span className='truncate text-caption text-fg-disabled'>内容在上方「提示词内容」</span>
            </>
          ),
        })}
        {tree.children.map((c) => renderNode(c, 1))}
        {resources.length === 0 && emptyDirs.length === 0 && (
          <li className={`text-caption text-fg-disabled ${touch ? 'py-3' : 'py-2'}`} style={{ paddingLeft: 56 }}>
            还没有附属文件
          </li>
        )}
      </ul>

      {selFile ? filePanel(selFile, fileIndex) : !readOnly && selDirNode ? dirPanel(selDirNode) : null}

      {notice && <p className='mt-2 text-caption text-emerald-400'>{notice}</p>}
      {error && <p className='mt-2 whitespace-pre-line text-caption text-red-400'>{error}</p>}
    </div>
  );
}
