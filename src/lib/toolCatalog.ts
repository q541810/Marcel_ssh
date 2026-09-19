/**
 * toolCatalog.ts — 前端「工具呈现规格」的单一来源。
 *
 * 一个工具在 UI 上的样子（图标、显示名、标题行预览、折叠分组、参数主体形态、
 * 中断文案、流式预览字段）过去散在 8 个文件、12 处，同一件事抄好几遍：
 *   - `ToolCallCard` 的 `TOOL_ICONS`(13 键) / `PLAN_TOOL_LABELS` / `isPlanTool` /
 *     `getCommandPreview`(9 分支) / `isSubagentTool` / `formatToolName`；
 *   - `ApprovalDialog` 与 `MobileApprovalSheet` 各自抄一遍的
 *     `isEditFile` / `isExecuteCommand`；
 *   - `ExplorationGroup` 的 `EXPLORATION_TOOLS`；
 *   - `webToolStatus` 的 `isWebTool`（现在它只读本表的 `web` 声明）；
 *   - `agentTurnFold` 的 `isSubagentToolResult`（"subagent 还是 task" 抄了第二遍）；
 *   - `conversationStore` 判定中断文案的 `toolName === 'bash' || …`；
 *   - `agentStreamHandlers` 的 `PARTIAL_PREVIEW_TOOLS`（流式预览字段）。
 *
 * 结果是：给某个工具做 UI 要改好几个文件，漏掉一处就是**静默降级**（掉回齿轮
 * 图标、标题行没预览、不进探索分组），而且不会报错。
 *
 * 现在是一张表：**给内置工具改图标 / 显示名 / 标题行预览 / 折叠分组 / 参数形态 /
 * 中断文案，只改这里**。它管不到的三件事：插件工具与 MCP 工具（名字是动态的，
 * 永远不进表）；要整块接管渲染的工具（还要进 `components/agent/toolViews.ts`，
 * `render_html` 现在就是两个文件各一份）；新增 `payload: 'file-change'` 的工具
 * （还要扩 `FileChangeToolName` 与 `FileChangeView` 的分支）。历史上改过名的工具
 * （`execute_command` → `bash`、`task` → `subagent`）用 `aliases` 挂回同一行，
 * 不再各抄一份图标路径 —— 旧会话回放与新会话走同一条解析路径。
 *
 * 与 `components/agent/toolViews.ts` 的分工：那边是「整块接管某个工具的渲染」的
 * 组件注册表（要 import React 组件），这边是不含 JSX 的**元数据**表。两者都是
 * 声明表，刻意分开 —— 这个模块是纯数据 + 纯函数，`.ts` 里没有 JSX，可以直接单测。
 *
 * **不在这里的东西**：风险等级、审批策略、工具在哪个模式/角色可用 —— 那些以
 * Rust 侧 `agent/tools/mod.rs` 的 `BUILTIN_TOOLS_*` 表为准。前端不复制一份，
 * 复制出来的那份必然与后端漂移（本仓库已经因为这类复制吃过亏）。
 */

/** 折叠分组：同组的工具调用会被折成一条「已探索 N 次读取」/「计划 N 次」。 */
export type ToolGroup = 'exploration' | 'plan';

/**
 * 工具参数的主体形态 —— 决定卡片与审批面板怎么呈现参数，而不是把它当一坨
 * JSON 打印。缺省 = 没有特殊形态（原样显示 JSON / 原始输出）。
 */
export type ToolPayload =
  /** shell 命令：标题行显示命令预览与超时上限（取自设置），审批面板给命令块。 */
  | 'command'
  /** 文件内容/改动：卡片展开后渲染 diff（`FileChangeView`）而不是原始输出。 */
  | 'file-change';

/** 流式期间提前预览参数：从累积的 JSON 里提取哪几个字段。 */
export interface PartialPreviewSpec {
  /** 驱动预览的长字符串字段；提取不到就不发预览。 */
  readonly primary: string;
  /** 顺带提取的短字段（标题、模式等），缺失时直接省略。 */
  readonly companions: readonly string[];
}

