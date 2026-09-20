import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ICON_PATHS,
  FILE_CHANGE_TOOL_NAMES,
  SKILL_TOOL_PREFIX,
  TOOL_CATALOG,
  isExplorationTool,
  isPlanTool,
  isSkillTool,
  isStreamingTool,
  isSubagentTool,
  toolDisplayName,
  toolIconPaths,
  toolLabel,
  toolPartialPreview,
  toolPreview,
  toolSpec,
} from '@/lib/toolCatalog';

describe('toolPreview', () => {
  it('shows a single web_search query', () => {
    expect(toolPreview('web_search', { query: '水月雨 Kadenz' })).toBe('水月雨 Kadenz');
  });

  it('does not preview deprecated web_search queries arrays', () => {
    expect(toolPreview('web_search', { queries: ['a', 'b'] })).toBe('');
  });

  it('shows a single http_get url', () => {
    expect(toolPreview('http_get', { url: 'https://example.com/a' })).toBe(
      'https://example.com/a',
    );
  });

  it('shows http_get urls array preview', () => {
    expect(
      toolPreview('http_get', {
        urls: ['https://example.com/a', 'https://example.org/b', 'https://example.net/c'],
      }),
    ).toBe('https://example.com/a +2 more');
  });

  it('shows subagent description preview', () => {
    expect(toolPreview('subagent', { description: 'explore nginx config' })).toBe(
      'explore nginx config',
    );
  });

  it('falls back to prompt when subagent has no description', () => {
    expect(toolPreview('subagent', { prompt: 'look at /etc/nginx/nginx.conf' })).toBe(
      'look at /etc/nginx/nginx.conf',
    );
  });

  it('truncates long subagent descriptions', () => {
    const long = 'a'.repeat(100);
    expect(toolPreview('subagent', { description: long })).toBe('a'.repeat(40) + '...');
  });

  it('returns empty preview for subagent without arguments', () => {
    expect(toolPreview('subagent', {})).toBe('');
  });

  it('still previews legacy task tool name (history compatibility)', () => {
    expect(toolPreview('task', { description: 'legacy' })).toBe('legacy');
  });

  it('prefixes shell commands with $ and truncates them', () => {
    expect(toolPreview('bash', { command: 'ls -la' })).toBe('$ ls -la');
    expect(toolPreview('execute_command', { command: 'x'.repeat(50) })).toBe(
      `$ ${'x'.repeat(40)}...`,
    );
  });

  it('shows paths for file tools and root for a bare list_directory', () => {
    expect(toolPreview('read_file', { path: '/etc/hosts' })).toBe('/etc/hosts');
    expect(toolPreview('edit_file', { path: '/etc/hosts' })).toBe('/etc/hosts');
    expect(toolPreview('list_directory', {})).toBe('/');
    // 空串也回退到根目录（原实现是真值判断，不是 null 判断）
    expect(toolPreview('list_directory', { path: '' })).toBe('/');
    // 文件工具反之：空路径就是空预览，不回退
    expect(toolPreview('read_file', { path: '' })).toBe('');
  });

  it('unwraps {value}/{text} argument wrappers the model sometimes emits', () => {
    expect(toolPreview('bash', { command: { value: 'uptime' } })).toBe('$ uptime');
  });

  it('returns empty preview when args are missing entirely', () => {
    expect(toolPreview('bash', undefined)).toBe('');
  });

  it('returns empty preview for skill tools (they render as a name line)', () => {
    expect(toolPreview(`${SKILL_TOOL_PREFIX}deploy`, { anything: 'x' })).toBe('');
  });

  it('returns empty preview for tools without a declared preview', () => {
    expect(toolPreview('connection_info', { host: 'x' })).toBe('');
    expect(toolPreview('render_html', { html: '<p/>' })).toBe('');
  });
});

