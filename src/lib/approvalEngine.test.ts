import { describe, it, expect } from 'vitest';
import type { CommandApprovalEngine, ModelApprovalDonePayload } from './types';

/**
 * 后端源码 + TS 类型源码的原文。用 vite 的 raw glob 读进来做文本比对（本仓库没装
 * @types/node，测试里不引 node API —— 与 `disposition.test.ts` / `toolCatalog.test.ts`
 * 同一手法）。
 *
 * 这组测试钉的是「TS 类型声明 ↔ 后端线上表示」这条跨语言契约，护栏必须**两侧都钉**：
 *
 * - Rust 侧管线上键名与枚举变体（谁被序列化出去）。字段漏发、键名写成 snake_case、
 *   变体改名，都不会让任何一边编译报错，只会让前端读到 `undefined`、或让引擎选择
 *   与审批标注静默失效。
 * - TS 侧管字段名、字段可选性与取值集合（谁被声明、谁可选）。这些在 TS 里只是一份
 *   声明文本，平时靠 `tsc` 兜底；可 `tsc` 没跑（或类型本身编译不过）时约束就等于零
 *   —— 本文件就这样空转过一段时间。所以运行期还要把 TS 源码当**文本**解析出来，
 *   与 Rust 侧解析出的集合逐字比对，两侧都不能只靠编译器。
 */
const RAW = import.meta.glob(
  [
    '/src-tauri/src/config/settings.rs',
    '/src-tauri/src/agent/tool_dispatcher.rs',
    '/src-tauri/src/agent/jev_approval.rs',
    '/src-tauri/src/llm/jev.rs',
    '/src/lib/types.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const settingsRs = RAW['/src-tauri/src/config/settings.rs'] ?? '';
const dispatcherRs = RAW['/src-tauri/src/agent/tool_dispatcher.rs'] ?? '';
const jevApprovalRs = RAW['/src-tauri/src/agent/jev_approval.rs'] ?? '';
const jevRs = RAW['/src-tauri/src/llm/jev.rs'] ?? '';
const typesTs = RAW['/src/lib/types.ts'] ?? '';

/**
 * 取声明**自己**上方那一段连续的属性 / 注释行（`#[...]`、`///`）。
 *
 * 不能按「往前 N 个字符」截窗口：邻居条目的属性会滑进来，目标属性删掉后断言仍会
 * 借邻居的文本假通过。`settings.rs` 里相邻的两个枚举就带逐字相同的容器属性
 * （`#[serde(rename_all = "lowercase")]`），实测相隔不到 1KB（942 字符）——上方代码
 * 只要压缩 442 字符，邻居就落进 500 字符的窗口。按行向上走、遇空行或代码行即停，
 * 窗口长度只由声明自身决定，跟上方代码怎么改无关。
 */
function itemHeader(src: string, declStart: number): string {
  const lines = src.slice(0, declStart).split('\n');
  // 声明从行首开始时，split 的最后一个元素是空串（声明那行的前导部分），先去掉。
  if (lines[lines.length - 1].trim() === '') lines.pop();
  const attrs: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith('#[') || t.startsWith('//')) {
      attrs.unshift(t);
      continue;
    }
    break; // 空行 / 代码行 = 条目边界，再往上就不是这个声明的属性了
  }
  return attrs.join('\n');
}

/** 取 `pub enum X { ... }` 的变体名，以及紧贴该声明的属性区（含容器级 serde 属性）。 */
function parseEnum(src: string, name: string) {
  const start = src.indexOf(`pub enum ${name} {`);
  expect(start, `找不到 \`pub enum ${name}\``).toBeGreaterThan(-1);
  const header = itemHeader(src, start);
  expect(header, `\`pub enum ${name}\` 上方没读到属性行`).toContain('#[');
  const body = src.slice(start, src.indexOf('\n}', start));
  const variants = [...body.matchAll(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/gm)].map(
    (m) => m[1],
  );
  expect(variants.length, `\`pub enum ${name}\` 没解析出变体`).toBeGreaterThan(
    0,
  );
  return { header, variants };
}

