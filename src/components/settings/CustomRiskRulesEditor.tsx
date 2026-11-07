import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { CustomRiskRule, CustomRuleReason } from '@/lib/types';
import {
  CUSTOM_RULE_LEVELS,
  RULE_LEVEL_DOT,
  RULE_LEVEL_LABELS,
  customRuleLabel,
  emptyCustomRule,
  validateCustomRule,
} from '@/lib/riskRules';
import {
  CUSTOM_RULES_DOM_ID,
  CUSTOM_RULE_REVEAL_EVENT,
  customRuleDomId,
  scrollAndFlash,
  type CustomRuleRevealDetail,
} from '@/lib/riskRuleNav';
import Toggle from '@/components/ui/Toggle';
import { LevelSelect } from './RiskLevelSelect';
import { DenyMessageField } from './DenyMessageField';

const fieldClass =
  'rounded-lg border border-edge-strong bg-field text-fg outline-none placeholder:text-fg-tertiary focus:border-indigo-500';

/**
 * 自定义规则（桌面与手机共用）：每条是「命令 + 参数含 + 档位」，例如 `docker` + `prune` → 强制审批。
 * 与内置规则同层，多条命中取最严；命令名只填基础命令，参数写在「参数含」里。
 *
 * 呈现与「允许的命令」同一套小标签：规则是一排标签（命令名 + 一个档位色点），一行就能扫完，
 * 点哪个才在下面展开它的编辑区（同一时间只开一条）。档位用色点而不是文字小标签——
 * 出厂五条都是同一档，每行重复一个「请求审批」只会是噪音；具体档位在编辑区里写明。
 *
 * 外部要定位到某条规则（审批弹窗、命令测试、bash 行的「按命令规则」）时发
 * `CUSTOM_RULE_REVEAL_EVENT`，由这里打开对应那条，再滚过去高亮。
 */
