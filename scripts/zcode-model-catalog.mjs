/** ZCode 模型规则 → Marcel 三个已有表单字段。仅构建时运行。 */

const API_TYPE = 'openai-chat-completions';
const RULE_GROUPS = [
  'modelRules',
  'modelApiRules',
  'providerSiteRules',
  'templateModelRules',
  'builtinProviderModelRules',
];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => { throw new Error(`ZCode 模型配置格式错误：${message}`); };
function object(value, path) {
  if (!isObject(value)) fail(`${path} 必须是对象`);
  return value;
}
function string(value, path) {
  if (typeof value !== 'string') fail(`${path} 必须是字符串`);
  return value;
}
function regex(value, path) {
  string(value, path);
  try { new RegExp(`^(?:${value})$`, 'i'); } catch (error) { fail(`${path} 不是合法正则：${error.message}`); }
  return value;
}

/** 校验我们读取的字段；其他 ZCode 能力保持原样但绝不进入 Marcel 目录。 */
function validateConfig(config, path) {
  object(config, path);
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') fail(`${path}.enabled 必须是布尔值`);
  if (config.properties !== undefined) {
    const p = object(config.properties, `${path}.properties`);
    if (p.contextWindow !== undefined && (!Number.isSafeInteger(p.contextWindow) || p.contextWindow <= 0)) {
      fail(`${path}.properties.contextWindow 必须是正整数`);
    }
    if (p.inputFormat !== undefined) {
      const input = object(p.inputFormat, `${path}.properties.inputFormat`);
      if (input.supportsImage !== undefined && typeof input.supportsImage !== 'boolean') fail(`${path}.supportsImage 必须是布尔值`);
    }
  }
  if (config.optionSpecs !== undefined) {
    const options = object(config.optionSpecs, `${path}.optionSpecs`);
    if (options.reasoningLevel !== undefined) {
      const reasoning = object(options.reasoningLevel, `${path}.optionSpecs.reasoningLevel`);
      if (reasoning.values !== undefined) {
        if (!Array.isArray(reasoning.values)) fail(`${path}.reasoningLevel.values 必须是数组`);
        reasoning.values.forEach((value, index) => {
          if (string(value, `${path}.values[${index}]`).trim() !== value || !value) fail(`${path}.values 不能有空值`);
        });
        if (new Set(reasoning.values).size !== reasoning.values.length) fail(`${path}.values 不能重复`);
      }
      // map 属于请求协议，不在本次三个字段的范围内，但存在时必须仍是字符串。
      if (reasoning.map !== undefined) string(reasoning.map, `${path}.reasoningLevel.map`);
    }
  }
}

export function validateUpstream(doc) {
  object(doc, '根');
  if (doc.schemaVersion !== 1) fail(`暂不支持 schemaVersion ${String(doc.schemaVersion)}`);
  if (!Number.isSafeInteger(doc.revision) || doc.revision < 0) fail('revision 必须是非负整数');
  const config = object(doc.config, 'config');
  const providers = object(config.providerConfigRules, 'providerConfigRules');
  for (const kind of ['templateRules', 'providerRules']) {
    if (!Array.isArray(providers[kind])) fail(`${kind} 必须是数组`);
    providers[kind].forEach((rule, index) => {
      const path = `${kind}[${index}]`;
      object(rule, path);
      string(rule[kind === 'templateRules' ? 'templateId' : 'providerId'], `${path}.id`);
      const api = object(rule.config, `${path}.config`).api;
      if (api !== undefined) {
        object(api, `${path}.config.api`);
        string(api.type, `${path}.api.type`);
        string(api.baseUrl, `${path}.api.baseUrl`);
        try { new URL(api.baseUrl); } catch { fail(`${path}.api.baseUrl 不是合法 URL`); }
      }
      if (rule.config.builtinModelIds !== undefined) {
        if (!Array.isArray(rule.config.builtinModelIds)) fail(`${path}.builtinModelIds 必须是数组`);
        rule.config.builtinModelIds.forEach((id) => string(id, `${path}.builtinModelIds`));
      }
    });
  }
  const rules = object(config.modelConfigRules, 'modelConfigRules');
  for (const kind of RULE_GROUPS) {
    if (!Array.isArray(rules[kind])) fail(`${kind} 必须是数组`);
    rules[kind].forEach((rule, index) => {
      const path = `${kind}[${index}]`;
      object(rule, path);
      if (rule.modelMatch !== undefined) regex(rule.modelMatch, `${path}.modelMatch`);
      if (rule.apiTypeMatch !== undefined) regex(rule.apiTypeMatch, `${path}.apiTypeMatch`);
      if (rule.baseUrlMatch !== undefined) regex(rule.baseUrlMatch, `${path}.baseUrlMatch`);
      if (rule.modelId !== undefined) string(rule.modelId, `${path}.modelId`);
      if (rule.templateId !== undefined) string(rule.templateId, `${path}.templateId`);
      if (rule.providerId !== undefined) string(rule.providerId, `${path}.providerId`);
      validateConfig(rule.config, `${path}.config`);
    });
  }
  return doc;
}

