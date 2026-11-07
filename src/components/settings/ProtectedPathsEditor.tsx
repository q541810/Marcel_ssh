import { useState } from 'react';
import type { RiskRuleInfo } from '@/lib/types';
import {
  PROTECTED_PATHS_LIST,
  effectiveList,
  preCheckCustomPath,
  setRuleList,
  type RiskRuleOverrides,
} from '@/lib/riskRules';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import Button from '@/components/ui/Button';

export interface ProtectedPathsPatch {
  riskRuleOverrides?: RiskRuleOverrides;
  customProtectedPaths?: string[];
}

/**
 * 受保护路径（桌面与手机共用）：一份名单里同时有「内置」目录和用户自己加的目录，都能删。
 *
 * 数据其实分两处存：内置目录是规则表里 `protected_paths` 规则的名单（用户的删改存成覆盖项，
 * 没改过就跟着版本升级），自己加的存在 `customProtectedPaths`。界面不让用户分辨这两处：
 * 内置的带个「内置」小标，删掉的内置目录留一个划线的占位，点 ↺ 找回；新加的一律进自己的名单。
 * 这条规则的**档位**（命中后是审批还是拒绝）在「内置风险规则」二级页里调。
 */
export function ProtectedPathsEditor({
  rule,
  overrides,
  customPaths,
  onChange,
  compact,
}: {
  /** 规则目录里的 `protected_paths` 规则；目录还没读到时为 null。 */
  rule: RiskRuleInfo | null;
  overrides: RiskRuleOverrides;
  customPaths: string[];
  onChange: (patch: ProtectedPathsPatch) => void;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const listInfo = rule?.lists.find((l) => l.key === PROTECTED_PATHS_LIST);
  const defaults = listInfo?.defaults ?? [];
  const builtIns = rule
    ? effectiveList(rule, PROTECTED_PATHS_LIST, overrides[rule.id])
    : [];
  const removed = defaults.filter((d) => !builtIns.includes(d));

  const setBuiltIns = (items: string[]) => {
    if (!rule) return;
    onChange({
      riskRuleOverrides: setRuleList(
        overrides,
        rule,
        PROTECTED_PATHS_LIST,
        items,
      ),
    });
  };
  /** 找回一个删掉的内置目录：放回它在默认名单里的位置，不打乱其余顺序。 */
  const restore = (path: string) => {
    const keep = new Set([...builtIns, path]);
    const ordered = [
      ...defaults.filter((d) => keep.has(d)),
      ...builtIns.filter((p) => !defaults.includes(p)),
    ];
    setBuiltIns(ordered);
  };

  const add = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (removed.includes(trimmed)) {
      restore(trimmed);
      setDraft('');
      setError(null);
      return;
    }
    const localErr = preCheckCustomPath(trimmed, [...builtIns, ...customPaths]);
    if (localErr) {
      setError(localErr);
      return;
    }
    try {
      const err = await tauri.validateCustomProtectedPaths([trimmed]);
      if (err) {
        setError(err);
        return;
      }
    } catch (e) {
      setError(getErrorMessage(e));
      return;
    }
    setError(null);
    setDraft('');
    onChange({ customProtectedPaths: [...customPaths, trimmed] });
  };

  const chip =
    'inline-flex items-center gap-1 rounded-lg border py-0.5 pl-2 pr-1 font-mono';
  const size = compact ? 'text-meta py-1' : 'text-meta';
  const xBtn = `text-fg-tertiary hover:text-red-400 active:text-red-400 ${compact ? 'px-2' : 'px-1'}`;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {builtIns.map((p) => {
          const isDefault = defaults.includes(p);
          return (
            <span
              key={`b:${p}`}
              className={`${chip} ${size} ${
                isDefault
                  ? 'border-edge bg-surface-raised text-fg'
                  : 'border-indigo-700/50 bg-indigo-500/10 text-indigo-200'
              }`}
            >
              {p}
              {isDefault && (
                <span className="font-sans text-caption text-fg-tertiary">
                  内置
                </span>
              )}
              <button
                type="button"
                onClick={() => setBuiltIns(builtIns.filter((x) => x !== p))}
                className={xBtn}
                aria-label={`移除 ${p}`}
              >
                ×
              </button>
            </span>
          );
        })}
        {customPaths.map((p) => (
          <span
            key={`c:${p}`}
            className={`${chip} ${size} border-indigo-700/50 bg-indigo-500/10 text-indigo-200`}
          >
            {p}
            <button
              type="button"
              onClick={() =>
                onChange({
                  customProtectedPaths: customPaths.filter((x) => x !== p),
                })
              }
              className={xBtn}
              aria-label={`移除 ${p}`}
            >
              ×
            </button>
          </span>
        ))}
        {removed.map((p) => (
          <span
            key={`r:${p}`}
            className={`${chip} ${size} border-dashed border-edge-strong text-fg-tertiary line-through`}
            title="已移除，点 ↺ 找回"
          >
            {p}
            <button
              type="button"
              onClick={() => restore(p)}
              className={`${compact ? 'px-2' : 'px-1'} text-fg-secondary no-underline hover:text-indigo-300 active:text-indigo-300`}
              aria-label={`找回 ${p}`}
            >
              ↺
            </button>
          </span>
        ))}
        {builtIns.length + customPaths.length + removed.length === 0 && (
          <span className="text-meta italic text-fg-tertiary">
            {rule ? '没有受保护路径' : '正在读取…'}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            if (error) setError(null);
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="/home/user/.ssh"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="添加受保护路径"
          className={`min-w-0 flex-1 rounded-lg border border-edge bg-surface-raised font-mono text-fg outline-none placeholder:text-fg-tertiary focus:border-indigo-500 ${
            compact ? 'px-3 py-3 text-body' : 'px-3 py-2 text-body'
          }`}
        />
        {compact ? (
          <button
            type="button"
            onClick={() => void add()}
            disabled={!draft.trim()}
            className="flex-shrink-0 rounded-lg bg-surface-raised px-4 py-3 text-body text-fg active:bg-state-mid disabled:opacity-40"
          >
            添加
          </button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void add()}
            disabled={!draft.trim()}
          >
            添加
          </Button>
        )}
      </div>
      {error && <p className="text-meta text-red-400">{error}</p>}
    </div>
  );
}
