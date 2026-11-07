import { SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { useRiskRuleCatalog } from '@/hooks/useRiskRuleCatalog';
import { customRuleLabel } from '@/lib/riskRules';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * 审批里「为什么要问你」：原因（后端给出的人话）+ 命中的风险规则，合成一小段。
 *
 * 版式上刻意**不画框、不铺底色**：整个审批里颜色只留给真正要紧的信号（这里只有左边
 * 一枚小警示图标），层级靠字号、灰度和间距来分 —— 以前每块信息一个彩色框，叠起来
 * 花里胡哨，用户的视线反而找不到命令在哪。规则是文字旁一个小图标，点它 = 去设置里
 * 调整这条规则。桌面审批弹窗与手机审批底部面板共用。
 *
 * 规则名取自后端规则目录（内置）或设置里的自定义规则，不在前端抄一份。
 * 既没有原因也没命中规则（档位来自白名单、模型审批、插件声明……）就不渲染 ——
 * 此时没有「为什么」可说，别造一个空块。
 */
export function ApprovalWhy({
  reasons,
  ruleIds,
  onOpenRule,
  compact,
}: {
  reasons: string[] | undefined;
  ruleIds: string[] | undefined;
  /** 点规则：调用方负责收起弹窗并跳到该规则。不传则规则只读。 */
  onOpenRule?: (ruleId: string) => void;
  /** 手机：规则点击区更大。 */
  compact?: boolean;
}) {
  const { catalog } = useRiskRuleCatalog();
  const custom = useSettingsStore((s) => s.settings.customRiskRules);
  const hasReasons = !!reasons && reasons.length > 0;
  const hasRules = !!ruleIds && ruleIds.length > 0;
  if (!hasReasons && !hasRules) return null;

  const titleOf = (id: string): string =>
    catalog?.rules.find((r) => r.id === id)?.title ??
    custom?.filter((c) => c.id === id).map(customRuleLabel)[0] ??
    id;

  return (
    <div className="flex items-start gap-2 text-meta">
      <TriangleAlert className="mt-[3px] h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        {hasReasons &&
          reasons.map((r, i) => (
            <p key={i} className="leading-relaxed break-words whitespace-pre-wrap text-fg">
              {r}
            </p>
          ))}
        {hasRules && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-fg-tertiary">
            {ruleIds.map((id) => {
              const title = titleOf(id) || '自定义规则';
              return onOpenRule ? (
                <button
                  key={id}
                  type="button"
                  onClick={() => onOpenRule(id)}
                  title="在设置里调整这条规则"
                  aria-label={`调整规则：${title}`}
                  className={`group inline-flex max-w-full items-center gap-1 rounded-md text-fg-secondary transition-colors hover:text-fg active:text-fg ${
                    compact ? 'py-1.5' : 'py-0.5'
                  }`}
                >
                  <span className="min-w-0 truncate">规则 · {title}</span>
                  <SlidersHorizontal className="h-3 w-3 flex-shrink-0 opacity-60 group-hover:opacity-100" />
                </button>
              ) : (
                <span key={id} className="min-w-0 truncate">
                  规则 · {title}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