describe('toolCatalog 表结构', () => {
  it('名字与别名全局唯一（重名会让一个工具静默渲染成另一个）', () => {
    const seen = new Map<string, string>();
    for (const spec of TOOL_CATALOG) {
      for (const name of [spec.name, ...(spec.aliases ?? [])]) {
        const owner = seen.get(name);
        expect(owner, `「${name}」同时被 ${owner} 和 ${spec.name} 占用`).toBeUndefined();
        seen.set(name, spec.name);
      }
    }
    expect(seen.size).toBe(
      TOOL_CATALOG.length + TOOL_CATALOG.reduce((n, s) => n + (s.aliases?.length ?? 0), 0),
    );
  });

  it('别名解析到同一个规格对象（旧会话回放与新会话同一条路径）', () => {
    for (const spec of TOOL_CATALOG) {
      for (const alias of spec.aliases ?? []) {
        expect(toolSpec(alias), alias).toBe(spec);
      }
    }
  });

  it('保留历史工具名，否则旧会话的工具卡片会退化成默认外观', () => {
    // execute_command / task 是改名前的名字，历史消息里全是它们。
    expect(toolSpec('execute_command')).toBe(toolSpec('bash'));
    expect(toolSpec('task')).toBe(toolSpec('subagent'));
  });

  it('plan 行必须声明 label（卡片把这些工具渲染成一行状态文字）', () => {
    const planRows = TOOL_CATALOG.filter((s) => s.group === 'plan');
    expect(planRows.length).toBeGreaterThan(0);
    for (const spec of planRows) {
      expect(spec.label, spec.name).toBeTruthy();
    }
  });

  it('声明的图标路径非空（空数组会渲染成一个看不见的 svg）', () => {
    for (const spec of TOOL_CATALOG) {
      if (spec.iconPaths) expect(spec.iconPaths.length, spec.name).toBeGreaterThan(0);
    }
    expect(DEFAULT_ICON_PATHS.length).toBeGreaterThan(0);
  });

  it('payload: file-change 的行必须都是 FileChangeView 认得的工具', () => {
    const declared = TOOL_CATALOG.filter((s) => s.payload === 'file-change')
      .map((s) => s.name)
      .sort();
    expect(declared).toEqual([...FILE_CHANGE_TOOL_NAMES].sort());
  });
});

describe('toolDisplayName / 分组判定', () => {
  it('未登记的工具原样显示名字（插件、MCP、还没配图标的内置工具）', () => {
    expect(toolDisplayName('some_plugin_tool')).toEqual({
      display: 'some_plugin_tool',
      isSkill: false,
    });
    expect(toolDisplayName('x')).toEqual({ display: 'x', isSkill: false });
  });

  it('skill 走独立的「SKILL 名字」形态并标记 isSkill', () => {
    expect(toolDisplayName(`${SKILL_TOOL_PREFIX}deploy`)).toEqual({
      display: 'SKILL deploy',
      isSkill: true,
    });
    expect(isSkillTool(`${SKILL_TOOL_PREFIX}deploy`)).toBe(true);
    expect(isSkillTool('bash')).toBe(false);
  });

  it('改名工具用 label 显示（含旧名）', () => {
    expect(toolDisplayName('subagent').display).toBe('子agent');
    // task 有 label（子agent），所以旧名也显示成 label
    expect(toolDisplayName('task').display).toBe('子agent');
    // bash 没有 label → 显示名回退到「传入的名字」：旧会话保持当年的样子
    expect(toolDisplayName('bash').display).toBe('bash');
    expect(toolDisplayName('execute_command').display).toBe('execute_command');
    expect(toolLabel('create_plan')).toBe('创建plan');
    expect(toolLabel('unknown_tool')).toBe('unknown_tool');
  });

  it('图标回退到默认齿轮', () => {
    expect(toolIconPaths('bash')).not.toBe(DEFAULT_ICON_PATHS);
    expect(toolIconPaths('some_plugin_tool')).toBe(DEFAULT_ICON_PATHS);
  });

  it('同类动作共用同一个图标（write_file / edit_file 都是改文件内容）', () => {
    // edit_file 历史上漏配图标、掉回默认齿轮 —— 它是审批最频繁的工具，
    // 跟 write_file 长得不一样会让人以为是两种操作。
    const pencil = toolIconPaths('write_file');
    expect(pencil).not.toBe(DEFAULT_ICON_PATHS);
    expect(toolIconPaths('edit_file')).toBe(pencil);
  });

  it('探索分组只收声明过的工具（bash 的旧名 execute_command 不在其中）', () => {
    for (const name of ['web_search', 'http_get', 'read_file', 'search_files', 'list_directory', 'system_info']) {
      expect(isExplorationTool(name), name).toBe(true);
    }
    expect(isExplorationTool('write_file')).toBe(false);
    expect(isExplorationTool('execute_command')).toBe(false);
  });

  it('plan 分组与 subagent 判定', () => {
    for (const name of ['create_plan', 'update_plan_item', 'edit_plan']) {
      expect(isPlanTool(name), name).toBe(true);
    }
    expect(isPlanTool('bash')).toBe(false);
    expect(isSubagentTool('subagent')).toBe(true);
    expect(isSubagentTool('task')).toBe(true);
    expect(isSubagentTool('bash')).toBe(false);
  });

  it('流式输出判定（决定用户中断时的文案：close 通道 vs 可能已完成）', () => {
    expect(isStreamingTool('bash')).toBe(true);
    expect(isStreamingTool('execute_command')).toBe(true);
    expect(isStreamingTool('read_file')).toBe(false);
    expect(isStreamingTool('subagent')).toBe(false);
  });

  it('流式部分参数预览字段只登记给需要的工具', () => {
    expect(toolPartialPreview('render_html')).toEqual({
      primary: 'fragment',
      companions: ['title', 'mode'],
    });
    expect(toolPartialPreview('bash')).toBeUndefined();
    expect(toolPartialPreview('unknown_tool')).toBeUndefined();
  });

  it('联网工具声明（决定是否读降级/拦截 metadata）', () => {
    // 谓词本体在 `webToolStatus.ts`（那边 `isWebTool` 读的就是这个声明）。
    // 这里断言声明本身，避免在 catalog 里再导出一个同名的第二份。
    expect(toolSpec('web_search')?.web).toBe(true);
    expect(toolSpec('http_get')?.web).toBe(true);
    expect(toolSpec('bash')?.web).toBeUndefined();
    expect(toolSpec('read_file')?.web).toBeUndefined();
  });

  it('参数主体形态声明（决定命令超时药丸与展开区的 diff 视图）', () => {
    expect(toolSpec('bash')?.payload).toBe('command');
    expect(toolSpec('execute_command')?.payload).toBe('command');
    expect(toolSpec('write_file')?.payload).toBe('file-change');
    expect(toolSpec('edit_file')?.payload).toBe('file-change');
    expect(toolSpec('read_file')?.payload).toBeUndefined();
  });
});