function overlay(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (isObject(value) && isObject(target[key])) overlay(target[key], value);
    else if (value !== undefined) target[key] = value === null ? null : structuredClone(value);
  }
  return target;
}
const fullMatch = (value, pattern, ignoreCase = false) =>
  new RegExp(`^(?:${pattern})$`, ignoreCase ? 'i' : undefined).test(value);
const normalizeBaseUrl = (value) => {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
};

/** 与 ZCode 的五层顺序一致，但只为 OpenAI Chat 端点求值。
 *  `includeGeneral` 决定是否叠加 `.*` 通用兜底——它只用于补齐「已被专用规则
 *  识别到的模型」的缺省字段（上游把 contextWindow 写在通用规则里），绝不
 *  用来识别模型本身。 */
export function resolveUpstream(rules, identity, { includeGeneral = false } = {}) {
  const config = {};
  const add = (rule) => {
    if (rule.modelMatch === '.*' && !includeGeneral) return;
    if (rule.modelMatch && rule.modelMatch !== '.*' && !fullMatch(identity.modelId, rule.modelMatch, true)) return;
    if (rule.apiTypeMatch && !fullMatch(API_TYPE, rule.apiTypeMatch)) return;
    if (rule.baseUrlMatch && (!identity.baseUrl || !fullMatch(normalizeBaseUrl(identity.baseUrl), rule.baseUrlMatch))) return;
    overlay(config, rule.config);
  };
  rules.modelRules.forEach(add);
  rules.modelApiRules.forEach(add);
  rules.providerSiteRules.forEach(add);
  rules.templateModelRules.forEach((rule) => {
    if (rule.templateId === identity.templateId && rule.modelId === identity.modelId) add(rule);
  });
  rules.builtinProviderModelRules.forEach((rule) => {
    if (rule.providerId === identity.providerId && rule.modelId === identity.modelId) add(rule);
  });
  return config;
}

/** 只算 `.*` 通用兜底得到的能力基线（不认任何具体模型）。 */
function generalBaseline(rules) {
  const config = {};
  const add = (rule) => {
    if (rule.modelMatch !== '.*') return;
    if (rule.apiTypeMatch && !fullMatch(API_TYPE, rule.apiTypeMatch)) return;
    if (rule.baseUrlMatch) return;
    overlay(config, rule.config);
  };
  rules.modelRules.forEach(add);
  rules.modelApiRules.forEach(add);
  return config;
}

function recommendation(modelMatch, config) {
  const item = { modelMatch };
  if (config.properties?.contextWindow !== undefined) item.contextWindow = config.properties.contextWindow;
  if (config.properties?.inputFormat?.supportsImage !== undefined) item.vision = config.properties.inputFormat.supportsImage;
  if (config.optionSpecs?.reasoningLevel?.values !== undefined) item.reasoningEfforts = [...config.optionSpecs.reasoningLevel.values];
  return Object.keys(item).length > 1 ? item : null;
}
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 从上游正则里取一个「代表样本」，用于按完整语义求值这条规则。
 * 上游的模式基本都是 `.*xxx.*` 形态，允许这几种安全成分：
 *   - 普通字符（含 `\.` `\-` 等转义）
 *   - 非捕获分组 `(?:a|b|c)` → 取第一支
 *   - 字符类 `[.-]` → 取第一个字符
 * 遇到量词 `* + ? {` 或其它无法安全构造的成分就放弃（宁可不填，不可填错）。
 * 返回 null = 跳过该规则。
 */
export function patternSample(pattern) {
  let inner = pattern.replace(/^\^?\.\*/, '').replace(/\.\*\$?$/, '');
  if (!inner || inner === pattern) return null;
  // 分组 → 第一支；字符类 → 第一个字符。
  inner = inner.replace(/\(\?:([^()]*)\)/g, (_m, body) => body.split('|')[0]);
  inner = inner.replace(/\(([^()]*)\)/g, (_m, body) => body.split('|')[0]);
  inner = inner.replace(/\[([^\]]*)\]/g, (_m, body) => {
    const chars = body.replace(/\\/g, '');
    return chars ? chars[0] : '';
  });
  const sample = inner.replace(/\\(.)/g, '$1');
  // 过滤掉任何仍带正则语义的量词/锚点/分组，避免造出无效样本。
  if (!sample || /[*+?^$|()[\]{}\\]/.test(sample)) return null;
  return fullMatch(sample, pattern, true) ? sample : null;
}