/** 取 `struct X { ... }`（或 `pub(crate) struct`）的字段名。 */
function parseStructFields(src: string, name: string): string[] {
  const start = src.search(new RegExp(`(pub\\(crate\\) )?struct ${name} \\{`));
  expect(start, `找不到 \`struct ${name}\``).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n}', start));
  const fields = [...body.matchAll(/^\s+(?:pub )?([a-z_][a-z0-9_]*):/gm)].map(
    (m) => m[1],
  );
  expect(fields.length, `\`struct ${name}\` 没解析出字段`).toBeGreaterThan(0);
  return fields;
}

/**
 * 取某个字段**自己**上方那一段连续的 `#[...]` 属性行。
 *
 * 必须按行向上走到属性块边界，不能只按「往前 N 个字符」截：相邻字段的属性会落进
 * 那个窗口，断言于是借到邻居的属性而假通过。这个坑踩过一次——把 `confidence` 的
 * `skip_serializing_if` 删掉后测试仍然全绿，因为窗口里包住了上面 `engine` 的属性。
 */
function fieldAttributes(
  src: string,
  structName: string,
  field: string,
): string {
  const start = src.search(
    new RegExp(`(pub\\(crate\\) )?struct ${structName} \\{`),
  );
  expect(start, `找不到 \`struct ${structName}\``).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n}', start));
  const lines = body.split('\n');
  const idx = lines.findIndex((l) =>
    new RegExp(`^\\s+(?:pub )?${field}:`).test(l),
  );
  expect(idx, `${structName} 里找不到字段 ${field}`).toBeGreaterThan(-1);
  const attrs: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith('#[')) {
      attrs.unshift(t);
      continue;
    }
    if (t === '') continue; // 属性与字段之间的空行
    break; // 上一字段或文档注释：属性块到此为止
  }
  return attrs.join('\n');
}

/**
 * 把 Rust 结构体字段名折算成**线上键名**：逐字段 `#[serde(rename = "...")]` 优先，
 * 其余按容器 `rename_all = "camelCase"` 折算（本组结构体都是 camelCase）。
 */
function wireKeys(
  src: string,
  structName: string,
): { field: string; key: string }[] {
  return parseStructFields(src, structName).map((field) => {
    const renamed = fieldAttributes(src, structName, field).match(
      /rename = "([^"]+)"/,
    );
    const key = renamed
      ? renamed[1]
      : field.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
    return { field, key };
  });
}

/** 取 `export interface X { ... }` 的声明体。 */
function tsInterfaceBody(src: string, name: string): string {
  const start = src.indexOf(`export interface ${name} {`);
  expect(start, `找不到 \`export interface ${name}\``).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  expect(
    end,
    `\`export interface ${name}\` 没找到闭合的 \`}\``,
  ).toBeGreaterThan(-1);
  return src.slice(start, end);
}

/** 取 TS 接口里某个字段的单行声明原文（多行声明会明确报错，不静默截半句）。 */
function tsFieldDecl(src: string, iface: string, field: string): string {
  const body = tsInterfaceBody(src, iface);
  const idx = body.search(new RegExp(`^\\s{2}${field}\\??\\s*:`, 'm'));
  expect(idx, `${iface} 里找不到字段 ${field}`).toBeGreaterThan(-1);
  const end = body.indexOf(';', idx);
  expect(end, `${iface}.${field} 没有以分号结尾`).toBeGreaterThan(-1);
  const decl = body.slice(idx, end + 1);
  expect(
    decl,
    `${iface}.${field} 是多行声明，本文件的解析只认单行`,
  ).not.toContain('\n');
  return decl;
}

