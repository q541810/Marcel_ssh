import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, RotateCcw } from 'lucide-react';
import type { RiskListInfo, RiskRuleInfo, RiskRuleOverride } from '@/lib/types';
import {
  PROTECTED_PATHS_LIST,
  RULE_LEVELS,
  RULE_LEVEL_LABELS,
  effectiveLevel,
  effectiveList,
  isExemptionOn,
  isListModified,
  isLoosened,
  isRuleModified,
  modifiedRuleCount,
  normalizeListItems,
  resetRule,
  ruleMatchesQuery,
  setExemptionOn,
  setRuleLevel,
  setRuleList,
  setRuleMessage,
  type RiskRuleOverrides,
} from '@/lib/riskRules';
import { useRiskRuleCatalog } from '@/hooks/useRiskRuleCatalog';
import Toggle from '@/components/ui/Toggle';
import { LevelSelect } from './RiskLevelSelect';
import { DenyMessageField } from './DenyMessageField';

/** 只给 Windows 规则打标：其余规则按 POSIX 写法判定，是默认，逐条标出来只是噪音。 */
const SCOPE_LABEL: Record<string, string> = {
  windows: 'Windows',
};

/**
 * 在别处管理的名单：同一份数据只在一个地方改，免得用户在两处各改一遍还对不上。
 * 受保护目录在「命令执行策略 → 受保护路径」里和自己加的目录放在一起管理。
 */
const MANAGED_ELSEWHERE: Record<string, string> = {
  [PROTECTED_PATHS_LIST]: '目录在「命令执行策略 → 受保护路径」里编辑。',
};

interface RiskRulesEditorProps {
  overrides: RiskRuleOverrides;
  onChange: (next: RiskRuleOverrides) => void;
  /** 手机：更大的点击区域。桌面与手机共用同一份逻辑与结构。 */
  compact?: boolean;
  /** 想让列表展开并滚到某条规则（命令测试、审批弹窗里点命中的规则）。`nonce` 变化才触发。 */
  focusRuleId?: string | null;
  focusNonce?: number;
  /** 列表接下这次定位请求后调用（让请求方清掉待处理状态，别在下次挂载时重放）。 */
  onFocusHandled?: () => void;
  /** 点规则示例：拿去「测试命令」试一下。不给就不可点。 */
  onTryExample?: (command: string) => void;
}

const fieldClass =
  'rounded-lg field text-fg disabled:opacity-40';

