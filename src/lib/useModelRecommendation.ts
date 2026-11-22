import { useEffect, useRef } from 'react';
import {
  applyModelRecommendation,
  type ModelFieldEdits,
  type ModelRecommendationDraft,
  type RecommendedField,
} from './modelCatalog';

export const MODEL_RECOMMENDATION_IDLE_MS = 1_200;

/** 一次匹配的结果：草稿 + 真正填出可见内容的字段。 */
export interface ModelRecommendationOutcome {
  draft: ModelRecommendationDraft;
  filled: RecommendedField[];
}

/** 新增模型的共享草稿协调器；只处理三个推荐字段，不管理保存。 */
export function useModelRecommendation({
  open,
  enabled,
  immediate = false,
  modelName,
  current,
  onApply,
}: {
  open: boolean;
  enabled: boolean;
  immediate?: boolean;
  modelName: string;
  current: ModelRecommendationDraft;
  onApply: (outcome: ModelRecommendationOutcome) => void;
}) {
  const latest = useRef({ modelName, current, onApply });
  latest.current = { modelName, current, onApply };
  const previousName = useRef('');
  const edits = useRef<ModelFieldEdits>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      previousName.current = '';
      edits.current = {};
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !enabled || previousName.current === modelName) return;
    const apply = () => {
      const state = latest.current;
      if (previousName.current === state.modelName) return;
      const result = applyModelRecommendation(
        state.current,
        edits.current,
        previousName.current,
        state.modelName,
      );
      previousName.current = state.modelName;
      latest.current.current = result.draft;
      state.onApply({ draft: result.draft, filled: result.filled });
    };
    // 列表选择已带完整模型名，立即填；手动输入停顿后再查。
    if (immediate && !previousName.current && modelName.trim()) apply();
    else timer.current = setTimeout(apply, MODEL_RECOMMENDATION_IDLE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [open, enabled, immediate, modelName]);

  const flush = (): ModelRecommendationDraft => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const state = latest.current;
    if (!open || !enabled || previousName.current === state.modelName) return state.current;
    const result = applyModelRecommendation(
      state.current,
      edits.current,
      previousName.current,
      state.modelName,
    );
    previousName.current = state.modelName;
    latest.current.current = result.draft;
    state.onApply({ draft: result.draft, filled: result.filled });
    return result.draft;
  };

  return {
    flush,
    markEdited: (field: keyof ModelFieldEdits) => {
      edits.current[field] = true;
    },
  };
}
