import { describe, it, expect } from 'vitest';
import {
  emptySlots,
  emptyRegistry,
  createChannel,
  createModel,
  effectiveDefaultModel,
  effectiveModel,
  currentVision,
  removeModel,
  removeChannel,
  modelReasoningEfforts,
  effortValidForModel,
  dedupeModelEntries,
  mergeChannelModels,
} from './llmRegistry';
import type { LlmRegistry, ModelEntry } from './types';

function regWithTwoModels(): LlmRegistry {
  const r = emptyRegistry();
  const ch = createChannel('DeepSeek', 'https://api.deepseek.com/v1');
  r.channels.push(ch);
  const m1 = createModel(ch.id, 'deepseek-chat');
  const m2 = createModel(ch.id, 'deepseek-reasoner');
  m1.displayName = 'DeepSeek Chat';
  m2.displayName = 'Reasoner';
  r.models.push(m1, m2);
  return r;
}

describe('llmRegistry model routing (session memory → lastUsed → first)', () => {
  it('emptySlots has no defaultModelId (removed mechanism)', () => {
    expect(emptySlots()).toEqual({
      modelApprovalModelId: '',
      summarizerModelId: '',
    });
  });

  it('effectiveDefaultModel falls back to lastUsedModelId then first model', () => {
    const r = regWithTwoModels();
    // 无 lastUsed → 第一个模型
    expect(effectiveDefaultModel(r)?.id).toBe(r.models[0].id);
    // 有 lastUsed → 用它
    r.lastUsedModelId = r.models[1].id;
    expect(effectiveDefaultModel(r)?.id).toBe(r.models[1].id);
    // lastUsed 失效（被删）→ 回落第一个
    r.lastUsedModelId = 'ghost';
    expect(effectiveDefaultModel(r)?.id).toBe(r.models[0].id);
  });

  it('effectiveModel prefers session memory over lastUsed', () => {
    const r = regWithTwoModels();
    r.lastUsedModelId = r.models[0].id;
    expect(effectiveModel(r, r.models[1].id)?.id).toBe(r.models[1].id);
    // 会话记忆失效 → 回落 lastUsed
    expect(effectiveModel(r, 'ghost')?.id).toBe(r.models[0].id);
    // 无会话记忆 → lastUsed
    expect(effectiveModel(r, null)?.id).toBe(r.models[0].id);
  });

  it('currentVision follows the session-effective model', () => {
    const r = regWithTwoModels();
    r.models[0].vision = false;
    r.models[1].vision = true;
    r.lastUsedModelId = r.models[0].id;
    expect(currentVision(r)).toBe(false);
    expect(currentVision(r, r.models[1].id)).toBe(true);
  });

  it('removeModel clears lastUsedModelId and slot references', () => {
    const r = regWithTwoModels();
    r.lastUsedModelId = r.models[0].id;
    r.slots.summarizerModelId = r.models[0].id;
    r.slots.modelApprovalModelId = r.models[1].id;
    const next = removeModel(r, r.models[0].id);
    expect(next.lastUsedModelId).toBe('');
    expect(next.slots.summarizerModelId).toBe('');
    expect(next.slots.modelApprovalModelId).toBe(r.models[1].id);
    expect(next.models).toHaveLength(1);
  });

  it('removeChannel cascades and clears lastUsed + slots', () => {
    const r = regWithTwoModels();
    r.lastUsedModelId = r.models[0].id;
    const chId = r.channels[0].id;
    const next = removeChannel(r, chId);
    expect(next.channels).toHaveLength(0);
    expect(next.models).toHaveLength(0);
    expect(next.lastUsedModelId).toBe('');
    expect(next.slots).toEqual(emptySlots());
  });
});

describe('modelReasoningEfforts / effortValidForModel', () => {
  it('createModel defaults to empty efforts (not enabled)', () => {
    const m = createModel('ch', 'deepseek-reasoner');
    expect(m.reasoningEfforts).toEqual([]);
    expect(modelReasoningEfforts(m)).toEqual([]);
  });

  it('normalizes whitespace and duplicates, keeps first order', () => {
    const m = createModel('ch', 'deepseek-reasoner');
    m.reasoningEfforts = [' low ', 'low', '', 'high', 'max'];
    expect(modelReasoningEfforts(m)).toEqual(['low', 'high', 'max']);
  });

  it('effortValidForModel only accepts declared efforts', () => {
    const m = createModel('ch', 'deepseek-reasoner');
    m.reasoningEfforts = ['low', 'high'];
    expect(effortValidForModel(m, 'high')).toBe(true);
    expect(effortValidForModel(m, 'max')).toBe(false);
    expect(effortValidForModel(m, null)).toBe(false);
    expect(effortValidForModel(m, undefined)).toBe(false);
    expect(effortValidForModel(undefined, 'high')).toBe(false);
  });
});

