import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG, applyModelRecommendation, recommendModel } from './modelCatalog';

const empty = { vision: false, contextWindow: 0, reasoningEfforts: [] };

describe('随包模型目录', () => {
  it('按上游完整正则匹配并填三个已有字段', () => {
    expect(recommendModel('moonshot/kimi-k3-2026')).toMatchObject({
      contextWindow: 1048576,
      vision: true,
      reasoningEfforts: ['low', 'high', 'max'],
    });
    // 精确规则（.*kimi-k3.*）不能被更宽泛的规则（.*k3.*）覆盖。
    expect(recommendModel('kimi-k3')).toMatchObject({
      contextWindow: 1048576,
      vision: true,
      reasoningEfforts: ['low', 'high', 'max'],
    });
  });

  it('未知模型保持当前空配置', () => {
    expect(recommendModel('someone/unknown-model')).toBeNull();
  });

  it('模型名改变时替换旧推荐', () => {
    const first = applyModelRecommendation(empty, {}, '', 'kimi-k3');
    const second = applyModelRecommendation(first.draft, {}, 'kimi-k3', 'moonshot-v1-8k');
    // 8k 系列窗口 8192；档位从基线的 disabled/enabled 继承，视觉不支持。
    expect(second.draft.contextWindow).toBe(8192);
    expect(second.draft.vision).toBe(false);
    const unknown = applyModelRecommendation(second.draft, {}, 'moonshot-v1-8k', 'unknown');
    expect(unknown.draft).toEqual(empty);
  });

  it('用户主动关闭、置零或清空的字段不会被下一条推荐覆盖', () => {
    const current = { vision: true, contextWindow: 200000, reasoningEfforts: ['high'] };
    const result = applyModelRecommendation(current, {
      vision: true,
      contextWindow: true,
      reasoningEfforts: true,
    }, 'kimi-k3', 'gpt-5.4');
    expect(result.draft).toEqual(current);
  });

  it('同层规则按顺序叠加', () => {
    const item = recommendModel('GLM-5.3-Flash');
    expect(item?.contextWindow).toBe(1000000);
    expect(item?.reasoningEfforts).toEqual(['low', 'high', 'max']);
  });

  it('被识别到的模型必须同时拿到上下文窗口（上游把窗口写在通用兜底里）', () => {
    // 上游有 20+ 条模型规则只写视觉/档位、窗口依赖 `.*` 基线；缺一个都算半截数据。
    const missing = MODEL_CATALOG.recommendations.filter((r) => r.contextWindow === undefined);
    expect(missing).toEqual([]);
    for (const name of ['deepseek-v4-pro', 'claude-opus-5', 'qwen-plus', 'minimax-m3']) {
      expect(recommendModel(name)?.contextWindow).toBeGreaterThan(0);
    }
  });

  it('通用兜底本身不识别模型', () => {
    // 基线的窗口是 1000000，但没命中任何专用规则的模型必须返回 null。
    expect(recommendModel('some-random-local-model')).toBeNull();
    expect(MODEL_CATALOG.recommendations.some((r) => r.modelMatch === '.*')).toBe(false);
  });
});
