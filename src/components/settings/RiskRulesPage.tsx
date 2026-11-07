import { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { modifiedRuleCount } from '@/lib/riskRules';
import { useRiskRuleFocusStore } from '@/stores/riskRuleFocusStore';
import { RiskRulesEditor } from './RiskRulesEditor';
import { useSettingsActions } from './SettingsActionsContext';

/**
 * 「内置风险规则」二级页（桌面与手机共用）。
 *
 * 桌面自己带返回链接和标题（`compact` 为假）；手机的返回与标题在设置页的顶栏里
 * （`MobileSettings`），这里只放说明和列表。「全部恢复默认」要点两次才生效 —— 它一次清掉
 * 所有内置规则的改动，但又不值得一个确认弹窗，所以按钮自己变成"再点一次确认"，几秒后复原。
 */
export function RiskRulesPage({ compact }: { compact?: boolean }) {
  const { settings, update } = useSettingsActions();
  const closePage = useRiskRuleFocusStore((s) => s.closePage);
  const focusRuleId = useRiskRuleFocusStore((s) => s.ruleId);
  const focusNonce = useRiskRuleFocusStore((s) => s.nonce);
  const clearFocus = useRiskRuleFocusStore((s) => s.clear);
  const tryCommand = useRiskRuleFocusStore((s) => s.tryCommand);

  const overrides = settings.riskRuleOverrides ?? {};
  const modified = modifiedRuleCount(overrides);

  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const timer = window.setTimeout(() => setConfirmReset(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmReset]);
  useEffect(() => {
    if (modified === 0) setConfirmReset(false);
  }, [modified]);

  return (
    <div className="space-y-3">
      {!compact && (
        <button
          type="button"
          onClick={closePage}
          className="-ml-1 inline-flex items-center gap-1 text-body text-indigo-300 hover:text-indigo-200"
        >
          <ChevronLeft className="h-4 w-4" />
          命令执行策略
        </button>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {!compact && (
            <h2 className="text-title text-fg">
              内置风险规则
            </h2>
          )}
          <p className="text-meta leading-relaxed text-fg-tertiary">
            命令命中任一条就按它的档位处理；同时命中几条，取最严的。
          </p>
        </div>
        {modified > 0 && (
          <button
            type="button"
            onClick={() => {
              if (!confirmReset) {
                setConfirmReset(true);
                return;
              }
              update({ riskRuleOverrides: {} });
              setConfirmReset(false);
            }}
            className={`flex-shrink-0 whitespace-nowrap text-meta ${
              confirmReset
                ? 'text-red-300 hover:text-red-200'
                : 'text-indigo-300 hover:text-indigo-200 active:text-indigo-200'
            }`}
          >
            {confirmReset ? `再点一次，恢复 ${modified} 条` : '全部恢复默认'}
          </button>
        )}
      </div>
      <RiskRulesEditor
        overrides={overrides}
        onChange={(next) => update({ riskRuleOverrides: next })}
        focusRuleId={focusRuleId}
        focusNonce={focusNonce}
        onFocusHandled={clearFocus}
        onTryExample={tryCommand}
        compact={compact}
      />
    </div>
  );
}
