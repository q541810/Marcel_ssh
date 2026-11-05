import { describe, expect, it } from 'vitest';
import {
  KNOWN_TOOL_NAMES,
  TOOL_INFO,
  TOOL_LEVELS,
  addTool,
  addableGroups,
  isListed,
  listedTools,
  removeTool,
  setToolLevel,
  toolLabel,
  COMMAND_TOOL,
  isCommandTool,
} from './toolApproval';

describe('toolApproval', () => {
  const defaults = { edit_file: 'Approval', write_file: 'Approval' } as const;
  const addableNames = (
    levels: Parameters<typeof addableGroups>[0],
    available?: readonly string[],
  ) =>
    addableGroups(levels, available).flatMap((g) => g.tools.map((t) => t.name));

  it('lists the named tools in catalog order, unknown ones after', () => {
    expect(
      listedTools({
        write_file: 'Approval',
        edit_file: 'Deny',
        zz_plugin: 'Approval',
      }),
    ).toEqual(['edit_file', 'write_file', 'zz_plugin']);
  });

  it('bash is never an entry of the table: it is shown separately and read-only', () => {
    expect(isCommandTool(COMMAND_TOOL.name)).toBe(true);
    expect(isCommandTool('local_bash')).toBe(true);
    expect(isCommandTool('edit_file')).toBe(false);
    // 手改配置文件写进去的 bash 不会混进可调的列表（后端对命令类工具也不读这张表）。
    expect(listedTools({ bash: 'Approval', edit_file: 'Approval' })).toEqual([
      'edit_file',
    ]);
    expect(addableNames({})).not.toContain('bash');
    // 后端要是把命令类工具也报上来，同样不让点名。
    expect(addableNames({}, ['bash', 'local_bash', 'read_file'])).toEqual([
      'read_file',
    ]);
  });

  it('an `Allow` entry is the same as not listed (matches the backend)', () => {
    const levels = { ...defaults, read_file: 'Allow' } as const;
    expect(isListed(levels, 'read_file')).toBe(false);
    expect(listedTools(levels)).toEqual(['edit_file', 'write_file']);
    expect(addableNames(levels)).toContain('read_file');
  });

  it('adding defaults to 请求审批, removing drops the key, level change keeps the rest', () => {
    const added = addTool(defaults, 'read_file');
    expect(added.read_file).toBe('Approval');
    expect(removeTool(added, 'read_file')).toEqual(defaults);
    expect(setToolLevel(defaults, 'edit_file', 'Deny')).toEqual({
      edit_file: 'Deny',
      write_file: 'Approval',
    });
  });

  it('offers no 放行 option: not wanting approval means removing the tool', () => {
    expect(TOOL_LEVELS).not.toContain('Allow');
  });

  it('falls back to the raw name for tools it has no label for', () => {
    expect(toolLabel('edit_file')).toBe('编辑文件');
    expect(toolLabel('mcp__x__y')).toBe('mcp__x__y');
  });

  it('every known tool has a unique name and a label', () => {
    expect(new Set(KNOWN_TOOL_NAMES).size).toBe(TOOL_INFO.length);
    for (const t of TOOL_INFO) expect(t.label).not.toBe('');
  });

  describe('what can be added', () => {
    it('groups the tools by purpose, leaves out listed ones and empty groups', () => {
      const groups = addableGroups({ edit_file: 'Approval' });
      expect(groups.map((g) => g.label)).toEqual([
        '文件',
        '联网',
        '服务器',
        'Agent',
      ]);
      const files = groups.find((g) => g.id === 'files')!;
      expect(files.tools.map((t) => t.name)).not.toContain('edit_file');
      expect(files.tools.map((t) => t.name)).toContain('write_file');
      // 全加完的组不再出现。
      const all = Object.fromEntries(
        KNOWN_TOOL_NAMES.filter((n) => TOOL_INFO.find((t) => t.name === n)!.group === 'web').map(
          (n) => [n, 'Approval'],
        ),
      );
      expect(
        addableGroups(all as Record<string, 'Approval'>).map((g) => g.id),
      ).not.toContain('web');
    });

    it('offers whatever the backend reports, not only the ones the frontend knows', () => {
      // 后端比前端多报一个：能点名，显示原始名，归「其他」。
      const groups = addableGroups({}, ['subagent', 'brand_new_tool']);
      expect(groups.map((g) => g.id)).toEqual(['agent', 'other']);
      expect(groups[1].tools).toEqual([
        { name: 'brand_new_tool', label: 'brand_new_tool', group: 'other' },
      ]);
    });

    it('does not offer a tool the backend does not have', () => {
      // 清单以后端为准：它没报的，前端认识也不给。
      expect(addableNames({}, ['read_file'])).toEqual(['read_file']);
    });

    it('falls back to the known tools when the backend list is not available', () => {
      expect(addableNames({})).toEqual([...KNOWN_TOOL_NAMES]);
    });

    it('covers every non-command built-in the backend declares today', () => {
      // 这份是 2026-10 后端 `approvable_tool_names()` 的清单快照：前端必须都认识（有显示名），
      // 否则设置页里会冒出一个只有英文名的工具。后端新增工具时这里会提醒补显示名。
      const backend = [
        'connection_info',
        'read_history',
        'memory',
        'memory_recall',
        'read_file',
        'list_directory',
        'search_files',
        'system_info',
        'job_output',
        'job_kill',
        'job_list',
        'ask_user',
        'ask_parent',
        'suggest_next',
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
      for (const name of backend) {
        expect(KNOWN_TOOL_NAMES, `${name} 缺显示名`).toContain(name);
      }
    });
  });
});
