import type { ModelEntry } from '@/lib/types';
import rawCatalog from '@/assets/modelCatalog.json';

/** 构建时从 ZCode 模型规则生成；客户端只读，不联网更新。 */
export interface ModelRecommendation {
  modelMatch: string;
  contextWindow?: number;
  vision?: boolean;
  reasoningEfforts?: string[];
}

interface ModelCatalog {
  schemaVersion: 1;
  source: { revision: number };
  recommendations: ModelRecommendation[];
}

export const MODEL_CATALOG = rawCatalog as ModelCatalog;

export function recommendModel(modelName: string): ModelRecommendation | null {
  const id = modelName.trim();
  if (!id) return null;
  const result: Omit<ModelRecommendation, 'modelMatch'> = {};
  let matched = false;
  for (const item of MODEL_CATALOG.recommendations) {
    if (!new RegExp(`^(?:${item.modelMatch})$`, 'i').test(id)) continue;
    matched = true;
    // 与上游一致：同层按顺序叠加，不是命中第一条就停。
    if (item.contextWindow !== undefined) result.contextWindow = item.contextWindow;
    if (item.vision !== undefined) result.vision = item.vision;
    if (item.reasoningEfforts !== undefined) result.reasoningEfforts = [...item.reasoningEfforts];
  }
  return matched ? { modelMatch: id, ...result } : null;
}

/** 用户亲手改过的字段拥有最终解释权；自动填写本身不标记为已修改。 */
export type ModelFieldEdits = Partial<
  Record<'vision' | 'contextWindow' | 'reasoningEfforts', boolean>
>;

export interface ModelRecommendationDraft {
  vision: boolean;
  contextWindow: number;
  reasoningEfforts: string[];
}

/** 表单里能被推荐表填出「看得见内容」的字段。 */
export type RecommendedField = 'contextWindow' | 'vision' | 'reasoningEfforts';

/** 提示文案用的字段名（顺序即展示顺序）。 */
export const RECOMMENDED_FIELD_LABELS: Record<RecommendedField, string> = {
  contextWindow: '上下文窗口',
  vision: '视觉',
  reasoningEfforts: '思考档位',
};

/**
 * 只填用户尚未接管、且仍显示上一次推荐值的字段。
 * 因此 A→B 能更新推荐，A→unknown 会清掉旧推荐，用户主动关/清空不会被复活。
 *
 * `filled` 只列**真正填出了可见内容**的字段：命中的规则若只写了
 * `vision:false`（既不支持图片、也没有窗口和档位），界面上一格都不会变，
 * 这时不能再对用户说「已自动填充」。
 */
export function applyModelRecommendation(
  current: ModelRecommendationDraft,
  edits: ModelFieldEdits,
  previousModelName: string,
  nextModelName: string,
): {
  recommendation: ModelRecommendation | null;
  draft: ModelRecommendationDraft;
  filled: RecommendedField[];
} {
  const previous = recommendModel(previousModelName);
  const next = recommendModel(nextModelName);
  const draft = { ...current, reasoningEfforts: [...current.reasoningEfforts] };
  const filled: RecommendedField[] = [];
  if (!edits.vision && current.vision === (previous?.vision ?? false)) {
    draft.vision = next?.vision ?? false;
    // 关着视觉是默认值，填了也看不出来，不算「已填充」。
    if (next?.vision === true) filled.push('vision');
  }
  if (!edits.contextWindow && current.contextWindow === (previous?.contextWindow ?? 0)) {
    draft.contextWindow = next?.contextWindow ?? 0;
    if ((next?.contextWindow ?? 0) > 0) filled.push('contextWindow');
  }
  const sameEfforts =
    current.reasoningEfforts.join('\n') === (previous?.reasoningEfforts ?? []).join('\n');
  if (!edits.reasoningEfforts && sameEfforts) {
    draft.reasoningEfforts = [...(next?.reasoningEfforts ?? [])];
    if ((next?.reasoningEfforts?.length ?? 0) > 0) filled.push('reasoningEfforts');
  }
  return { recommendation: next, draft, filled };
}

export function recommendedModelFields(modelName: string): Pick<
  ModelEntry,
  'vision' | 'contextWindow' | 'reasoningEfforts'
> {
  const rec = recommendModel(modelName);
  return {
    vision: rec?.vision ?? false,
    contextWindow: rec?.contextWindow ?? 0,
    reasoningEfforts: rec?.reasoningEfforts ?? [],
  };
}
