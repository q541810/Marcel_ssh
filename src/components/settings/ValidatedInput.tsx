import { useState, useEffect } from 'react';
import type { AppSettings } from '@/lib/types';
import { useSettingsActions } from './SettingsActionsContext';

// ─── 类型 ───

type TextProps = {
  type: 'text';
  value: string;
  onChange: (v: string) => void;
};

type NumberProps = {
  type: 'number';
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
};

type CommonProps = {
  validate: (v: string) => string | null;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  suffix?: string;
  /** 非阻塞提示（灰字，无错误时展示；有错误时让位于错误文案）。 */
  hint?: string;
  validatorId?: string;
  validatorFn?: (draft: AppSettings) => string | null;
};

export type ValidatedInputProps = CommonProps & (TextProps | NumberProps);

// ─── 样式 ───

export function getValidatedInputClassName(hasError: boolean): string {
  if (hasError) {
    return 'bg-red-900/20 border border-red-500/50 focus:border-red-400';
  }
  return 'bg-zinc-800 border border-zinc-700';
}

// ─── 组件 ───

export function ValidatedInput(props: ValidatedInputProps) {
  const { validate, onBlur: onBlurProp, placeholder, className, suffix, hint,
    validatorId, validatorFn, type } = props;

  const { registerValidator, clearValidationErrors } = useSettingsActions();
  const [error, setError] = useState<string | null>(null);

  // 注册保存时校验（有 validatorId 时）
  useEffect(() => {
    if (!validatorId || !validatorFn) return;
    return registerValidator(validatorId, validatorFn);
  }, [validatorId, validatorFn, registerValidator]);

  // onChange
  const handleChange = (raw: string) => {
    if (type === 'number') {
      // 不做 Math.round — 是否取整由 validate 函数决定（如 maxToolRounds 的
      // Number.isInteger 校验）。这里只负责把字符串转成数字传出去。
      const v = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(v)) return; // type=number 浏览器已拦截非数字,兜底
      (props as NumberProps).onChange(v);
      setError(null);
      if (validate(String(v)) === null) {
        clearValidationErrors();
      }
    } else {
      (props as TextProps).onChange(raw);
      setError(null);
      if (validate(raw) === null) {
        clearValidationErrors();
      }
    }
  };

  // onBlur
  const handleBlur = () => {
    const s = type === 'number' ? String((props as NumberProps).value) : (props as TextProps).value;
    setError(validate(s));
    onBlurProp?.();
  };

  const displayValue = type === 'number' ? String((props as NumberProps).value) : (props as TextProps).value;
  const hasError = !!error;

  return (
    <div className="flex-1 space-y-1">
      <div className="flex items-center gap-2">
        <input
          type={type}
          value={displayValue}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={handleBlur}
          placeholder={placeholder}
          className={`rounded-lg px-3 py-1.5 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500 ${getValidatedInputClassName(hasError)} ${className ?? ''}`}
          {...(type === 'number' ? { min: (props as NumberProps).min, max: (props as NumberProps).max, step: (props as NumberProps).step } : {})}
        />
        {suffix && <span className="text-xs text-zinc-500">{suffix}</span>}
      </div>
      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
      {!error && hint && (
        <p className="text-xs text-zinc-500">{hint}</p>
      )}
    </div>
  );
}
