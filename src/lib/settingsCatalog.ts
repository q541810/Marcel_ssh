/**
 * 设置页目录的唯一来源（桌面与手机共用）。
 *
 * 之前两端各写一份目录（桌面 `components/settings/settingsNavigation.tsx`、手机
 * `mobile/mobileSettingsModel.ts`），名字、分法、顺序慢慢漂成两套，用户在两台设备间切换
 * 要重新找一遍。现在「有哪几页、叫什么、分哪组、什么顺序」只在这里定义；两端各自只决定
 * 每一页里挂哪些分区（平台差异留在各自的文件里），不再各起一套页名。
 *
 * 加页 / 改名 / 调序只动这里。页 id 同时是跳转用的 id：`memoryNav` / `syncNav` /
 * `riskRuleNav` 里的常量必须是这里存在的 id（`settingsCatalog.test.ts` 会校验）。
 */

export type SettingsPageId =
  | 'model'
  | 'agent'
  | 'memory'
  | 'tools'
  | 'appearance'
  | 'notification'
  | 'sync'
  | 'about';

export type SettingsGroupId = 'ai' | 'app' | 'about';

export interface SettingsGroup {
  id: SettingsGroupId;
  /** 组标题；null 表示这一组不显示标题（「关于」单独放在最底下）。 */
  title: string | null;
}

export interface SettingsPage {
  id: SettingsPageId;
  title: string;
  /** 手机端列表里的一句话说明（桌面端不显示）。 */
  description: string;
  group: SettingsGroupId;
  /**
   * 旧名字 / 同义词，给桌面端搜索当关键词：改名后老用户还按旧名搜，仍要能搜到这一页的内容。
   */
  aliases: readonly string[];
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'ai', title: 'AI 助手' },
  { id: 'app', title: '应用' },
  { id: 'about', title: null },
] as const;

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: 'model',
    title: '模型',
    description: 'API 渠道与模型配置',
    group: 'ai',
    aliases: ['模型服务', 'LLM', 'API'],
  },
  {
    id: 'agent',
    title: 'Agent',
    description: '安全与审批、附加指令、执行限制',
    group: 'ai',
    aliases: ['Agent 策略', '命令策略', '命令执行策略', '审批'],
  },
  {
    id: 'memory',
    title: '记忆',
    description: '长期记忆、后台复盘与整理助手',
    group: 'ai',
    aliases: [],
  },
  {
    id: 'tools',
    title: '工具与扩展',
    description: '联网搜索、技能、MCP 服务与插件',
    group: 'ai',
    aliases: ['工具能力', 'Agent 工具', 'MCP', '插件', '插件市场', '技能', 'Skill'],
  },
  {
    id: 'appearance',
    title: '外观与终端',
    description: '主题、终端字体、快捷命令与对话显示',
    group: 'app',
    aliases: ['界面', '外观与显示', '文件传输', '快捷命令'],
  },
  {
    id: 'notification',
    title: '通知',
    description: 'Agent 事件提醒与后台保活',
    group: 'app',
    aliases: ['通知与后台', '后台保活'],
  },
  {
    id: 'sync',
    title: '同步与会话',
    description: '跨设备同步、聊天历史与会话归档',
    group: 'app',
    aliases: ['跨设备同步', '会话与归档', '会话归档', '聊天历史记录'],
  },
  {
    id: 'about',
    title: '关于',
    description: '版本信息与检查更新',
    group: 'about',
    aliases: [],
  },
] as const;

export function getSettingsPage(id: string): SettingsPage | undefined {
  return SETTINGS_PAGES.find((p) => p.id === id);
}

export function isSettingsPageId(id: string): id is SettingsPageId {
  return SETTINGS_PAGES.some((p) => p.id === id);
}

/** 把页面列表按组切开（保持目录顺序），两端列表渲染共用。 */
export function groupSettingsPages<T extends { group: SettingsGroupId }>(
  pages: readonly T[],
): { group: SettingsGroup; pages: T[] }[] {
  return SETTINGS_GROUPS.map((group) => ({
    group,
    pages: pages.filter((p) => p.group === group.id),
  })).filter((g) => g.pages.length > 0);
}
