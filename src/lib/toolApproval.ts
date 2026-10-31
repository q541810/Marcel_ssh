/**
 * 「需要审批的工具」的前端逻辑：哪些工具可以被点名、点名后的档位选项，以及把界面上的
 * 每一种改动翻译成新的档位表。
 *
 * 档位表本身存在 `agentModeSettings.toolApprovalLevels`，后端按工具名查表
 * （`AgentModeSettings::tool_approval_level`）：本机工具 `local_*` 与远端同名工具共用一条，
 * 所以这里的键永远是不带 `local_` 前缀的名字。
 *
 * **有哪些工具可选，以后端为准**（`agent_list_approvable_tools`，取自内置工具声明表）：
 * 这里只负责给它们配显示名与分组。后端新增了前端没登记的工具，照样能点名，只是显示原始名、
 * 归在「其他」里 —— 不会再出现"后端有、设置页选不到"。
 */
import type { Disposition } from './types';

/**
 * 命令类工具：它的审批完全由命令规则与命令确认方式决定，不读档位表。
 * 「需要审批的工具」里它永远排第一个、只读，点一下去看命令规则（与后端
 * `resolve_call_disposition` 对命令类工具不读档位表一致）。
 */
export const COMMAND_TOOL = { name: 'bash', label: '执行命令' } as const;

export const isCommandTool = (name: string): boolean =>
  toolKey(name) === COMMAND_TOOL.name;

function toolKey(name: string): string {
  return name.replace(/^local_/, '');
}

/** 点名时按用途找工具，比一长串平铺好找。 */
export const TOOL_GROUPS = [
  { id: 'files', label: '文件' },
  { id: 'web', label: '联网' },
  { id: 'server', label: '服务器' },
  { id: 'agent', label: 'Agent' },
] as const;

export type ToolGroupId = (typeof TOOL_GROUPS)[number]['id'] | 'other';

const OTHER_GROUP = { id: 'other', label: '其他' } as const;

export interface ToolInfo {
  name: string;
  label: string;
  group: ToolGroupId;
  /** 本机子 agent 里有同名工具、共用这一条档位（见 `tool_approval_key`）。 */
  alsoLocal?: boolean;
}

/**
 * 已知内置工具的显示名与分组。顺序即列表里的顺序。
 * 没登记的工具（后端新加的、手改配置写进去的）显示原始名，归「其他」。
 */
export const TOOL_INFO: readonly ToolInfo[] = [
  { name: 'read_file', label: '读取文件', group: 'files', alsoLocal: true },
  { name: 'list_directory', label: '浏览目录', group: 'files', alsoLocal: true },
  { name: 'search_files', label: '搜索文件', group: 'files' },
  { name: 'edit_file', label: '编辑文件', group: 'files', alsoLocal: true },
  { name: 'write_file', label: '写入文件', group: 'files', alsoLocal: true },
  { name: 'present_file', label: '交付文件', group: 'files', alsoLocal: true },
  { name: 'upload_file', label: '上传文件', group: 'files' },
  { name: 'download_file', label: '下载文件', group: 'files' },
  { name: 'web_search', label: '联网搜索', group: 'web' },
  { name: 'http_get', label: '抓取网页', group: 'web' },
  { name: 'open_cloud_page', label: '打开云控制台', group: 'web' },
  { name: 'system_info', label: '系统信息', group: 'server' },
  { name: 'connection_info', label: '连接信息', group: 'server' },
  { name: 'job_list', label: '列出后台作业', group: 'server' },
  { name: 'job_output', label: '查看作业输出', group: 'server' },
  { name: 'job_kill', label: '终止后台作业', group: 'server' },
  { name: 'subagent', label: '派发子 agent', group: 'agent', alsoLocal: true },
  { name: 'ask_user', label: '向你提问', group: 'agent' },
  { name: 'create_plan', label: '创建计划', group: 'agent' },
  { name: 'update_plan_item', label: '更新计划步骤', group: 'agent' },
  { name: 'edit_plan', label: '编辑计划', group: 'agent' },
  { name: 'memory', label: '写入记忆', group: 'agent' },
  { name: 'memory_recall', label: '回忆', group: 'agent' },
  { name: 'read_history', label: '回读历史', group: 'agent' },
  { name: 'render_html', label: '渲染可视化', group: 'agent' },
];

/** 后端取不到清单时的回退：至少还能点名前端认识的这些。 */
export const KNOWN_TOOL_NAMES: readonly string[] = TOOL_INFO.map((t) => t.name);

/**
 * 工具档位的可选项。不含「放行」：不想审批就把这个工具从表里移除。
 * 顺序与命令规则的档位下拉一致（由松到严）。
 */
export const TOOL_LEVELS: Disposition[] = ['Approval', 'ForceApproval', 'Deny'];

export type ToolApprovalLevels = Record<string, Disposition>;

export function toolInfo(name: string): ToolInfo {
  return (
    TOOL_INFO.find((t) => t.name === name) ?? {
      name,
      label: name,
      group: 'other',
    }
  );
}

export function toolLabel(name: string): string {
  return toolInfo(name).label;
}

/** 这个工具现在是不是"需要审批"的：表里写了 `Allow` 的等于没写（后端同口径）。 */
export function isListed(levels: ToolApprovalLevels, name: string): boolean {
  const level = levels[name];
  return level !== undefined && level !== 'Allow';
}

/** 需要审批的工具（按「已知清单」的顺序在前，表里多出来的未知工具排后面，保持稳定）。 */
export function listedTools(levels: ToolApprovalLevels): string[] {
  const known = TOOL_INFO.map((t) => t.name).filter((n) => isListed(levels, n));
  const extra = Object.keys(levels)
    .filter(
      (n) =>
        !TOOL_INFO.some((t) => t.name === n) &&
        !isCommandTool(n) &&
        isListed(levels, n),
    )
    .sort();
  return [...known, ...extra];
}

export interface AddableGroup {
  id: ToolGroupId;
  label: string;
  tools: ToolInfo[];
}

/**
 * 还没点名、可以添加的工具，按用途分组（空组不出现）。
 *
 * `available` 是后端给的可选清单；没给（还没取回、或取失败）就用前端认识的那些。
 * 命令类工具永远不在其中。
 */
export function addableGroups(
  levels: ToolApprovalLevels,
  available: readonly string[] = KNOWN_TOOL_NAMES,
): AddableGroup[] {
  const names = available.filter(
    (n) => !isCommandTool(n) && !isListed(levels, n),
  );
  const order = (n: string) => {
    const i = KNOWN_TOOL_NAMES.indexOf(n);
    return i < 0 ? KNOWN_TOOL_NAMES.length : i;
  };
  const infos = [...new Set(names)]
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map(toolInfo);
  return [...TOOL_GROUPS, OTHER_GROUP]
    .map((g) => ({
      id: g.id as ToolGroupId,
      label: g.label as string,
      tools: infos.filter((t) => t.group === g.id),
    }))
    .filter((g) => g.tools.length > 0);
}

export function setToolLevel(
  levels: ToolApprovalLevels,
  name: string,
  level: Disposition,
): ToolApprovalLevels {
  return { ...levels, [name]: level };
}

export function removeTool(
  levels: ToolApprovalLevels,
  name: string,
): ToolApprovalLevels {
  const next = { ...levels };
  delete next[name];
  return next;
}

/** 新点名的工具默认「请求审批」：最常见、也最温和的一档。 */
export function addTool(
  levels: ToolApprovalLevels,
  name: string,
): ToolApprovalLevels {
  return setToolLevel(levels, name, 'Approval');
}