/** 一个可编辑名单：条目是可删的小标签，下面一个输入框添加；与默认不同时给「恢复默认」。 */
function ListEditor({
  info,
  items,
  modified,
  onChange,
  onReset,
  compact,
}: {
  info: RiskListInfo;
  items: string[];
  modified: boolean;
  onChange: (items: string[]) => void;
  onReset: () => void;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const incoming = normalizeListItems(draft.split(/[\s,，]+/));
    if (incoming.length === 0) return;
    onChange(normalizeListItems([...items, ...incoming]));
    setDraft('');
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-meta font-medium text-fg-secondary">
          {info.label}
          <span className="ml-2 font-normal text-fg-tertiary">
            {items.length}
          </span>
        </span>
        {modified && (
          <button
            type="button"
            onClick={onReset}
            className="text-meta text-indigo-300 hover:text-indigo-200 active:text-indigo-200"
          >
            恢复默认名单
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {items.length === 0 && (
          <span className="text-meta italic text-fg-tertiary">名单为空</span>
        )}
        {items.map((it) => (
          <span
            key={it}
            className="inline-flex items-center gap-1 rounded-md border border-edge bg-surface-raised py-0.5 pl-2 pr-1 font-mono text-caption text-fg"
          >
            {it}
            <button
              type="button"
              onClick={() => onChange(items.filter((x) => x !== it))}
              className={`text-fg-tertiary hover:text-red-400 active:text-red-400 ${compact ? 'px-1' : ''}`}
              aria-label={`移除 ${it}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder="+ 添加（空格分隔可填多个）"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={`${info.label}：添加条目`}
          className={`${fieldClass} min-w-0 flex-1 border font-mono ${
            compact ? 'px-3 py-3 text-body' : 'px-3 py-2 text-meta'
          }`}
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className={`flex-shrink-0 rounded-lg bg-fill text-fg hover:bg-fill-strong active:bg-state-mid disabled:opacity-40 ${
            compact ? 'px-4 py-3 text-body' : 'px-3 py-2 text-meta'
          }`}
        >
          添加
        </button>
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  overrides,
  expanded,
  highlighted,
  onToggle,
  onChange,
  onTryExample,
  compact,
}: {
  rule: RiskRuleInfo;
  /** 完整的覆盖表（改动函数返回新的完整覆盖表）。 */
  overrides: RiskRuleOverrides;
  expanded: boolean;
  highlighted: boolean;
  onToggle: () => void;
  onChange: (next: RiskRuleOverrides) => void;
  onTryExample?: (command: string) => void;
  compact?: boolean;
}) {
  const override: RiskRuleOverride | undefined = overrides[rule.id];
  const isExemption = rule.kind === 'exemption';
  const level = effectiveLevel(rule, override);
  const modified = isRuleModified(override);
  const loosened = isExemption
    ? !isExemptionOn(override)
    : isLoosened(rule.defaultLevel, level);
  const emit = (fn: (o: RiskRuleOverrides) => RiskRuleOverrides) =>
    onChange(fn(overrides));

  return (
    <div
      id={`risk-rule-${rule.id}`}
      className={`relative border-b border-edge-subtle transition-colors last:border-b-0 ${
        highlighted ? 'bg-indigo-500/10' : ''
      }`}
    >
      {/* 左侧细条：改过的靛蓝、调松了的红 —— 一眼扫出自己动过什么。 */}
      {modified && (
        <span
          aria-hidden
          className={`absolute bottom-0 left-0 top-0 w-0.5 ${loosened ? 'bg-red-400' : 'bg-indigo-400'}`}
        />
      )}
      <div
        className={`flex items-center gap-2 ${compact ? 'px-3 py-3' : 'px-4 py-3'}`}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 flex-shrink-0 text-fg-tertiary transition-transform ${
              expanded ? 'rotate-90' : ''
            }`}
          />
          <span className="min-w-0 text-body text-fg">{rule.title}</span>
          {rule.scope === 'windows' && (
            <span className="flex-shrink-0 rounded border border-edge px-1 py-px text-caption text-fg-secondary">
              {SCOPE_LABEL[rule.scope]}
            </span>
          )}
        </button>
        {modified && (
          <button
            type="button"
            onClick={() => onChange(resetRule(overrides, rule.id))}
            className="flex-shrink-0 rounded p-1 text-fg-tertiary hover:text-fg active:text-fg"
            aria-label={`${rule.title}：恢复默认`}
            title={`恢复默认（${isExemption ? '开' : RULE_LEVEL_LABELS[rule.defaultLevel]}）`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
        {isExemption ? (
          <Toggle
            size={compact ? 'md' : 'sm'}
            checked={isExemptionOn(override)}
            onChange={(on) => emit((o) => setExemptionOn(o, rule, on))}
          />
        ) : (
          <LevelSelect
            ariaLabel={`${rule.title}：处置档位`}
            value={level}
            options={RULE_LEVELS}
            defaultLevel={rule.defaultLevel}
            onChange={(l) => emit((o) => setRuleLevel(o, rule, l))}
            compact={compact}
          />
        )}
      </div>

      {expanded && (
        <div className={`space-y-3 pb-3 ${compact ? 'px-3' : 'pl-10 pr-4'}`}>
          <p className="text-meta leading-relaxed text-fg-secondary">
            {rule.description}
            {!isExemption && level !== rule.defaultLevel && (
              <span className={loosened ? 'text-red-300' : 'text-fg-tertiary'}>
                {' '}
                默认是「{RULE_LEVEL_LABELS[rule.defaultLevel]}」。
              </span>
            )}
          </p>
          {rule.examples.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {rule.examples.map((ex) =>
                onTryExample ? (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => onTryExample(ex)}
                    title="拿去测试命令里试一下"
                    className="rounded-md border border-edge bg-fill px-2 py-0.5 font-mono text-caption text-fg-secondary hover:border-indigo-500/60 hover:text-fg active:text-fg"
                  >
                    {ex}
                  </button>
                ) : (
                  <code
                    key={ex}
                    className="rounded-md border border-edge bg-surface-raised px-2 py-0.5 font-mono text-caption text-fg-secondary"
                  >
                    {ex}
                  </code>
                ),
              )}
            </div>
          )}
          {rule.lists.map((l) =>
            MANAGED_ELSEWHERE[l.key] ? (
              <p key={l.key} className="text-caption text-fg-tertiary">
                {MANAGED_ELSEWHERE[l.key]}
              </p>
            ) : (
              <ListEditor
                key={l.key}
                info={l}
                items={effectiveList(rule, l.key, override)}
                modified={isListModified(rule, l.key, override)}
                onChange={(items) =>
                  emit((o) => setRuleList(o, rule, l.key, items))
                }
                onReset={() => emit((o) => setRuleList(o, rule, l.key, null))}
                compact={compact}
              />
            ),
          )}
          {!isExemption && level === 'Deny' && (
            <DenyMessageField
              stored={override?.message ?? ''}
              template={rule.reason}
              vars={rule.reasonVars}
              onChange={(m) => emit((o) => setRuleMessage(o, rule, m))}
              ariaLabel={`${rule.title}：拒绝说明`}
              compact={compact}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 内置风险规则列表（「内置风险规则」二级页的主体，桌面与手机共用）：全部规则平铺，没有分类，
 * 点开一条才看到说明、示例和名单。
 *
 * 规则、说明与默认值来自后端目录；这里只负责呈现与改动。所有改动都翻译成「只存差异」的
 * 覆盖项（见 `lib/riskRules.ts`），默认配置下用户什么也不用动。自己加的规则在主页面
 * 「自定义规则」里，不在这一页。
 */
export function RiskRulesEditor({
  overrides,
  onChange,
  compact,
  focusRuleId,
  focusNonce,
  onFocusHandled,
  onTryExample,
}: RiskRulesEditorProps) {
  const { catalog, error, retry } = useRiskRuleCatalog();
  const [query, setQuery] = useState('');
  const [onlyModified, setOnlyModified] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<string | null>(null);

  // 外部要求定位到某条规则。分两步：先把请求接下来（可能早于规则目录加载完），
  // 目录就绪、行渲染出来之后再展开、滚到视野、短暂高亮。
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  useEffect(() => {
    if (!focusRuleId) return;
    setPendingFocus(focusRuleId);
    onFocusHandled?.();
    // 只跟 nonce 走：同一条规则被连续点两次也要再触发一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);
  const catalogReady = catalog !== null;
  useEffect(() => {
    if (!pendingFocus || !catalogReady) return;
    const id = pendingFocus;
    setPendingFocus(null);
    setQuery('');
    setOnlyModified(false);
    setExpanded((prev) => new Set(prev).add(id));
    setHighlight(id);
    // 等搜索清空、行展开后的那次渲染落地，再去找元素。
    const raf = requestAnimationFrame(() => {
      document
        .getElementById(`risk-rule-${id}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const timer = setTimeout(() => setHighlight(null), 1800);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [pendingFocus, catalogReady]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const modifiedCount = modifiedRuleCount(overrides);
  const visible = useMemo(() => {
    if (!catalog) return [];
    return catalog.rules.filter(
      (r) =>
        (!onlyModified || isRuleModified(overrides[r.id])) &&
        ruleMatchesQuery(r, overrides[r.id], query),
    );
  }, [catalog, overrides, query, onlyModified]);

  if (error) {
    return (
      <div className="space-y-2 px-4 py-4 text-body">
        <p className="text-red-300">读取规则目录失败：{error}</p>
        <button
          type="button"
          onClick={retry}
          className="rounded-lg bg-fill px-3 py-2 text-meta text-fg hover:bg-fill-strong"
        >
          重试
        </button>
      </div>
    );
  }
  if (!catalog) {
    return <p className="px-4 py-4 text-body text-fg-tertiary">正在读取规则…</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜规则、命令、目录"
          aria-label="搜索命令规则"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={`${fieldClass} min-w-0 flex-1 border ${
            compact ? 'px-3 py-3 text-body' : 'px-3 py-2 text-body'
          }`}
        />
        {modifiedCount > 0 && (
          <button
            type="button"
            onClick={() => setOnlyModified((v) => !v)}
            aria-pressed={onlyModified}
            className={`flex-shrink-0 rounded-full border text-indigo-200 ${
              onlyModified
                ? 'border-indigo-500 bg-indigo-500/20'
                : 'border-indigo-700/50 bg-indigo-500/10 hover:bg-indigo-500/15'
            } ${compact ? 'px-3 py-2 text-body' : 'px-3 py-1 text-meta'}`}
          >
            已改 {modifiedCount}
          </button>
        )}
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-edge-subtle px-4 py-6 text-center text-body text-fg-tertiary">
          没有匹配的规则
        </p>
      ) : (
        <div className="rounded-xl border border-edge-subtle bg-surface/50 [&>*:first-child]:rounded-t-xl [&>*:last-child]:rounded-b-xl">
          {visible.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              overrides={overrides}
              expanded={expanded.has(rule.id) || query.trim() !== ''}
              highlighted={highlight === rule.id}
              onToggle={() => toggle(rule.id)}
              onChange={onChange}
              onTryExample={onTryExample}
              compact={compact}
            />
          ))}
        </div>
      )}
    </div>
  );
}