describe('dedupeModelEntries', () => {
  it('removes same-id duplicates keeping the last occurrence in original order', () => {
    const r = regWithTwoModels();
    const edited = { ...r.models[0], modelName: 'deepseek-chat-edited' };
    const out = dedupeModelEntries([r.models[0], r.models[1], edited]);
    // 保留最后出现者（用户最近的编辑），其余相对顺序不变
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(r.models[1].id);
    expect(out[1].id).toBe(r.models[0].id);
    expect(out[1].modelName).toBe('deepseek-chat-edited');
  });

  it('no duplicates → unchanged (same ids, same order)', () => {
    const r = regWithTwoModels();
    const out = dedupeModelEntries(r.models);
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.id)).toEqual(r.models.map((m) => m.id));
  });

  it('entries without id are kept as-is', () => {
    const r = regWithTwoModels();
    const noId: ModelEntry = { ...r.models[0], id: '' };
    const out = dedupeModelEntries([r.models[0], r.models[0], noId]);
    expect(out).toHaveLength(2); // 同 id 两份保留一份；无 id 的保留
    expect(out.some((m) => m.id === '')).toBe(true);
  });
});

describe('mergeChannelModels (fix: no more same-id duplication on channel save)', () => {
  it('editing an existing channel replaces its models instead of appending duplicates', () => {
    const r = regWithTwoModels();
    const chId = r.channels[0].id;
    // 模拟用户加第三个模型后保存渠道：草稿 = 原有模型 + 新模型
    const draft: ModelEntry[] = [
      ...r.models,
      createModel(chId, 'gemini-3.7-flash'),
    ];
    const next = mergeChannelModels(r, r.channels[0], draft);
    expect(next.models).toHaveLength(3); // 不再翻倍成 5
    // 草稿里的旧模型保持原 id，没有同 id 重复
    const ids = next.models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('deleting a model from draft removes it from the registry', () => {
    const r = regWithTwoModels();
    const ch = r.channels[0];
    const draft = r.models.slice(1); // 删掉第一个模型
    const next = mergeChannelModels(r, ch, draft);
    expect(next.models).toHaveLength(1);
    expect(next.models[0].id).toBe(r.models[1].id);
  });

  it('clears slot/lastUsed references pointing at removed models', () => {
    const r = regWithTwoModels();
    const ch = r.channels[0];
    r.lastUsedModelId = r.models[0].id;
    r.slots.summarizerModelId = r.models[1].id;
    const draft = r.models.slice(0, 1); // 只保留第一个
    const next = mergeChannelModels(r, ch, draft);
    expect(next.lastUsedModelId).toBe(r.models[0].id);
    expect(next.slots.summarizerModelId).toBe(''); // 被删模型引用被清
  });

  it('new channel keeps other channels untouched and sets first-model lastUsed', () => {
    const r = emptyRegistry();
    const ch = createChannel('Google', 'https://generativelanguage.googleapis.com/v1beta/openai');
    const m = createModel(ch.id, 'gemini-3.7-flash');
    const next = mergeChannelModels(r, ch, [m]);
    expect(next.channels).toHaveLength(1);
    expect(next.models).toHaveLength(1);
    expect(next.lastUsedModelId).toBe(m.id);
  });

  it('heals pre-existing same-id duplicates while saving (keep last occurrence)', () => {
    const r = regWithTwoModels();
    const chId = r.channels[0].id;
    // 历史 bug 遗留：store 里已有同 id 重复
    const edited = { ...r.models[0], modelName: 'deepseek-chat-edited' };
    const corrupt: LlmRegistry = {
      ...r,
      models: [...r.models, edited],
    };
    const next = mergeChannelModels(corrupt, corrupt.channels[0], corrupt.models);
    expect(next.models).toHaveLength(2);
    const ids = next.models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
