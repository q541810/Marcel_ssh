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
 * 审批呈现 / 中断文案 / 本机登记，只改这里**。它管不到的三件事：插件工具与 MCP
 * 工具（名字是动态的，永远不进表）；要整块接管渲染的工具（还要进
 * `components/agent/toolViews.ts`，`render_html` 现在就是两个文件各一份）；新增
 * `payload: 'file-change'` 的工具（还要扩 `FileChangeToolName` 与
 * `FileChangeView` 的分支）。历史上改过名的工具（`execute_command` → `bash`、
 * `task` → `subagent`）用 `aliases` 挂回同一行，不再各抄一份图标路径 —— 旧会话
 * 回放与新会话走同一条解析路径。
 *
 * 与 `components/agent/toolViews.ts` 的分工：那边是「整块接管某个工具的渲染」的
 * 组件注册表（要 import React 组件），这边是不含 JSX 的**元数据**表。两者都是
 * 声明表，刻意分开 —— 这个模块是纯数据 + 纯函数，`.ts` 里没有 JSX，可以直接单测。
 *
 * **不在这里的东西**：风险等级、审批策略、工具在哪个模式/角色可用 —— 那些以
 * Rust 侧 `agent/tools/mod.rs` 的 `BUILTIN_TOOLS_*` 表为准。前端不复制一份，
 * 复制出来的那份必然与后端漂移（本仓库已经因为这类复制吃过亏）。
 */

/**
 * 用户中断时卡片追加哪套说明（`ToolPresentation.interruptNotice` 的取值）。
 */