export function CustomRiskRulesEditor({
  rules,
  onChange,
  compact,
  reasonTemplate,
}: {
  rules: CustomRiskRule[];
  onChange: (next: CustomRiskRule[]) => void;
  compact?: boolean;
  /** 后端给的默认说明（「拒绝说明」框预填它）；目录还没加载出来时为空。 */
  reasonTemplate?: CustomRuleReason | null;
}) {
  // 正在编辑的那一条（同一时间只开一条）。
  const [editing, setEditing] = useState<string | null>(null);
  // 同一条规则被连续定位两次时 editing 没变，靠它让滚动的 effect 再跑一次。
  const [revealTick, setRevealTick] = useState(0);
  // 定位后要滚去的目标：等 DOM 渲染完再滚（rule id，或 null = 整块）。
  const pendingScroll = useRef<{ id: string | null } | null>(null);

  useEffect(() => {
    const onReveal = (e: Event) => {
      const id = (e as CustomEvent<CustomRuleRevealDetail>).detail?.id ?? null;
      pendingScroll.current = { id };
      // 只定位到整块时不展开某条；定位到具体规则时打开它，用户一眼看到命中的是什么。
      setEditing(id);
      setRevealTick((n) => n + 1);
    };
    window.addEventListener(CUSTOM_RULE_REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(CUSTOM_RULE_REVEAL_EVENT, onReveal);
  }, []);

  // 下一帧再滚：此时目标标签与编辑区都已渲染，滚动位置才准。
  useEffect(() => {
    const pending = pendingScroll.current;
    if (!pending) return;
    pendingScroll.current = null;
    const frame = requestAnimationFrame(() => {
      scrollAndFlash(
        document.getElementById(
          pending.id ? customRuleDomId(pending.id) : CUSTOM_RULES_DOM_ID,
        ),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, revealTick]);

  const patch = (id: string, next: Partial<CustomRiskRule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...next } : r)));

  const addRule = () => {
    const rule = emptyCustomRule();
    onChange([...rules, rule]);
    setEditing(rule.id);
  };

  const removeRule = (id: string) => {
    onChange(rules.filter((r) => r.id !== id));
    setEditing((cur) => (cur === id ? null : cur));
  };

  const editingRule = rules.find((r) => r.id === editing) ?? null;
  const chipHeight = compact ? 'min-h-10 text-body' : 'min-h-8 text-meta';

  return (
    <div id={CUSTOM_RULES_DOM_ID} className="space-y-3 rounded-lg transition-colors duration-500">
      {rules.length === 0 && (
        <p className="text-meta leading-relaxed text-fg-tertiary">
          还没有规则。例如：命令 <span className="font-mono">docker</span>、参数含{' '}
          <span className="font-mono">prune</span> → 强制审批。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {rules.map((rule) => {
          const label = customRuleLabel(rule);
          const invalid = validateCustomRule(rule) !== null;
          const selected = editing === rule.id;
          return (
            <button
              key={rule.id}
              type="button"
              id={customRuleDomId(rule.id)}
              onClick={() => setEditing((cur) => (cur === rule.id ? null : rule.id))}
              aria-expanded={selected}
              title={
                !rule.enabled
                  ? `${label || '新规则'}（已关闭）`
                  : invalid
                    ? `${label || '新规则'}（填好之前不生效）`
                    : `${label}：${RULE_LEVEL_LABELS[rule.level]}`
              }
              className={`inline-flex max-w-full items-center gap-2 rounded-lg border px-3 font-mono transition-colors ${chipHeight} ${
                selected
                  ? 'border-indigo-500 bg-indigo-500/10 text-fg'
                  : invalid && rule.enabled
                    ? 'border-dashed border-amber-700/60 bg-fill text-fg-secondary hover:bg-fill-strong'
                    : 'border-edge bg-fill text-fg hover:bg-fill-strong active:bg-state-mid'
              } ${rule.enabled ? '' : 'opacity-50'}`}
            >
              <span
                className={`h-2 w-2 flex-shrink-0 rounded-full ${
                  rule.enabled && !invalid ? RULE_LEVEL_DOT[rule.level] : 'bg-zinc-600'
                }`}
              />
              <span className={`truncate ${rule.enabled ? '' : 'line-through'}`}>
                {label || '未填写'}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={addRule}
          className={`inline-flex items-center gap-2 rounded-lg border border-dashed border-edge-strong px-3 text-fg-secondary transition-colors hover:border-indigo-500 hover:text-indigo-300 active:text-indigo-300 ${chipHeight}`}
        >
          <Plus className="h-3.5 w-3.5" />
          添加规则
        </button>
      </div>
      {editingRule && (
        <RuleEditor
          // 换一条规则时重建，免得上一条的聚焦/输入状态串过来。
          key={editingRule.id}
          rule={editingRule}
          compact={compact}
          reasonTemplate={reasonTemplate}
          onPatch={(next) => patch(editingRule.id, next)}
          onRemove={() => removeRule(editingRule.id)}
        />
      )}
    </div>
  );
}

/** 点开某条规则后的编辑区：命令、参数含、启用、档位、删除。 */
function RuleEditor({
  rule,
  compact,
  reasonTemplate,
  onPatch,
  onRemove,
}: {
  rule: CustomRiskRule;
  compact?: boolean;
  reasonTemplate?: CustomRuleReason | null;
  onPatch: (next: Partial<CustomRiskRule>) => void;
  onRemove: () => void;
}) {
  const error = validateCustomRule(rule);
  const input = `${fieldClass} w-full min-w-0 font-mono ${
    compact ? 'px-3 py-3 text-body' : 'px-3 py-2 text-body'
  }`;
  const caption = 'text-meta text-fg-tertiary';

  return (
    <div className="space-y-3 rounded-xl border border-edge bg-surface-sunken/30 p-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="min-w-0 space-y-1">
          <span className={caption}>命令</span>
          <input
            type="text"
            value={rule.command}
            onChange={(e) => onPatch({ command: e.target.value })}
            placeholder="如 docker"
            aria-label="自定义规则：命令名"
            autoFocus={rule.command === ''}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={input}
          />
        </label>
        <label className="min-w-0 space-y-1">
          <span className={caption}>参数含（可选）</span>
          <input
            type="text"
            value={rule.argContains}
            onChange={(e) => onPatch({ argContains: e.target.value })}
            placeholder="如 prune"
            aria-label="自定义规则：参数包含"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={input}
          />
        </label>
      </div>
      {error && rule.command !== '' && (
        <p className="text-meta text-amber-400/90">{error}，填好之前这条规则不生效。</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Toggle
          size="md"
          checked={rule.enabled}
          onChange={(enabled) => onPatch({ enabled })}
          label="启用"
        />
        <span className="ml-auto flex items-center gap-2">
          <LevelSelect
            ariaLabel={`${rule.command || '新规则'}：处置档位`}
            value={rule.level}
            options={CUSTOM_RULE_LEVELS}
            compact={compact}
            onChange={(level) => onPatch({ level })}
          />
          <button
            type="button"
            onClick={onRemove}
            className={`inline-flex flex-shrink-0 items-center gap-2 rounded-lg border border-edge text-fg-secondary transition-colors hover:border-red-700/50 hover:bg-red-500/10 hover:text-red-300 active:bg-red-500/10 active:text-red-300 ${
              compact ? 'min-h-11 px-4 text-body' : 'min-h-9 px-3 text-body'
            }`}
            aria-label="删除这条规则"
          >
            <Trash2 className="h-4 w-4" />
            删除
          </button>
        </span>
      </div>
      {rule.level === 'Deny' && (
        <DenyMessageField
          stored={rule.message ?? ''}
          template={reasonTemplate?.reason ?? ''}
          vars={reasonTemplate?.reasonVars ?? []}
          onChange={(message) => onPatch({ message })}
          ariaLabel={`${rule.command || '新规则'}：拒绝说明`}
          compact={compact}
        />
      )}
    </div>
  );
}