/** 取 TS 接口里某字段的内联字面量取值集合（`decision: 'a' | 'b';`）。 */
function parseTsFieldUnion(
  src: string,
  iface: string,
  field: string,
): string[] {
  const values = [...tsFieldDecl(src, iface, field).matchAll(/'([^']+)'/g)].map(
    (m) => m[1],
  );
  expect(values.length, `${iface}.${field} 没解析出字面量`).toBeGreaterThan(0);
  return values;
}

/** 取 `export type X = 'a' | 'b';` 的字面量取值集合（单行声明）。 */
function parseTsUnion(src: string, name: string): string[] {
  const start = src.indexOf(`export type ${name} =`);
  expect(start, `找不到 \`export type ${name}\``).toBeGreaterThan(-1);
  const end = src.indexOf(';', start);
  expect(end, `\`export type ${name}\` 没有以分号结尾`).toBeGreaterThan(-1);
  const decl = src.slice(start, end + 1);
  expect(
    decl,
    `\`export type ${name}\` 是多行声明，本文件的解析只认单行`,
  ).not.toContain('\n');
  const values = [...decl.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  expect(
    values.length,
    `\`export type ${name}\` 没解析出字面量`,
  ).toBeGreaterThan(0);
  return values;
}

/** 取 TS 接口的字段名与可选性（`engine?: X` 的那个 `?`）。 */
function parseTsInterfaceFields(
  src: string,
  name: string,
): { name: string; optional: boolean }[] {
  const body = tsInterfaceBody(src, name);
  const fields = [
    ...body.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)(\?)?:/gm),
  ].map((m) => ({
    name: m[1],
    optional: m[2] === '?',
  }));
  expect(
    fields.length,
    `\`export interface ${name}\` 没解析出字段`,
  ).toBeGreaterThan(0);
  return fields;
}