export function buildCatalog(upstream, source = {}) {
  validateUpstream(upstream);
  const { templateRules, providerRules } = upstream.config.providerConfigRules;
  const rules = upstream.config.modelConfigRules;
  // 上游把 contextWindow 这类公共默认写在 `.*` 里；它不认模型，但已被某条
  // 专用规则（或官方模型清单）识别到的模型要以它打底，否则会出现
  // 「有思考档位却没上下文窗口」的半截数据。
  const baseline = generalBaseline(rules);
  const withBaseline = (config) => {
    const merged = {};
    overlay(merged, baseline);
    overlay(merged, config);
    return merged;
  };
  const exact = new Map();
  const addProvider = (provider, kind) => {
    if (provider.config.api?.type !== API_TYPE) return;
    for (const modelId of provider.config.builtinModelIds ?? []) {
      const config = resolveUpstream(rules, {
        modelId,
        baseUrl: provider.config.api.baseUrl,
        templateId: kind === 'templateRules' ? provider.templateId : undefined,
        providerId: kind === 'providerRules' ? provider.providerId : undefined,
      });
      if (config.enabled === false) continue;
      const item = recommendation(escapeRegex(modelId), withBaseline(config));
      if (item) exact.set(modelId.toLowerCase(), item);
    }
  };
  templateRules.forEach((rule) => addProvider(rule, 'templateRules'));
  providerRules.forEach((rule) => addProvider(rule, 'providerRules'));
  const general = [];
  for (const kind of ['modelRules', 'modelApiRules']) {
    for (const rule of rules[kind]) {
      // 通用兜底不代表识别到了模型，不生成条目。
      if (rule.modelMatch === '.*' || (rule.apiTypeMatch && !fullMatch(API_TYPE, rule.apiTypeMatch))) continue;
      // 每条条目必须自洽：把一个「代表该规则的模型名」按 ZCode 的完整语义求值，
      // 而不是只叠加这条规则本身。否则 `.*k3.*` 这类宽泛规则会单独成条、在数组里
      // 排在 `.*kimi-k3.*` 之后把更精确的值盖掉（真踩过）。
      const sample = patternSample(rule.modelMatch);
      if (!sample) continue;
      const config = withBaseline(resolveUpstream(rules, { modelId: sample }));
      const item = recommendation(rule.modelMatch, config);
      if (item) general.push(item);
    }
  }
  const catalog = {
    schemaVersion: 1,
    source: { revision: upstream.revision, ...source },
    // modelRules 与 modelApiRules 常有同一模式、同值的重复；保留先出现的即可。
    recommendations: dedupe([...general, ...exact.values()]),
  };
  validateCatalog(catalog);
  return catalog;
}

/** 同一 modelMatch 只留第一条；值不同则保留两条（顺序语义交给运行时叠加）。 */
function dedupe(items) {
  const seen = new Map();
  for (const item of items) {
    const key = JSON.stringify(item);
    const same = seen.get(item.modelMatch);
    if (!same) seen.set(item.modelMatch, [item]);
    else if (!same.some((x) => JSON.stringify(x) === key)) same.push(item);
  }
  return [...seen.values()].flat();
}

export function validateCatalog(catalog) {
  object(catalog, 'Marcel 目录');
  if (catalog.schemaVersion !== 1) fail('Marcel 目录 schemaVersion 必须为 1');
  if (!Number.isSafeInteger(catalog.source?.revision)) fail('Marcel 目录缺少 revision');
  if (!Array.isArray(catalog.recommendations)) fail('Marcel 目录 recommendations 必须是数组');
  catalog.recommendations.forEach((item, index) => {
    object(item, `recommendations[${index}]`);
    regex(item.modelMatch, `recommendations[${index}].modelMatch`);
    if (Object.keys(item).some((key) => !['modelMatch', 'contextWindow', 'vision', 'reasoningEfforts'].includes(key))) fail('目录含未支持的字段');
    validateConfig({ properties: { contextWindow: item.contextWindow, inputFormat: { supportsImage: item.vision } }, optionSpecs: { reasoningLevel: { values: item.reasoningEfforts } } }, `recommendations[${index}]`);
  });
  return catalog;
}

export const CATALOG_SCHEMA_VERSION = 1;