/**
 * 剥掉注释（`//`、`/* *\/`，含 JSX 的 `{/* *\/}`），字符串/模板串原样保留。
 *
 * 守卫必须剥注释：不剥的话「`// 历史写法 toolName === 'bash' 已迁到 catalog`」
 * 这种说明性注释会被当成违规，断言文案还会把人往"代码里仍有写死判定"的错方向指。
 *
 * **已知假阴性**：字符串里的 `//` 与 `/*` 会被正确跳过，但**正则字面量**不会 ——
 * 形如 `const re = /https:\/\//;` 的行，`//` 之后的内容会被当注释剥掉。实测注入
 * `const re = /https:\/\//; const bad = (n) => n === 'bash';` 时违规被吞掉。
 * 当前 8 个消费方都没有含 `//` 的正则，所以没触发；加新的消费方时要留意。
 * （原注释写的是「宁可少剥、不可多剥」，那对这个情形不成立，已改正。）
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        const done = source[i] === c;
        i += 1;
        if (done) break;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

describe('stripComments（守卫自身的前置处理）', () => {
  it('剥行注释与块注释', () => {
    expect(stripComments("a === 'bash' // b === 'bash'")).toBe("a === 'bash' ");
    expect(stripComments("x /* 'bash' */ y")).toBe('x  y');
    expect(stripComments('{/* case \'bash\': */}')).toBe('{}');
  });

  it('字符串里的 // 与 /* 不当注释（否则会连代码一起剥掉）', () => {
    expect(stripComments("const u = 'https://a/b' + x === 'bash';")).toBe(
      "const u = 'https://a/b' + x === 'bash';",
    );
    expect(stripComments("const u = '/*' + x === 'bash';")).toBe("const u = '/*' + x === 'bash';");
  });

  it('模板串与转义引号不提前收尾', () => {
    expect(stripComments('const u = `a${b === \'bash\'}c`; // x')).toBe(
      "const u = `a${b === 'bash'}c`; ",
    );
    expect(stripComments("const s = 'a\\' + x === 'bash';")).toBe("const s = 'a\\' + x === 'bash';");
  });
});

/**
 * 表存在的意义是「工具名只出现一次」。只要有人又在消费方写回
 * `name === 'bash'` 这类判定，判定就会分叉（改了表、漏了那一处 → 静默降级）。
 *
 * 扫描口径：**剥掉注释后**，比较表达式 / `case` / `includes|startsWith|endsWith`
 * 里的工具名字面量。已知会被放行的写法（别指望它兜住）：数组反转
 * （`['bash'].includes(name)`）、名字拼装、`switch` 之外的间接分派。
 * 它拦的是最常见的那几种回退写法，不是"绝无可能绕过"。
 */
