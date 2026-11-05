import { collectPlatformHints, isMobilePlatform } from '@/platform';
import { useRiskRuleFocusStore } from '@/stores/riskRuleFocusStore';
import { useSettingsNavStore } from '@/stores/settingsNavStore';
import { useViewStore } from '@/stores/viewStore';

/** 设置里承载「安全与审批」（及其下「内置风险规则」二级页）的分类 id：两端都是「Agent」页（目录见 `settingsCatalog`）。 */
export const RISK_RULES_DESKTOP_CATEGORY = 'agent';
export const RISK_RULES_MOBILE_CATEGORY = 'agent';

/**
 * 打开设置里的「内置风险规则」二级页并定位到某一条（审批弹窗里"调整这条规则"用）。
 *
 * 平台差异只在这里：桌面切到设置视图再跳分类，手机经 `mobile:open-settings`
 * 事件切到设置 Tab（与记忆页同一条路，见 `memoryNav.openMemorySettings`）。
 * 打开二级页与定位都走 `riskRuleFocusStore`：`focus(id)` 一步把页打开并留下待处理的定位，
 * 规则列表挂载后接手。
 */
export function openRiskRule(ruleId: string): void {
  useRiskRuleFocusStore.getState().focus(ruleId);
  if (isMobilePlatform(collectPlatformHints())) {
    window.dispatchEvent(
      new CustomEvent('mobile:open-settings', {
        detail: { category: RISK_RULES_MOBILE_CATEGORY },
      }),
    );
    return;
  }
  useViewStore.getState().setActiveId('builtin.settings');
  useSettingsNavStore.getState().requestNavigate(RISK_RULES_DESKTOP_CATEGORY);
}

/** 自定义规则行的 DOM id（命令测试里点命中的自定义规则时，据此滚过去）。 */
export const customRuleDomId = (id: string) => `risk-rule-${id}`;

/** 自定义规则整块的 DOM id（「需要审批的工具」里 bash 那行点「按命令规则」时据此滚过去）。 */
export const CUSTOM_RULES_DOM_ID = 'custom-risk-rules';

export function scrollAndFlash(el: HTMLElement | null): void {
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('bg-indigo-500/10');
  window.setTimeout(() => el.classList.remove('bg-indigo-500/10'), 1800);
}

/**
 * 要求自定义规则编辑器露出某条规则（或整块）。编辑器默认是收起的，目标行此时还不在 DOM 里，
 * 所以不能直接 `getElementById` 去滚：改发事件，由编辑器自己展开、渲染完再滚过去高亮。
 * `id` 为 null 表示只定位到整块。
 */
export const CUSTOM_RULE_REVEAL_EVENT = 'marcel:reveal-custom-rule';
export interface CustomRuleRevealDetail {
  id: string | null;
}
function revealCustomRule(id: string | null): void {
  window.dispatchEvent(
    new CustomEvent<CustomRuleRevealDetail>(CUSTOM_RULE_REVEAL_EVENT, {
      detail: { id },
    }),
  );
}

/** 展开「命令执行策略」主页面里的某条自定义规则、滚过去并短暂高亮。内置规则不走这里（它们在二级页）。 */
export function flashCustomRule(id: string): void {
  revealCustomRule(id);
}

/** 展开自定义规则那一块、滚过去并短暂高亮。 */
export function scrollToCustomRules(): void {
  revealCustomRule(null);
}