describe('命令审批引擎的跨语言契约', () => {
  it('五个源文件都能读到（防止 glob 路径写错后整组测试变成空转）', () => {
    expect(settingsRs.length).toBeGreaterThan(0);
    expect(dispatcherRs.length).toBeGreaterThan(0);
    expect(jevApprovalRs.length).toBeGreaterThan(0);
    expect(jevRs.length).toBeGreaterThan(0);
    expect(typesTs.length).toBeGreaterThan(0);
  });

  const engine = parseEnum(settingsRs, 'CommandApprovalEngine');
  const tsEngines = parseTsUnion(typesTs, 'CommandApprovalEngine');

  it('属性区是有界的：只覆盖声明自己的属性/注释行，跨不到邻居条目上', () => {
    const start = settingsRs.indexOf('pub enum CommandApprovalEngine {');
    const lines = settingsRs.slice(0, start).split('\n');
    if (lines[lines.length - 1].trim() === '') lines.pop(); // 与 itemHeader 同款处理
    const headerLines = itemHeader(settingsRs, start).split('\n');
    // 紧贴：属性区就该是声明正上方那几行，中间不许夹别的行。
    expect(lines.slice(-headerLines.length).map((l) => l.trim())).toEqual(
      headerLines,
    );
    // 有界：再往上一行必须是空行（条目边界）。旧实现按「往前 500 字符」截窗口，
    // 邻居条目的属性会滑进来，于是删掉目标属性后断言仍能借到邻居那条逐字相同的
    // `rename_all` 而假通过——这里把「不许跨条目」钉死。
    expect(
      lines[lines.length - headerLines.length - 1]?.trim(),
      '属性区越过了条目边界（把上方邻居条目的属性也读进来了）',
    ).toBe('');
  });

  it('Rust 变体按容器属性映射出的线上取值，与 TS union 逐个相同', () => {
    // 映射规则先钉死：serde 的 `rename_all = "lowercase"` 就是把变体名整个转小写。
    // 属性区必须是**这一个**枚举自己的——混进别的声明就说明窗口又借到邻居了。
    expect(
      engine.header,
      'CommandApprovalEngine 的容器级 serde 属性',
    ).toContain('#[serde(rename_all = "lowercase")]');
    expect(engine.header, '属性区里混进了别的条目，窗口借到邻居了').not.toMatch(
      /pub (enum|struct|impl|fn)\b/,
    );
    const wire = engine.variants.map((v) => v.toLowerCase());
    expect(wire, 'Rust 发出去的取值必须是 TS 认识的那几个').toEqual(tsEngines);
  });

  it('线上取值是持久化契约：settings.json 里已经写下的就是这两个字符串', () => {
    // 不只是内部细节：老配置里已经写下的 `"model"`、以及缺键时的默认值，都得继续认得；
    // 改名会让反序列化失败或悄悄落回默认，所以字面钉住，不许跟着 TS 一起改。
    expect(engine.variants.map((v) => v.toLowerCase())).toEqual([
      'model',
      'jev',
    ]);
  });

  it('缺省必须落回 Model（旧 settings.json 行为不变）', () => {
    const start = settingsRs.indexOf(
      'impl Default for CommandApprovalEngine {',
    );
    expect(
      start,
      '找不到 CommandApprovalEngine 的 Default 实现',
    ).toBeGreaterThan(-1);
    const body = settingsRs.slice(start, settingsRs.indexOf('\n}', start));
    expect(body).toContain('Self::Model');
  });

  it('设置字段带 serde(default)，且默认值为空串/不预设 Jev 型号', () => {
    for (const field of [
      'command_approval_engine',
      'jev_model_id',
      'jev_base_url',
      'jev_approval_prompt',
    ]) {
      expect(settingsRs, `AgentModeSettings 缺字段 ${field}`).toMatch(
        new RegExp(`pub ${field}:`),
      );
      // 字段**自己**的属性块必须含 serde(default)：旧配置缺这个键时才能落回默认值。
      expect(
        fieldAttributes(settingsRs, 'AgentModeSettings', field),
        `${field} 缺 #[serde(default)]`,
      ).toContain('serde(default)');
    }
    // Default 实现里不得替用户凭空填一个 Jev 型号、根地址或判据。
    const def = settingsRs.indexOf('impl Default for AgentModeSettings {');
    const defBody = settingsRs.slice(def, settingsRs.indexOf('\n}', def));
    expect(defBody).toContain(
      'command_approval_engine: CommandApprovalEngine::default()',
    );
    expect(defBody).toContain('jev_model_id: String::new()');
    expect(defBody).toContain('jev_base_url: String::new()');
    expect(defBody).toContain('jev_approval_prompt: String::new()');
  });

  it('TS 的 AgentModeSettings 字段名，Rust 侧必须都认识', () => {
    // 反过来的方向不硬性要求：Rust 有而 TS 没建模的旧字段（如 modelApprovalModel，
    // 现在走 llmRegistry 槽位）是允许的。但 TS 凭空多一个键名 = 保存时被 serde
    // 静默忽略，用户在设置页里改了半天、settings.json 里什么都没有。
    const rustKeys = wireKeys(settingsRs, 'AgentModeSettings').map(
      (f) => f.key,
    );
    const tsFields = parseTsInterfaceFields(typesTs, 'AgentModeSettings').map(
      (f) => f.name,
    );
    expect(rustKeys.length, 'AgentModeSettings 没解析出字段').toBeGreaterThan(
      0,
    );
    expect(
      tsFields.filter((f) => !rustKeys.includes(f)),
      '这些键名 Rust 的 AgentModeSettings 不认识，前端保存等于写进黑洞',
    ).toEqual([]);
  });
});

