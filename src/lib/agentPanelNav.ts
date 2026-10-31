/**
 * 「把桌面 Agent 面板打开」的请求通道（面板被收起时，提问的「跳转查看」要能把它请出来）。
 * 由 App 监听并改工作区布局；手机端没有可收起的面板，不用它。
 */
export const OPEN_AGENT_PANEL_EVENT = 'marcel:open-agent-panel';

export function requestOpenAgentPanel(): void {
  window.dispatchEvent(new Event(OPEN_AGENT_PANEL_EVENT));
}
