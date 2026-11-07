import { CheckCircle2, CircleHelp, XCircle } from 'lucide-react';
import type { CommandCheckResult } from '@/lib/types';
import {
  OUTCOME_LABELS,
  RULE_LEVEL_DOT,
  RULE_LEVEL_LABELS,
  groupOutcomes,
  type CheckMode,
  type CommandOutcome,
} from '@/lib/riskRules';

const OUTCOME_STYLE: Record<
  CommandOutcome,
  { text: string; icon: React.ReactNode }
> = {
  run: { text: 'text-emerald-400', icon: <CheckCircle2 className="h-4 w-4" /> },
  ask: { text: 'text-amber-400', icon: <CircleHelp className="h-4 w-4" /> },
  deny: { text: 'text-red-400', icon: <XCircle className="h-4 w-4" /> },
};

/**
 * 「测试命令」的结果（桌面与手机共用）。
 *
 * 一行结论：这条命令在三种模式下各会怎样（「先问你 Agent · 直接执行 Plan、Auto」，三种一样就写
 * 「所有模式」）。结论下面是**原因**：命中了哪几条风险规则，是只读的，点一下跳到那条规则去调 ——
 * 这里不放档位下拉，免得测试框里又长出一份规则列表。
 */
export function CommandCheckResultCard({
  results,
  onJump,
  compact,
  modelApprovalOn,
}: {
  results: { mode: CheckMode; result: CommandCheckResult }[];
  /** 点一条命中的规则：调用方负责跳到它（内置规则进二级页，自定义规则滚到主页面那一行）。 */
  onJump: (ruleId: string) => void;
  compact?: boolean;
  /**
   * 「执行前模型审批」开着：测试只模拟规则这一关，不会真去问模型，所以结论下面要提醒一句 ——
   * 模型审批能把规则放行的命令拦下（任何模式），「直接执行」只是规则这一关的结论。
   */
  modelApprovalOn?: boolean;
}) {
  const groups = groupOutcomes(results);
  // 档位与模式无关，各模式命中的规则一样；取 Agent 那份。
  const hits =
    (results.find((r) => r.mode === 'agent') ?? results[0])?.result.hits ?? [];

  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {groups.map((g) => (
          <span
            key={g.outcome}
            className={`inline-flex items-center gap-2 text-body font-medium ${OUTCOME_STYLE[g.outcome].text}`}
          >
            {OUTCOME_STYLE[g.outcome].icon}
            {OUTCOME_LABELS[g.outcome]}
            <span className="text-meta font-normal text-fg-tertiary">
              {g.all ? '所有模式' : g.modes.join(' · ')}
            </span>
          </span>
        ))}
      </div>
      {hits.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-meta text-fg-tertiary">原因</span>
          {hits.map((hit) => (
            <button
              key={hit.ruleId}
              type="button"
              onClick={() => onJump(hit.ruleId)}
              title="去规则里看"
              aria-label={`${hit.title}：${RULE_LEVEL_LABELS[hit.level]}，去规则里看`}
              className={`inline-flex items-center gap-2 rounded-full border border-edge-strong bg-surface-raised text-fg hover:bg-state-mid active:bg-state-mid ${
                compact ? 'px-3 py-2 text-meta' : 'px-3 py-0.5 text-meta'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${RULE_LEVEL_DOT[hit.level]}`}
              />
              {hit.title}
              <span className="text-fg-tertiary">
                {RULE_LEVEL_LABELS[hit.level]}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-meta text-fg-tertiary">没有命中任何规则</p>
      )}
      {modelApprovalOn && (
        <p className="text-meta leading-relaxed text-fg-tertiary">
          这里只测规则这一关。你开了「执行前模型审批」，规则放行的命令实际执行前还会让模型再看一遍，可能被拦下。
        </p>
      )}
    </div>
  );
}