describe('模型审批完成事件的跨语言契约', () => {
  const rustFields = wireKeys(dispatcherRs, 'ModelApprovalDoneEvent');
  const tsFields = parseTsInterfaceFields(typesTs, 'ModelApprovalDonePayload');

  it('TS payload 声明的每个字段，Rust 事件都得真发得出来', () => {
    // 方向必须看准：TS 的 `ModelApprovalDonePayload` 只是一份**结构声明**，它管不住
    // Rust 序列化出什么。Rust 漏写一个字段，前端只会永远读到 `undefined`（该字段的 UI
    // 静默失效），两侧都不会编译报错——只能在源码文本上逐个字段比对。
    // 键名按 serde 折算：`tool_call_id` 走容器 camelCase → `toolCallId`；
    // `event_type` 还带 `#[serde(rename = "type")]` → `type`。
    const rustKeys = rustFields.map((f) => f.key);
    expect(
      rustKeys.length,
      'ModelApprovalDoneEvent 没解析出字段',
    ).toBeGreaterThan(0);
    expect(
      tsFields.map((f) => f.name).filter((n) => !rustKeys.includes(n)),
      'TS 声明了这些字段但 Rust 不发，前端只会读到 undefined',
    ).toEqual([]);
  });

  it('TS 标可选 ⇔ Rust 用 Option + skip_serializing_if 真的可能不发', () => {
    // 两侧必须成对：TS 写成必填而 Rust 会漏发，前端就把 `undefined` 当成有效值；
    // TS 写成可选而 Rust 恒定发送，说明有人只改了单边（多出来的兜底分支是假警报）。
    for (const f of tsFields) {
      const rust = rustFields.find((r) => r.key === f.name);
      if (!rust) throw new Error(`事件结构体里找不到字段 ${f.name}`);
      const attrs = fieldAttributes(
        dispatcherRs,
        'ModelApprovalDoneEvent',
        rust.field,
      );
      if (f.optional) {
        expect(
          attrs,
          `${f.name} 在 TS 是可选的，Rust 侧也必须真有可能不发`,
        ).toContain('skip_serializing_if');
        expect(dispatcherRs, `事件字段 ${f.name} 应为 Option`).toMatch(
          new RegExp(`\\b${rust.field}: Option<`),
        );
      } else {
        expect(
          attrs,
          `${f.name} 在 TS 是必填的，Rust 侧不许 skip_serializing_if`,
        ).not.toContain('skip_serializing_if');
      }
    }
  });

  it('TS 的 decision 取值集合 = Rust 实际发出的字符串（含失败时的 error）', () => {
    const tsDecisions = parseTsFieldUnion(
      typesTs,
      'ModelApprovalDonePayload',
      'decision',
    );
    const emitted = new Set(
      [...dispatcherRs.matchAll(/decision: "([^"]+)"\.to_string\(\)/g)].map(
        (m) => m[1],
      ),
    );
    expect(
      emitted.size,
      'dispatcher 里没解析出 decision 字面量',
    ).toBeGreaterThan(0);
    // 多一个少一个都说明有人只改了一边：后端发了个前端不认识的取值（会走到
    // 兜底分支、把内部字符串露给用户），或前端声明了后端永远不发的那一档。
    expect([...tsDecisions].sort()).toEqual([...emitted].sort());
  });

  it('payload.engine 仍收窄在 CommandApprovalEngine 上（编译期 + 运行期两侧）', () => {
    // 编译期：'jev' 既能进 `CommandApprovalEngine`，也能进 payload 的 engine 字段。
    // union 里去掉 'jev'、或字段换个名字时，这里过不了 `tsc`。
    const sample: CommandApprovalEngine = 'jev';
    const asPayloadField: ModelApprovalDonePayload['engine'] = sample;
    // 运行期：同一个字面量必须出现在类型源码的 union 里。另外 engine 字段的声明类型
    // 必须写着那个 union 的名字——写成 `string` 的话 UI 里的穷尽分支就保不住了，
    // 而这件事编译期看不出来（`string` 也收得住 'jev'）。
    expect(parseTsUnion(typesTs, 'CommandApprovalEngine')).toContain(
      asPayloadField,
    );
    expect(
      tsFieldDecl(typesTs, 'ModelApprovalDonePayload', 'engine'),
      'engine 的类型得写着 CommandApprovalEngine，不能放宽成 string',
    ).toContain('CommandApprovalEngine');
  });
});