export type InterruptNoticeKind = 'remote-stream' | 'local' | 'generic';

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
  /**
   * 产物是**面向用户的交付物**（如 `render_html` 的可视化图表），不是过程记录：
   * 已结束回合的过程折叠把它豁免——折叠态也恒渲染，且不计入「已执行 n 步」。
   * 消费方是 `agentTurnFold.ts`（分段豁免），这里只做名字级声明；成功 / 被拦
   * 与否属于单次调用的状态，由消费方结合 `toolResult` 判定。
   */
  readonly deliverable?: boolean;
  /** 结果 metadata 带「后端 / 降级 / 被网站拦截」信号（见 `webToolStatus.ts`）。 */
  readonly web?: boolean;
  /** 派发子 agent：卡片据此提供「查看调研过程」入口、标注读写模式。 */
  readonly subagent?: boolean;
  readonly payload?: ToolPayload;
  /**
   * 审批面板的参数区呈现方式。缺省 = 原始 JSON。
   *
   * `'diff'`：`edit_file` 与 `local_edit_file`（审批面板加宽 + 渲
   * `FileChangeView`）。两者在后端是**同一份实现**：参数键同为 `path` /
   * `old_content` / `new_content` / `replace_all`，展示 metadata 也同形
   * （`build_edit_display_metadata`，远端与本机共用）。diff 的**数据**来自审批
   * 事件里的 `metadata` 而不是 arguments —— 参数里只有被替换的那两段，
   * 看不出改动落在全文的哪个位置；metadata 来自审批前的一次预演读盘
   * （后端 `ToolSemantics::preview_before_approval`）。
   *
   * `write_file` 同样能被审批命中（高风险时），但它的审批面板照旧显示原始 JSON ——
   * 这是 `6d785a6`「edit_file 默认需审批并预检，审批弹窗展示完整上下文 diff」
   * 留下的既有行为，**没有改**。
   *
   * 审批面板交给 `FileChangeView` 的工具名必须由当前调用解析出来
   * （`fileChangeToolName(toolCall.name)`，两个弹窗都是），**不能写死**：该组件
   * 靠工具名选分支（`write_file` 列内容 / edit 形状出 diff），写死会让别的工具
   * 拿自己的 metadata 渲染成「edit_file 的改动」。
   *
   * `'prompt'` = 派发出去的长文本指令（`local_subagent` 的 `arguments.prompt`），
   * 审批面板把它当**正文**整段渲染（`whitespace-pre-wrap`、可滚动），而不是塞进
   * JSON 里。这不是美观问题：被派发的那段 prompt 可能整段来自远端返回的内容
   * （网页、文件、命令输出、被注入的上下文），用户只有在批准前能读全文，才有
   * 可能发现「这条指令其实是在让子 agent 干别的事」。截断 / 折叠 / 只给摘要的
   * 呈现会把这唯一的检查点抹掉，所以这里是长文本块 + 可滚动，不做任何截断。
   */
  readonly approvalView?: 'diff' | 'prompt';
  /**
   * 该工具在**运行 Marcel SSH 的这台电脑**上干活（本机工具族 `local_*`）。
   *
   * 判据刻意是工具名（这张表按名索引），**不是参数**：参数由模型生成，可以
   * 伪造 —— 用一个 `host` 之类的参数来判断「是不是本机」等于问执行者自己。
   *
   * 消费方：审批面板据此加「本机」横幅（`local_subagent` 的文案更重：子 agent
   * 只在这台电脑上工作）。不在这里把「本机」当图标/显示名差异：同类动作共用
   * 同一个图标（见 `write_file` / `edit_file` 的铅笔），本机族靠 `local_` 名字
   * 前缀 + 审批横幅区分，不给同一类动作两套长相。
   */
  readonly localExecution?: boolean;
  /**
   * 输出通过 `toolOutput` 事件流式到达前端（后端 `command_exec` ticket 上的
   * `.streaming(...)`）。
   *
   * ⚠️ 这是**后端事实的前端镜像**，没有任何跨语言护栏：真值在
   * `src-tauri/src/agent/tools/bash.rs` 与 `local_bash.rs` 的
   * `ticket.streaming(...)` 调用点。**给别的工具接上 streaming 时，要回来给那一
   * 行加 `streamsOutput: true`**。
   *
   * 它**只描述传输事实，不决定用户中断时的文案** —— 那是
   * `interruptNotice` 的活（见该字段与 `interruptNoticeKind`）。
   * 曾经两者是一件事（按流式与否二选一），于是 `local_bash` 一旦接了 streaming
   * 就只剩两条错路：说「已关闭 SSH 通道」（本机没有 SSH 通道）或者说「工具可能
   * 已执行完成」（与「本机进程可能还在跑」的真相相反）。
   */
  readonly streamsOutput?: boolean;
  /**
   * 用户中断时卡片该追加哪段说明。三种，缺省 `'generic'`。
   *
   * - `'remote-stream'`：远端流式命令（`bash`）——「已停止等待输出并关闭 SSH
   *   通道，但远端进程不保证已终止…」。**这套说辞是远端专属**：本机没有 SSH
   *   通道，本机进程也不在服务器上。
   * - `'local'`：本机命令（`local_bash`）——「已停止等待本机命令…本机进程不保证
   *   已结束」，并指路本机自己的收尾手段（`Get-Process` / `Stop-Process -Id`、
   *   `ps` / `pgrep` + `kill`）：本机没有 sshd 替用户回收进程。
   * - `'generic'`：其余工具（非流式）——「已停止等待结果；工具可能已执行完成」。
   *
   * 为什么与 `streamsOutput` 分开：前者是传输事实，这里说的是「用户按下停止那
   * 一刻，那条命令 / 进程实际处于什么状态」。两者对 `local_bash` 就不同：
   * 输出确实是流式的，但能说的只有本机那套话。所以这里**每行显式声明**，不从
   * `streamsOutput` 推导 —— 推导就是把两个集合绑死，`toolCatalog.test.ts` 里有
   * 一条断言盯着「声明了 streamsOutput 的行必须同时声明 interruptNotice」。
   */
  readonly interruptNotice?: InterruptNoticeKind;
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
/** 回读历史：时钟 + 回拨箭头（"把时间拨回去看原文"）。 */
const ICON_HISTORY = [
  'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8',
  'M3 3v5h5',
  'M12 7v5l4 2',
];
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
    // 远端流式命令的中断文案：「已停止等待输出并关闭 SSH 通道，但远端进程不保证
    // 已终止…」。这是**远端专属**说辞（本机命令有它自己那套，见 local_bash）。
    interruptNotice: 'remote-stream',
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
    // 回读会话历史（含被压缩掉的原文）。**刻意不放进 exploration 分组**：
    // "agent 回去翻旧账了"是用户会想问一句为什么的动作，折叠进探索组会让这段
    // 推理的来源看不见。
    name: 'read_history',
    iconPaths: ICON_HISTORY,
    preview: (args) => {
      const action = asArgString(args.action) ?? '';
      const scope = asArgString(args.scope);
      const prefix =
        scope === 'sub' ? '子对话 ' : scope === 'parent' ? '主 agent ' : '';
      if (action === 'search') {
        return `${prefix}检索「${clip(asArgString(args.keyword) ?? '')}」`;
      }
      if (action === 'read') {
        const before = Number(args.before ?? 0) || 0;
        const after = Number(args.after ?? 0) || 0;
        return `${prefix}读 ${before + after + 1} 条`;
      }
      return `${prefix}历史概览`;
    },
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
    // 图表是用户要看的产物，不是过程：回合折叠时豁免展示。
    deliverable: true,
  },
  // ── 本机工具族（`local_*`）：在运行 Marcel SSH 的这台电脑上干活，与远端同名
  //    工具一一对应。图标 / 预览 / 折叠分组一律照远端那一行（同类动作共用一副
  //    长相），另加两条真正不同的声明：`localExecution`（审批面板的本机横幅）与
  //    `subagent`（本机子 agent 同样要能「查看调研过程」）。
  //
  //    **本机编辑（`local_edit_file`）与远端 `edit_file` 走同一个 diff 视图**：
  //    两者在后端共用同一份实现 —— 参数键（`old_content` / `new_content` /
  //    `replace_all`）与展示 metadata（`build_edit_display_metadata`）都同形，
  //    所以 `payload` 与 `approvalView` 照远端那一行标，`FileChangeView` 也认这个
  //    名字（审批前那次预演读的是用户自己电脑上的真实文件）。
  //
  //    `local_write_file` **仍然不标** `payload: 'file-change'`：远端 `write_file`
  //    的审批面板本来就显示原始 JSON（见 `approvalView` 的说明），本机侧没有审批
  //    前预演，也没有理由比远端多一个视图。等后端给出预览、并确认要改这个行为时
  //    再标。
  {
    name: 'local_bash',
    iconPaths: ICON_TERMINAL,
    payload: 'command',
    localExecution: true,
    // 后端 local_bash 与远端 bash 同构：前台执行挂了 `ticket.streaming(...)`
    // （`src-tauri/src/agent/tools/local_bash.rs`），输出逐块到达前端 —— 这是
    // 传输事实，照实声明。
    streamsOutput: true,
    // 但中断文案**不能**跟着这条事实走：本机没有 SSH 通道，进程也不在服务器上，
    // 「已停止等待输出并关闭 SSH 通道 / 继续在服务器上运行」全是假的；而
    // 「工具可能已执行完成」又与本机「只停止等待、进程可能仍在跑」相反。本机
    // 命令有自己那套说辞（见 `conversationStore` 的中断文案）。
    interruptNotice: 'local',
    preview: (args) => {
      const cmd = asArgString(args.command);
      return cmd ? `$ ${clip(cmd)}` : '';
    },
  },
  {
    name: 'local_read_file',
    iconPaths: ICON_DOCUMENT,
    group: 'exploration',
    localExecution: true,
    preview: pathPreview,
  },
  {
    name: 'local_write_file',
    iconPaths: ICON_PENCIL,
    localExecution: true,
    preview: pathPreview,
  },
  {
    // 与远端 edit_file 同一副长相、同一个 diff 视图：参数键与展示 metadata 都
    // 同形（后端 `local_file_ops.rs` 直接调远端那套 `resolve_edit_text` /
    // `apply_edit` / `build_edit_display_metadata`），本机与远端只差「盘在哪」。
    name: 'local_edit_file',
    iconPaths: ICON_PENCIL,
    payload: 'file-change',
    approvalView: 'diff',
    localExecution: true,
    preview: pathPreview,
  },
  {
    name: 'local_list_directory',
    iconPaths: ICON_FOLDER,
    group: 'exploration',
    localExecution: true,
    // 与 `list_directory` 同一条回退规则（`||` 不是 `??`，空串也回退根目录）
    preview: (args) => asArgString(args.path) || '/',
  },
  {
    name: 'local_subagent',
    // 有 label（远端 `subagent` 也有）：这里**不能**照抄 '子agent' —— 那会让本机
    // 子 agent 的卡片与远端子 agent 长得一模一样，而「这条指令是在自己电脑上跑」
    // 恰恰是用户必须先看见的事。
    label: '本机子agent',
    iconPaths: ICON_SUBAGENT,
    subagent: true,
    localExecution: true,
    approvalView: 'prompt',
    preview: (args) => clip(asArgString(args.description) || asArgString(args.prompt) || ''),
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

/** 产出用户直接消费的交付物（如可视化图表）——回合过程折叠时豁免。 */
export function isDeliverableTool(toolName: string): boolean {
  return toolSpec(toolName)?.deliverable === true;
}

/** skill 动态工具族（`skill_<名字>`）。 */
export function isSkillTool(toolName: string): boolean {
  return toolName.startsWith(SKILL_TOOL_PREFIX);
}

/**
 * 该工具是否在**本机**（运行 Marcel SSH 的这台电脑）上干活。
 *
 * 读的是表里 `localExecution` 的声明 —— 按**工具名**判定，不看参数：参数由模型
 * 生成、可以伪造，用参数判断「跑在哪台机器上」等于让执行者自己申报。
 */
export function isLocalExecutionTool(toolName: string): boolean {
  return toolSpec(toolName)?.localExecution === true;
}

/**
 * 本机子任务的 `sessionId` **哨兵值**（后端 `local_subagent` 的
 * `SubTaskStartEvent.sessionId` 必须原样传这个串）。
 *
 * 为什么要有它：本机子 agent 没有 SSH 会话，而任务的既有契约用「`sessionId`
 * 是不是空串」区分「真任务 / 重启恢复的占位 task」（见 `taskStore` 的占位
 * 分支），所以本机子任务需要一个**非空、且不是真会话**的值。前端据此分两类：
 *
 * - 当「真任务」用（哨兵非空即可）：状态聚合、对话占用/忙碌、回合不折叠 ——
 *   本机子任务正在跑就必须照样算在跑，不能因为「没有 SSH 会话」被当成占位。
 * - 当「SSH 会话」用：一律不认。切终端 tab、查会话连接状态、唤醒后台作业这些
 *   动作拿哨兵去查会指向一个不存在的会话 —— 该跳转的不跳、该显示「本机」的
 *   显示「本机」，别让它冒充一台机器。
 *
 * 真会话 id 两侧都是 UUID（前端 `crypto.randomUUID`、后端 `Uuid::new_v4`），
 * 所以这个串不会与任何真会话撞。
 */
export const LOCAL_SESSION_SENTINEL = 'local';

/** `sessionId` 是不是本机子任务的哨兵值（即「没有 SSH 会话」）。 */
export function isLocalSessionId(sessionId: string | null | undefined): boolean {
  return sessionId === LOCAL_SESSION_SENTINEL;
}

/**
 * `FileChangeView` 认得（并能正确分支）的工具名 —— 那个组件的 props 类型就是
 * 这份契约。
 *
 * 往表里加 `payload: 'file-change'` 的新工具时，必须同时扩展这里**和**
 * `FileChangeView` 的分支逻辑。真正拦住漏做的是 **`tsc`**：`FileChangeView` 的
 * props 是写死的字面量 union（不从本文件 import），不在其中的名字在
 * `ToolCallCard` 里传不进去；`FileChangeView` 内部还有一层穷尽检查 —— 新名字
 * 落进它的 union 却没登记分支时，编译不过（防止被默默当成 edit 渲染）。
 * `toolCatalog.test.ts` 那一侧只保证「声明了 `payload: 'file-change'` 的行恰好
 * 等于这份清单」（挡住反向遗漏），不是它守住了类型。
 */
export const FILE_CHANGE_TOOL_NAMES = ['write_file', 'edit_file', 'local_edit_file'] as const;

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
 * 用户中断时卡片该追加哪套说明（远端流式 / 本机 / 通用）。
 *
 * 缺省 `'generic'`：**不从 `streamsOutput` 推导**。推导会把「输出怎么到达前端」
 * 与「用户按下停止那一刻进程实际处于什么状态」绑死，而 `local_bash` 恰是两者
 * 不同的例子（详见 `ToolPresentation.interruptNotice`）。
 */
export function interruptNoticeKind(toolName: string): InterruptNoticeKind {
  return toolSpec(toolName)?.interruptNotice ?? 'generic';
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
