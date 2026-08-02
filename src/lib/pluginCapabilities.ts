/**
 * Plugin capability display labels + risk coloring. Single source of truth
 * for the settings plugin manager and the plugin market detail view.
 * Mirrors docs/plugin-api.md#capability-系统.
 */

export interface CapabilityMeta {
  label: string;
  /** 风险等级用于 UI 高亮：high 醒目警示，medium 一般，low 中性。 */
  risk: 'high' | 'medium' | 'low';
}

export const CAPABILITY_META: Record<string, CapabilityMeta> = {
  'ssh.list': { label: '查询 SSH 会话与连接信息', risk: 'low' },
  'ssh.exec': { label: '执行远程命令', risk: 'high' },
  'sftp.read': { label: '读取远程文件', risk: 'medium' },
  'sftp.write': { label: '写入远程文件', risk: 'high' },
  'fs.read': { label: '读取本地文件（仅插件目录）', risk: 'medium' },
  'fs.write': { label: '写入本地文件（仅插件目录）', risk: 'high' },
  'net.request': { label: '发起网络请求', risk: 'high' },
  'notification': { label: '发送通知', risk: 'low' },
  'events': { label: '订阅应用事件', risk: 'low' },
  'ui.inject': { label: '注入主界面（JS/CSS）', risk: 'high' },
  'window.create': { label: '创建独立悬浮窗口', risk: 'medium' },
  'window.always_on_top': { label: '窗口始终置顶', risk: 'high' },
  'window.transparent': { label: '透明窗口', risk: 'high' },
  'window.skip_taskbar': { label: '窗口不进任务栏', risk: 'medium' },
  'context_menu': { label: '注册原生右键菜单', risk: 'low' },
};

/** 兼容旧引用的便捷导出（label 兜底返回原名）。 */
export function capabilityLabel(cap: string): string {
  return CAPABILITY_META[cap]?.label ?? cap;
}

export function capabilityRisk(cap: string): CapabilityMeta['risk'] {
  return CAPABILITY_META[cap]?.risk ?? 'medium';
}