describe('Jev 判定选项与前端决策取值的对齐', () => {
  it('三档 criteria key 的取值都落在 TS 认识的 decision 里，且不含 error', () => {
    // 这些 key 既发给 Jev（作为 criteria 的键），也是映射回
    // `ModelApprovalDecision` 的锚点，所以必须逐字落在前端那套取值里——
    // 前端只把这几个字符串译成中文与图标，多一个就会在审批卡片上露出内部字符串。
    const tsDecisions = parseTsFieldUnion(
      typesTs,
      'ModelApprovalDonePayload',
      'decision',
    );
    for (const [constName, value] of [
      ['OPT_APPROVE', 'approve'],
      ['OPT_ROUTE', 'route_to_human'],
      ['OPT_BLOCK', 'block'],
    ] as const) {
      const re = new RegExp(`const ${constName}: &str = "${value}";`);
      expect(jevApprovalRs, `${constName} 必须等于 "${value}"`).toMatch(re);
      expect(tsDecisions, `TS 的 decision 不认 "${value}"`).toContain(value);
    }
    // "error" 只在判定失败（网络 / 解析 / Key 缺失）时由 dispatcher 发出，
    // 不是 Jev 的选项：混进 criteria 会让模型在一个本该三档的选择里多出一个坑。
    expect(jevApprovalRs).not.toMatch(/const OPT_\w+: &str = "error";/);
  });

  it('理由标签是中文常量，不是模型生成的文本', () => {
    // 这是选 Noul 方案的核心好处：Noul 只回数字，标签由我们给，
    // 所以理由文案完全可控、可测、可翻译。
    expect(jevApprovalRs).toContain('label:');
    const labels = [...jevApprovalRs.matchAll(/label: "([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(labels.length).toBeGreaterThanOrEqual(3);
    for (const label of labels) {
      expect(label, `理由标签应为中文：${label}`).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});

describe('Jev 根地址覆盖的语义', () => {
  it('官方地址是唯一的兜底，且拼端点只有一处实现', () => {
    // 端点拼接必须收敛到 `endpoint_url()`：散着写 `format!("{}/v1/systemone")`
    // 的地方一多，改根地址时就会漏掉一处，表现为「某些路径仍然打官方地址」。
    expect(jevRs).toContain('pub const JEV_BASE_URL: &str = "https://api.typesafe.ai";');
    const inlineConcat = [...jevRs.matchAll(/format!\("\{\}\/v1\/systemone"/g)];
    expect(
      inlineConcat.length,
      '端点拼接只允许在 endpoint_url() 里出现一次',
    ).toBeLessThanOrEqual(1);
    expect(jevRs).toContain('pub fn endpoint_url(&self) -> String');
  });

  it('「空即不动」而不是「空即清空」', () => {
    // 这条守的是语义而不是字面：一旦写成无条件赋值，用户在设置页清空这个框
    // 就会把请求打到一个空主机上，而每条 bash 都会被拦下。
    const at = jevRs.indexOf('pub fn with_base_url');
    expect(at, 'jev.rs 缺 with_base_url').toBeGreaterThan(-1);
    const body = jevRs.slice(at, jevRs.indexOf('\n    }', at));
    expect(body, 'with_base_url 必须以「非空才覆盖」为前提').toContain(
      'if !trimmed.is_empty()',
    );
  });

  it('TS 侧也声明了这个字段（否则设置页填了等于写进黑洞）', () => {
    expect(
      parseTsInterfaceFields(typesTs, 'AgentModeSettings').map((f) => f.name),
    ).toContain('jevBaseUrl');
  });
});
