export interface MobileChoiceOption<T extends string> {
  value: T;
  label: string;
  desc?: string;
}

interface MobileChoiceGroupProps<T extends string> {
  options: readonly MobileChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 每行列数：`2` 适合短标签（两项一组），带说明的多选项用 `1` 竖排更好读。 */
  columns?: 1 | 2;
  /** 无障碍组名（读屏会播报「XX 单选组」）。 */
  ariaLabel?: string;
}

/**
 * 移动端互斥单选组（触屏优先）：整块可点、按下即缩放反馈、选中态用 indigo
 * 边框 + 底色表达，不依赖 hover。原为「搜索方式」里的一段局部实现，抽出成
 * 公共控件供更新方式等多选一设置复用（同一套语义只有一处实现）。
 *
 * 语义用 radiogroup/radio：读屏播报「已选中/未选中」，而不是「按钮」。
 */
export function MobileChoiceGroup<T extends string>({
  options,
  value,
  onChange,
  columns = 2,
  ariaLabel,
}: MobileChoiceGroupProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`mt-2 grid gap-2 ${columns === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}
    >
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors duration-100 active:scale-[0.99] ${
              active ? 'border-indigo-500 bg-indigo-500/10' : 'border-zinc-700 bg-zinc-800/60'
            }`}
          >
            <div
              className={`text-sm font-medium ${active ? 'text-indigo-200' : 'text-zinc-300'}`}
            >
              {o.label}
            </div>
            {o.desc && (
              <div className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{o.desc}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}
