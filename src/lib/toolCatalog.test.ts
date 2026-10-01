import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ICON_PATHS,
  FILE_CHANGE_TOOL_NAMES,
  LOCAL_SESSION_SENTINEL,
  SKILL_TOOL_PREFIX,
  TOOL_CATALOG,
  fileChangeToolName,
  interruptNoticeKind,
  isDeliverableTool,
  isExplorationTool,
  isLocalExecutionTool,
  isLocalSessionId,
  isPlanTool,
  isSkillTool,
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

  it('本机族与远端同名工具同一条预览口径（只是名字不同）', () => {
    expect(toolPreview('local_bash', { command: 'Get-ChildItem' })).toBe('$ Get-ChildItem');
    expect(toolPreview('local_read_file', { path: '/Users/me/notes.txt' })).toBe(
      '/Users/me/notes.txt',
    );
    expect(toolPreview('local_list_directory', {})).toBe('/');
    expect(toolPreview('local_list_directory', { path: '' })).toBe('/');
    expect(toolPreview('local_subagent', { description: '盘点本机磁盘占用' })).toBe(
      '盘点本机磁盘占用',
    );
    // 与远端 subagent 同一条回退：没 description 就用 prompt
    expect(toolPreview('local_subagent', { prompt: '读本机日志目录里的报错' })).toBe(
      '读本机日志目录里的报错',
    );
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

  it('approvalView: diff 的行必须同时声明 payload: file-change', () => {
    // 两个审批弹窗都靠 `fileChangeToolName(toolCall.name)` 解析交给
    // `FileChangeView` 的工具名（见 catalog 里该函数的说明）—— 它同时要求
    // `payload === 'file-change'` 且名字在 FILE_CHANGE_TOOL_NAMES 里。只声明
    // approvalView 而漏了 payload 时，弹窗会**静默**退回原始 JSON：不崩，但
    // 「批准前能看见完整改动」这个安全前提没了，而且只有肉眼能发现。
    const diffRows = TOOL_CATALOG.filter((s) => s.approvalView === 'diff');
    expect(diffRows.length).toBeGreaterThan(0);
    for (const spec of diffRows) {
      expect(spec.payload, `${spec.name} 声明了审批 diff 却没标 file-change`).toBe(
        'file-change',
      );
      expect(fileChangeToolName(spec.name), spec.name).toBe(spec.name);
    }
  });

  it('声明了 streamsOutput 的行必须同时声明 interruptNotice（两件事绑不得）', () => {
    // 曾经中断文案是从「流式与否」推导的：本机命令（local_bash）接上 streaming
    // 之后就只剩两条错路 —— 说「已关闭 SSH 通道」（本机没有通道）或者说「工具
    // 可能已执行完成」（与「本机进程可能还在跑」相反）。现在两件事分开声明，
    // 传输事实照实写、文案各自认领。这条守卫挡住「接了 streaming 却忘了想文案」
    // 的下一行：漏了它，`interruptNoticeKind` 会静默回落到 generic。
    for (const spec of TOOL_CATALOG) {
      if (spec.streamsOutput === true) {
        expect(spec.interruptNotice, `${spec.name} 接了流式但没声明中断文案`).toBeDefined();
      }
    }
    // 缺省（没声明）= generic：不认识 / 没接流式的工具只能说通用那套
    expect(interruptNoticeKind('read_file')).toBe('generic');
    expect(interruptNoticeKind('local_read_file')).toBe('generic');
    expect(interruptNoticeKind('subagent')).toBe('generic');
    expect(interruptNoticeKind('unknown_tool')).toBe('generic');
    expect(interruptNoticeKind('')).toBe('generic');
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
    for (const name of [
      'web_search',
      'http_get',
      'read_file',
      'search_files',
      'list_directory',
      'system_info',
      'local_read_file',
      'local_list_directory',
    ]) {
      expect(isExplorationTool(name), name).toBe(true);
    }
    expect(isExplorationTool('write_file')).toBe(false);
    expect(isExplorationTool('execute_command')).toBe(false);
    // 本机族的写/执行/派发不进探索组（与远端同名工具一致）
    expect(isExplorationTool('local_write_file')).toBe(false);
    expect(isExplorationTool('local_bash')).toBe(false);
    expect(isExplorationTool('local_subagent')).toBe(false);
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

  it('交付物标志只登记给产出用户可见产物的工具（回合折叠豁免）', () => {
    expect(isDeliverableTool('render_html')).toBe(true);
    expect(isDeliverableTool('bash')).toBe(false);
    expect(isDeliverableTool('read_file')).toBe(false);
    expect(isDeliverableTool('subagent')).toBe(false);
    expect(isDeliverableTool('unknown_tool')).toBe(false);
  });

  it('流式输出的**传输事实**照实声明（决定后续有没有实时部分输出可看）', () => {
    // 真值在后端 `ticket.streaming(...)` 调用点：bash 与 local_bash 都接了。
    // 这条断言的是前端声明与后端事实一致，与「中断文案走哪套」是两件事
    // （后者见 interruptNoticeKind 的用例）。
    expect(toolSpec('bash')?.streamsOutput).toBe(true);
    expect(toolSpec('execute_command')?.streamsOutput).toBe(true);
    expect(toolSpec('local_bash')?.streamsOutput).toBe(true);
    expect(toolSpec('read_file')?.streamsOutput).toBeUndefined();
    expect(toolSpec('subagent')?.streamsOutput).toBeUndefined();
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

describe('本机工具族（local_*）', () => {
  const LOCAL_TOOLS = [
    'local_subagent',
    'local_bash',
    'local_read_file',
    'local_write_file',
    'local_edit_file',
    'local_list_directory',
  ];

  it('六个本机工具都声明了 localExecution（审批面板据此打「本机」横幅）', () => {
    for (const name of LOCAL_TOOLS) {
      expect(isLocalExecutionTool(name), name).toBe(true);
    }
    // 远端同名工具不声明 —— 否则审批面板会给「在服务器上执行」的调用打本机横幅
    for (const name of ['subagent', 'bash', 'read_file', 'write_file', 'edit_file', 'list_directory']) {
      expect(isLocalExecutionTool(name), name).toBe(false);
    }
    expect(isLocalExecutionTool('unknown_tool')).toBe(false);
  });

  it('local_bash 复用命令参数形态（command/description 与 bash 同键）+ 本机中断文案', () => {
    expect(toolSpec('local_bash')?.payload).toBe('command');
    // 后端 local_bash 的前台执行与远端 bash 同构：挂了 `ticket.streaming(...)`
    // （`src-tauri/src/agent/tools/local_bash.rs`），输出逐块发到前端 —— 传输
    // 事实照实声明（旧断言写的是 undefined，那时后端还没接上）。
    expect(toolSpec('local_bash')?.streamsOutput).toBe(true);
    // 但**中断文案不能跟着传输事实走**：「已停止等待输出并关闭 SSH 通道…」是
    // 远端专属说辞（本机没有 SSH 通道、进程也不在服务器上），而「工具可能已
    // 执行完成」又与本机「只停止等待、进程可能还在跑」相反。所以本机命令显式
    // 声明自己那一套。
    expect(toolSpec('local_bash')?.interruptNotice).toBe('local');
    expect(interruptNoticeKind('local_bash')).toBe('local');
    // 反面对照：远端 bash 是远端流式那套（同一份传输事实，两套说辞）
    expect(interruptNoticeKind('bash')).toBe('remote-stream');
    expect(interruptNoticeKind('execute_command')).toBe('remote-stream');
  });

  it('本机编辑与远端编辑走同一个 diff 视图（参数键与 metadata 同形）', () => {
    // 后端两侧共用一份实现（`local_file_ops.rs` 直接调远端的 resolve_edit_text /
    // apply_edit / build_edit_display_metadata）：参数键同为 old_content /
    // new_content / replace_all，展示 metadata 同为
    // before/after/hunks/match_line_positions…。原先本机编辑刻意只当普通 JSON，
    // 前提是「后端没有审批预览 + FileChangeView 不认本机名」，两个前提都已消除，
    // 所以声明照远端那一行标。
    expect(toolSpec('local_edit_file')?.payload).toBe('file-change');
    expect(toolSpec('local_edit_file')?.approvalView).toBe('diff');
    // 审批弹窗靠这个解析交给 FileChangeView 的名字（不是写死 edit_file）
    expect(fileChangeToolName('local_edit_file')).toBe('local_edit_file');
    // 反面对照：远端 edit_file 的声明不变
    expect(toolSpec('edit_file')?.payload).toBe('file-change');
    expect(toolSpec('edit_file')?.approvalView).toBe('diff');
  });

  it('local_write_file 仍是普通 JSON 呈现（后端没有本机写的审批预览）', () => {
    // 远端 write_file 的审批面板本来就显示原始 JSON（见 catalog 里 approvalView
    // 的说明）；本机写侧没有审批前预演，没有理由比远端多一个视图。等后端给出
    // 预览、并确认要改这个行为时，才把这里改成 file-change（同时扩
    // FileChangeView 的分支，那里有穷尽检查）。
    expect(toolSpec('local_write_file')?.payload).toBeUndefined();
    expect(fileChangeToolName('local_write_file')).toBeNull();
    expect(toolSpec('local_write_file')?.approvalView).toBeUndefined();
    // 反面对照：远端 write_file 仍是 file-change 内容视图，但审批不加宽、不出 diff
    expect(toolSpec('write_file')?.payload).toBe('file-change');
    expect(toolSpec('write_file')?.approvalView).toBeUndefined();
  });

  it('local_subagent 是子 agent（卡片入口/模式标注照旧）+ prompt 审批视图', () => {
    expect(isSubagentTool('local_subagent')).toBe(true);
    expect(toolSpec('local_subagent')?.approvalView).toBe('prompt');
    // 远端子 agent 的审批面板没有长文本正文块（保持既有行为）
    expect(toolSpec('subagent')?.approvalView).toBeUndefined();
    // label 不能与远端 subagent 相同：本机/云端要在卡片标题行就能分开
    expect(toolLabel('local_subagent')).toBe('本机子agent');
    expect(toolLabel('subagent')).toBe('子agent');
  });

  it('图标与远端同名工具一致（同类动作共用一副长相）', () => {
    expect(toolIconPaths('local_bash')).toBe(toolIconPaths('bash'));
    expect(toolIconPaths('local_read_file')).toBe(toolIconPaths('read_file'));
    expect(toolIconPaths('local_write_file')).toBe(toolIconPaths('write_file'));
    expect(toolIconPaths('local_edit_file')).toBe(toolIconPaths('edit_file'));
    expect(toolIconPaths('local_list_directory')).toBe(toolIconPaths('list_directory'));
    expect(toolIconPaths('local_subagent')).toBe(toolIconPaths('subagent'));
  });

  it('本机子任务的会话哨兵值必须非空、且不像真会话 id', () => {
    // 空串会被 `taskStore` 当成「重启恢复的占位 task」：本机子任务正在跑却被
    // 判成占位 → 状态环不亮、对话不忙、回合被折叠。
    expect(LOCAL_SESSION_SENTINEL.length).toBeGreaterThan(0);
    // 真会话 id 两侧都是 UUID；哨兵值要是 UUID 形状就会与真会话撞名。
    expect(LOCAL_SESSION_SENTINEL).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('isLocalSessionId 只认哨兵：空串（占位 task）与真会话都不算本机', () => {
    expect(isLocalSessionId(LOCAL_SESSION_SENTINEL)).toBe(true);
    expect(isLocalSessionId('')).toBe(false);
    expect(isLocalSessionId('3f2b1a4c-0000-4000-8000-000000000000')).toBe(false);
    expect(isLocalSessionId(undefined)).toBe(false);
    expect(isLocalSessionId(null)).toBe(false);
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
    // 本机工具族（桌面专属，后端 `#[cfg(desktop)]` 注册；Android 没有本机路径
    // 语义，走 SAF）：与远端同名工具一一对应，前端全部登记（无留白）。
    'local_subagent',
    'local_bash',
    'local_read_file',
    'local_write_file',
    'local_edit_file',
    'local_list_directory',
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
