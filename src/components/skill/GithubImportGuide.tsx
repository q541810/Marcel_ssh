import { useState } from 'react';
import { CircleHelp } from 'lucide-react';

/** 「?」按钮：点击展开 / 收起 GitHub 导入说明。桌面与手机共用同一份文案。 */
export function GithubImportGuideButton({
  open,
  onToggle,
  touch = false,
}: {
  open: boolean;
  onToggle: () => void;
  touch?: boolean;
}) {
  return (
    <button
      type='button'
      onClick={onToggle}
      aria-expanded={open}
      aria-label='GitHub 导入说明'
      className={
        'flex shrink-0 items-center gap-1 rounded-md text-fg-secondary hover:text-fg active:text-fg ' +
        (open ? 'text-indigo-400 ' : '') +
        (touch ? 'px-2 py-2 text-meta' : 'px-2 py-0.5 text-caption')
      }
    >
      <CircleHelp className={touch ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
      怎么填
    </button>
  );
}

const EXAMPLES: { title: string; url: string; desc: string }[] = [
  {
    title: '仓库地址',
    url: 'https://github.com/owner/repo',
    desc: '扫描整个仓库，列出所有含 SKILL.md 的目录供你勾选，可一次导入多个。仓库里只有一个 skill 时直接拉取并预览。',
  },
  {
    title: '目录地址',
    url: 'https://github.com/owner/repo/tree/main/skills/foo',
    desc: '只导入这个目录。该目录下必须直接有 SKILL.md；如果它下面还分了好几个 skill，请改贴仓库地址再勾选。',
  },
  {
    title: '文件地址',
    url: 'https://github.com/owner/repo/blob/main/skills/foo/SKILL.md',
    desc: '在 GitHub 上打开某个 SKILL.md 后复制浏览器地址即可，效果等同于它所在的目录。',
  },
];

const NOTES = [
  'SKILL.md 是入口：开头的 name / description 作为名称与描述，正文作为指令。',
  '同目录及子目录里的其它 .md（如 references/xxx.md）会作为资源一起导入，Agent 需要时按路径读取；脚本、图片等非 .md 文件会被忽略。',
  '资源限制：单个文件 ≤ 1 MB，合计 ≤ 4 MB，最多 100 个。',
  '只支持公开仓库。地址不写分支时依次尝试 main、master；分支名含 “/” 的暂不支持。',
  '拉取只是预览，确认保存后才会加入你的 skill 列表；导入后仍可编辑指令和资源。',
  '访问 GitHub 慢时会自动走镜像，可在「市场」设置里更换镜像源。',
];

/** GitHub 导入的完整引导：三种地址写法 + 导入规则。 */
export default function GithubImportGuide({ touch = false }: { touch?: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (url: string) => {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(url);
        setTimeout(() => setCopied((c) => (c === url ? null : c)), 1200);
      })
      .catch(() => {});
  };

  return (
    <div className='space-y-3 rounded-lg border border-edge/60 bg-surface/60 p-3'>
      <div className='space-y-2'>
        <div className='text-meta font-medium text-fg-secondary'>可以贴这三种地址</div>
        {EXAMPLES.map((e) => (
          <div key={e.title} className='space-y-1'>
            <div className='text-caption text-fg-secondary'>{e.title}</div>
            <button
              type='button'
              onClick={() => copy(e.url)}
              title='点击复制示例'
              className={
                'block w-full break-all rounded bg-surface-sunken px-2 py-1 text-left font-mono text-fg-secondary hover:bg-state-soft active:bg-state-soft ' +
                (touch ? 'text-caption' : 'text-caption')
              }
            >
              {e.url}
              {copied === e.url && <span className='ml-2 text-emerald-400'>已复制</span>}
            </button>
            <p className='text-caption leading-relaxed text-fg-tertiary'>{e.desc}</p>
          </div>
        ))}
      </div>
      <div className='space-y-1'>
        <div className='text-meta font-medium text-fg-secondary'>导入规则</div>
        <ul className='list-disc space-y-1 pl-4 text-caption leading-relaxed text-fg-tertiary'>
          {NOTES.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
