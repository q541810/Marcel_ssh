import type { Disposition } from '@/lib/types';
import {
  LEVEL_HINT,
  RULE_LEVEL_DOT,
  RULE_LEVEL_LABELS,
  RULE_LEVEL_TONE,
} from '@/lib/riskRules';
import Select from '@/components/ui/Select';
import MobileSelect from '@/mobile/ui/MobileSelect';

/**
 * 档位下拉。桌面用共享的 `ui/Select`，手机用共享的底部面板 `MobileSelect`（不用原生 select，原因见它的注释）。
 *
 * 两端的选项内容一致：每个选项带一行"选了会怎样"，已是默认的那个再标一句「默认」，
 * 不用翻文档就知道四档差别、也知道自己动没动过。
 */
export function LevelSelect({
  value,
  options,
  onChange,
  ariaLabel,
  compact,
  defaultLevel,
}: {
  value: Disposition;
  options: Disposition[];
  onChange: (v: Disposition) => void;
  /** 这个下拉管哪条规则（读屏用，例如「按名字批量杀进程：处置档位」）。 */
  ariaLabel: string;
  /** 手机。 */
  compact?: boolean;
  /** 这一项的默认档位（有就在对应选项上标「默认」）。 */
  defaultLevel?: Disposition;
}) {
  if (compact) {
    return (
      <MobileSelect<Disposition>
        value={value}
        onChange={onChange}
        ariaLabel={ariaLabel}
        title="选择处置档位"
        className={`flex-shrink-0 rounded-lg border bg-field px-3 text-body ${RULE_LEVEL_TONE[value]}`}
        options={options.map((l) => ({
          value: l,
          label: RULE_LEVEL_LABELS[l],
          hint: LEVEL_HINT[l],
          badge: l === defaultLevel ? '默认' : undefined,
          leading: (
            <span
              className={`mt-2 h-2 w-2 flex-shrink-0 rounded-full ${RULE_LEVEL_DOT[l]}`}
            />
          ),
        }))}
      />
    );
  }
  return (
    <Select<Disposition>
      className="w-32 flex-shrink-0"
      menuClassName="w-60"
      menuAlign="end"
      ariaLabel={`${ariaLabel}（当前${RULE_LEVEL_LABELS[value]}）`}
      value={value}
      onChange={onChange}
      options={options.map((l) => ({
        value: l,
        label: (
          <span className="inline-flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${RULE_LEVEL_DOT[l]}`}
            />
            {RULE_LEVEL_LABELS[l]}
          </span>
        ),
        hint: l === defaultLevel ? `${LEVEL_HINT[l]} · 默认` : LEVEL_HINT[l],
      }))}
    />
  );
}