export interface ToolPresentation {
  /** 规范名（= Rust 侧注册名）。 */
  readonly name: string;
  /** 历史消息里的旧名，呈现与规范名完全一致。 */
  readonly aliases?: readonly string[];
  /** 卡片标题行 / plan 状态行显示的名字；缺省显示规范名。 */
  readonly label?: string;
  /** 标题图标：一组 SVG `path` 的 `d`，由 `ToolIcon` 用统一的描边 svg 包裹。 */
  readonly iconPaths?: readonly string[];
  readonly group?: ToolGroup;
  /** 结果 metadata 带「后端 / 降级 / 被网站拦截」信号（见 `webToolStatus.ts`）。 */
  readonly web?: boolean;
  /** 派发子 agent：卡片据此提供「查看调研过程」入口、标注读写模式。 */
  readonly subagent?: boolean;
  readonly payload?: ToolPayload;
  /**
   * 审批面板的参数区呈现方式。缺省 = 原始 JSON。
   *
   * 只有 `edit_file` 是 `'diff'`（审批面板加宽 + 渲 `FileChangeView`）。`write_file`
   * 同样能被审批命中（高风险时），但它的审批面板照旧显示原始 JSON —— 这是
   * `6d785a6`「edit_file 默认需审批并预检，审批弹窗展示完整上下文 diff」留下的
   * 既有行为，本轮只是把它声明出来，**没有改**。
   *
   * 注意：`FileChangeView` 靠工具名选分支（`write_file` 列内容 / `edit_file` 出
   * diff），而审批面板目前写死了 `toolName="edit_file"`。所以给 `write_file` 也加
   * `approvalView: 'diff'` 时，必须同时把审批面板那处的工具名改成传入的
   * `toolCall.name`，否则会拿 write_file 的参数去算 diff。
   */
  readonly approvalView?: 'diff';
  /**
   * 输出通过 `toolOutput` 事件流式到达前端（后端 `command_exec` ticket 上的
   * `.streaming(...)`）。用户中断时两套文案的区别就在这：流式工具能说「已停止
   * 等待输出并向远端 close 关闭通道」，非流式工具只能说「可能已执行完成」。
   *
   * ⚠️ 这是**后端事实的前端镜像**，没有任何跨语言护栏：真值在
   * `src-tauri/src/agent/tools/bash.rs` 的 `ticket.streaming(...)` 调用点
   * （目前 agent 工具里只有 bash 接了；`tools/mod.rs` 的 `exec_streamed` 是零
   * 调用方的死 helper）。**给别的工具接上 streaming 时，要回来给那一行加
   * `streamsOutput: true`**，否则用户中断后会看到与实际不符的「工具可能已执行
   * 完成」。
   */
  readonly streamsOutput?: boolean;
  /** 流式期间提前提取参数做预览的字段（工具参数长、等完整 JSON 太久时用）。 */
  readonly partialPreview?: PartialPreviewSpec;
  /** 标题行预览；缺省（或返回空串）不占版面。 */
  readonly preview?: (args: Record<string, unknown>) => string;
}

/** 预览与预览里的片段超过这个字数就截断。 */
const PREVIEW_MAX = 40;