describe('已登记的消费方不再自带工具名判定（白名单制，见下方 CONSUMERS）', () => {
  /**
   * 期望扫描的消费方清单。**刻意手工维护**，不用 glob 全量扫：全仓库扫会撞上
   * 合法同名（`attachmentAttach.ts` 的 `'bash'` 是文件扩展名、
   * `messageConversion.ts` 的 `'execute_command'` 是远古文本格式的解析兜底），
   * 也会把 catalog 自己扫进去。新加的消费方要显式登记在这里。
   */
  const CONSUMERS = [
    'src/lib/webToolStatus.ts',
    'src/lib/agentTurnFold.ts',
    'src/components/agent/ToolCallCard.tsx',
    'src/components/agent/ExplorationGroup.tsx',
    'src/components/agent/ApprovalDialog.tsx',
    'src/mobile/MobileApprovalSheet.tsx',
    'src/stores/conversationStore.ts',
    'src/stores/agentStreamHandlers.ts',
  ];

  /**
   * 后端内置工具名清单（镜像 `src-tauri/src/agent/tools/mod.rs` 的
   * `BUILTIN_TOOLS_COMMON` + `BUILTIN_TOOLS_DESKTOP`）。
   *
   * 为什么在测试里再抄一份：被扫的名字集合如果只从 `TOOL_CATALOG` 派生，守卫就
   * 跟着被守卫对象一起降级 —— 删掉表里某一行之后，消费方里写回那个名字反倒没人
   * 发现了。用后端清单当基准，删行会被下面的覆盖测试立刻抓住。
   */
  const BACKEND_BUILTIN_TOOLS = [
    'connection_info',
    'bash',
    'read_history',
    'read_file',
    'list_directory',
    'search_files',
    'system_info',
    'job_output',
    'job_kill',
    'job_list',
    'ask_user',
    'write_file',
    'edit_file',
    'create_plan',
    'update_plan_item',
    'edit_plan',
    'subagent',
    'web_search',
    'http_get',
    'open_cloud_page',
    'render_html',
    'upload_file',
    'download_file',
  ];

  /** 后端有、catalog 刻意不登记的工具（走中性默认：齿轮 + 原名 + 无预览）。 */
  const UNREGISTERED_BY_DESIGN = [
    'job_output',
    'job_kill',
    'job_list',
    'open_cloud_page',
    'upload_file',
    'download_file',
  ];

  // 用 vite 的 raw glob 读源码：本仓库没装 @types/node，测试里不引 node API。
  const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  const names = TOOL_CATALOG.flatMap((s) => [s.name, ...(s.aliases ?? [])]);
  const allNames = [...new Set([...BACKEND_BUILTIN_TOOLS, ...names])];
  // 名字字面量出现在这些形态里 = 把判定写回了消费方。`\(?` 吃掉括号包裹的写法
  // （`name === ('bash' as string)`）。
  const COMPARISON = (name: string) =>
    new RegExp(
      `(===|!==|==|!=|case)\\s+\\(?\\s*['"\`]${name}['"\`]` +
        `|\\.(includes|startsWith|endsWith)\\(\\s*['"\`]${name}['"\`]`,
    );

  it('catalog 的每个名字都是后端内置工具（别名除外）', () => {
    const backend = new Set(BACKEND_BUILTIN_TOOLS);
    const strangers = TOOL_CATALOG.map((s) => s.name).filter((n) => !backend.has(n));
    expect(strangers, 'catalog 里有后端不存在的工具名（拼错或已改名）').toEqual([]);
  });

  it('未登记的后端工具恰好是刻意留白的那几个', () => {
    const registered = new Set(TOOL_CATALOG.map((s) => s.name));
    const unregistered = BACKEND_BUILTIN_TOOLS.filter((n) => !registered.has(n));
    expect(unregistered).toEqual(UNREGISTERED_BY_DESIGN);
  });

  for (const rel of CONSUMERS) {
    it(`${rel} 只从 @/lib/toolCatalog 取工具名结论`, () => {
      const source = sources[`/${rel}`];
      expect(source, `读不到 ${rel}`).toBeTypeOf('string');
      const code = stripComments(source);
      const offenders = allNames.filter((name) => COMPARISON(name).test(code));
      expect(offenders, `${rel} 里仍写死了这些工具名的判定`).toEqual([]);
    });
  }
});