function clip(text: string): string {
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}...` : text;
}

/**
 * 取字符串参数。模型偶尔会把参数包成 `{value: "..."}` / `{text: "..."}`
 * （历史数据里真实出现过），所以两种包装都要认。
 *
 * 导出是因为卡片标题行读 `host` 时要用**同一套**语义：那个读取逻辑留在了
 * `ToolCallCard`（不是呈现规格），但它和这里必须认同样的包装格式，否则同一个
 * 参数在标题行和预览里会有两种解析结果。
 */
export function asArgString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.value === 'string') return o.value;
    if (typeof o.text === 'string') return o.text;
  }
  return undefined;
}

function asStrArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const arr = v.map((item) => asArgString(item)).filter(Boolean) as string[];
    if (arr.length > 0) return arr;
  }
  return undefined;
}

/** 动态工具族前缀：`skill_<名字>`，名字由用户的 skill 列表决定，不是静态行。 */
export const SKILL_TOOL_PREFIX = 'skill_';

// ── 图标路径（`d` 的集合） ──
const ICON_LINK = [
  'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
];
const ICON_TERMINAL = [
  'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
];
const ICON_DOCUMENT = [
  'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
];
const ICON_PENCIL = [
  'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
];
const ICON_FOLDER = [
  'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
];
const ICON_MAGNIFIER = ['M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z'];
/** 联网搜索：放大镜 + 地球经纬（与 read_file/search_files 区分开）。 */
const ICON_GLOBE_SEARCH = [
  'M21 21l-4.35-4.35',
  'M16.65 16.65A7.5 7.5 0 105.35 5.35a7.5 7.5 0 0011.3 11.3z',
  'M7.5 11.5h11M13 5.6a13 13 0 013.3 5.9 13 13 0 01-3.3 5.9 13 13 0 01-3.3-5.9 13 13 0 013.3-5.9z',
];
/** 网页获取：地球 + 向下取回。 */
const ICON_GLOBE_DOWNLOAD = [
  'M12 3a9 9 0 100 18 9 9 0 000-18z',
  'M3.6 9h16.8M3.6 15h16.8',
  'M12 3a15.3 15.3 0 014 9 15.3 15.3 0 01-4 9 15.3 15.3 0 01-4-9 15.3 15.3 0 014-9z',
  'M12 21v4',
];
const ICON_CHART = [
  'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
];
const ICON_QUESTION = [
  'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
];
const ICON_SUBAGENT = [
  'M7 3v14a2 2 0 002 2h2m0 0a2 2 0 104 0m-4 0a2 2 0 104 0m5-11v2a3 3 0 01-3 3h-3m0 0V7a2 2 0 00-2-2H8m5 4H5a2 2 0 01-2-2V3h4',
];
/** 未登记工具的回退图标（齿轮）：新工具没配图标时用它，不是错误。 */
export const DEFAULT_ICON_PATHS = [
  'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  'M15 12a3 3 0 11-6 0 3 3 0 016 0z',
];

/** 读文件类工具（含写）标题行都显示路径。 */
const pathPreview = (args: Record<string, unknown>): string => asArgString(args.path) ?? '';

/**
 * 前端工具呈现规格表：一个工具一行。
 *
 * **没登记的工具是合法状态，不是错误**：插件工具、MCP 工具，以及还没配图标的
 * 内置工具（`upload_file` / `download_file` / job_* 等）都落到中性默认 —— 齿轮
 * 图标 + 显示原始名 + 无标题行预览。既然每个字段都是可选的，行只声明这个工具
 * **真正与众不同**的地方（`render_html` 就只有一条流式预览声明），不必为了
 * "填满"而补行。
 */
export const TOOL_CATALOG: readonly ToolPresentation[] = [
  {
    name: 'connection_info',
    iconPaths: ICON_LINK,
  },
  {
    name: 'bash',
    // 兼容历史消息（旧工具名 execute_command）
    aliases: ['execute_command'],
    iconPaths: ICON_TERMINAL,
    payload: 'command',
    streamsOutput: true,
    preview: (args) => {
      const cmd = asArgString(args.command);
      return cmd ? `$ ${clip(cmd)}` : '';
    },
  },
  {
    name: 'read_file',
    iconPaths: ICON_DOCUMENT,
    group: 'exploration',
    preview: pathPreview,
  },
  {
    name: 'write_file',
    iconPaths: ICON_PENCIL,
    payload: 'file-change',
    preview: pathPreview,
  },
  {
    // 与 write_file 同一个铅笔：两者都是「改文件内容」这同一类动作，同类事物
    // 外观必须相同（一致性原则）。历史上 edit_file 漏配了图标、显示成默认齿轮，
    // 它是审批最频繁、最该被一眼认出的那个，2026-09-19 补齐。
    name: 'edit_file',
    iconPaths: ICON_PENCIL,
    payload: 'file-change',
    approvalView: 'diff',
    preview: pathPreview,
  },
  {
    name: 'list_directory',
    iconPaths: ICON_FOLDER,
    group: 'exploration',
    // 没给 path（或给了空串）时显示根目录：目录列表总是有一个被列的对象，
    // 空着反而像坏了。用 `||` 不是 `??` —— 空串也要走这个回退（原实现是
    // `if (path) return path;`，真值判断）。
    preview: (args) => asArgString(args.path) || '/',
  },
  {
    name: 'search_files',
    iconPaths: ICON_MAGNIFIER,
    group: 'exploration',
    preview: (args) =>
      `${asArgString(args.pattern) ?? ''} ${asArgString(args.path) ?? ''}`.trim(),
  },
  {
    name: 'web_search',
    iconPaths: ICON_GLOBE_SEARCH,
    group: 'exploration',
    web: true,
    preview: (args) => asArgString(args.query) ?? '',
  },
  {
    name: 'http_get',
    iconPaths: ICON_GLOBE_DOWNLOAD,
    group: 'exploration',
    web: true,
    preview: (args) => {
      const url = asArgString(args.url);
      if (url) return url;
      const urls = asStrArray(args.urls);
      if (!urls) return '';
      if (urls.length === 1) return urls[0];
      return `${clip(urls[0])} +${urls.length - 1} more`;
    },
  },
  {
    name: 'system_info',
    iconPaths: ICON_CHART,
    group: 'exploration',
  },
  {
    name: 'ask_user',
    iconPaths: ICON_QUESTION,
    preview: (args) => {
      const questions = args.questions;
      if (!Array.isArray(questions) || questions.length === 0) return '';
      const first = questions[0] as Record<string, unknown> | undefined;
      const header = asArgString(first?.header) ?? asArgString(first?.question);
      const head = header ? clip(header) : '';
      const count = questions.length > 1 ? ` +${questions.length - 1} 题` : '';
      return `? ${head}${count}`;
    },
  },
  {
    name: 'subagent',
    // 兼容历史消息（旧工具名 task）
    aliases: ['task'],
    label: '子agent',
    iconPaths: ICON_SUBAGENT,
    subagent: true,
    preview: (args) => clip(asArgString(args.description) || asArgString(args.prompt) || ''),
  },
  {
    name: 'render_html',
    // 参数里是整页 HTML，等完整 JSON 太久 —— 流式期间就把正文先拿出来渲染。
    partialPreview: { primary: 'fragment', companions: ['title', 'mode'] },
  },
  // ── plan 工具：卡片位置渲染成一行状态文字（计划本体在 PlanList 里） ──
  {
    name: 'create_plan',
    label: '创建plan',
    group: 'plan',
  },
  {
    name: 'update_plan_item',
    label: '更新plan步骤',
    group: 'plan',
  },
  {
    name: 'edit_plan',
    label: '编辑plan',
    group: 'plan',
  },
];

/** 名字（含别名）→ 行的索引。别名与规范名指向同一行。 */
const BY_NAME: ReadonlyMap<string, ToolPresentation> = (() => {
  const index = new Map<string, ToolPresentation>();
  for (const spec of TOOL_CATALOG) {
    index.set(spec.name, spec);
    for (const alias of spec.aliases ?? []) index.set(alias, spec);
  }
  return index;
})();

/** 取工具的呈现规格；未登记的工具返回 `undefined`（调用方走默认呈现）。 */
export function toolSpec(toolName: string): ToolPresentation | undefined {
  return BY_NAME.get(toolName);
}

/** 是否属于某个折叠分组（模块私有：外面只用下面两个具名谓词）。 */
function isToolInGroup(toolName: string, group: ToolGroup): boolean {
  return toolSpec(toolName)?.group === group;
}

export function isPlanTool(toolName: string): boolean {
  return isToolInGroup(toolName, 'plan');
}

export function isExplorationTool(toolName: string): boolean {
  return isToolInGroup(toolName, 'exploration');
}

/** 派发子 agent 的工具（现名 subagent；兼容旧历史消息的 task）。 */
export function isSubagentTool(toolName: string): boolean {
  return toolSpec(toolName)?.subagent === true;
}

/** skill 动态工具族（`skill_<名字>`）。 */
export function isSkillTool(toolName: string): boolean {
  return toolName.startsWith(SKILL_TOOL_PREFIX);
}

/**
 * `FileChangeView` 认得（并能正确分支）的工具名 —— 那个组件的 props 类型就是
 * 这份契约。
 *
 * 往表里加 `payload: 'file-change'` 的新工具时，必须同时扩展这里**和**
 * `FileChangeView` 的分支逻辑。真正拦住漏做的是 **`tsc`**：`FileChangeView` 的
 * props 是写死的二值 union，不在其中的名字在 `ToolCallCard` 里传不进去。
 * `toolCatalog.test.ts` 那一侧只保证「声明了 `payload: 'file-change'` 的行恰好
 * 等于这份清单」（挡住反向遗漏），不是它守住了类型。
 */
export const FILE_CHANGE_TOOL_NAMES = ['write_file', 'edit_file'] as const;

export type FileChangeToolName = (typeof FILE_CHANGE_TOOL_NAMES)[number];

/**
 * 参数主体是文件改动的工具名（`FileChangeView` 靠它选分支）；否则 `null`。
 *
 * 声明了 `payload: 'file-change'` 但 `FileChangeView` 还不认识的名字也返回
 * `null`：卡片退回原始输出，而不是拿错分支去算 diff。
 */
export function fileChangeToolName(toolName: string): FileChangeToolName | null {
  if (toolSpec(toolName)?.payload !== 'file-change') return null;
  return FILE_CHANGE_TOOL_NAMES.find((name) => name === toolName) ?? null;
}

/**
 * 该工具的输出是否流式到达前端（决定用户中断时的文案）。
 * 旧名 `execute_command` 与 `bash` 同一行，所以历史消息的判定也一致。
 */
export function isStreamingTool(toolName: string): boolean {
  return toolSpec(toolName)?.streamsOutput === true;
}

/** 该工具的流式部分参数预览字段；没有声明则 `undefined`（不发预览）。 */
export function toolPartialPreview(toolName: string): PartialPreviewSpec | undefined {
  return toolSpec(toolName)?.partialPreview;
}

/** 标题图标路径；未登记或没配图标的工具回退到默认齿轮。 */
export function toolIconPaths(toolName: string): readonly string[] {
  return toolSpec(toolName)?.iconPaths ?? DEFAULT_ICON_PATHS;
}

/**
 * 显示名：行里声明的 `label`，没声明就**原样显示传入的名字**。
 *
 * 注意 `??` 回退的是传入的那个名字（不是行的规范名）：所以 `bash` 显示
 * `bash`、历史消息里的 `execute_command` 显示 `execute_command` —— 旧会话
 * 保持它当年的样子。只有声明了 `label` 的工具（`subagent` / plan 工具）才会
 * 让别名也显示成 label。
 */
export function toolLabel(toolName: string): string {
  return toolSpec(toolName)?.label ?? toolName;
}

/**
 * 卡片标题行显示什么名字。
 *
 * `isSkill` 单独返回：skill 调用不渲染成工具卡片，而是一行灰色文字
 * （「SKILL 名字」），调用方据此走另一条渲染分支。
 */
export function toolDisplayName(toolName: string): { display: string; isSkill: boolean } {
  if (isSkillTool(toolName)) {
    return { display: `SKILL ${toolName.slice(SKILL_TOOL_PREFIX.length)}`, isSkill: true };
  }
  return { display: toolLabel(toolName), isSkill: false };
}

/** 标题行预览（命令 / 路径 / 查询词…）。未登记或无参数时返回空串。 */
export function toolPreview(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return '';
  // skill 只显示名字，参数没有可预览的主体。
  if (isSkillTool(toolName)) return '';
  return toolSpec(toolName)?.preview?.(args) ?? '';
}
