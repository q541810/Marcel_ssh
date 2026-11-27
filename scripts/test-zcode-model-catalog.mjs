import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCatalog } from './zcode-model-catalog.mjs';
import { syncZcodeModelCatalog } from './sync-zcode-model-catalog.mjs';

const doc = {
  schemaVersion: 1,
  revision: 1,
  config: {
    providerConfigRules: { templateRules: [], providerRules: [] },
    modelConfigRules: {
      modelRules: [
        { modelMatch: '.*', config: { properties: { contextWindow: 999999 } } },
        { modelMatch: '.*known.*', config: { properties: { contextWindow: 128000, inputFormat: { supportsImage: true } }, optionSpecs: { reasoningLevel: { values: ['low', 'high'] } } } },
      ],
      modelApiRules: [], providerSiteRules: [], templateModelRules: [], builtinProviderModelRules: [],
    },
  },
};
const json = (value) => JSON.stringify(value);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'marcel-zcode-catalog-'));
  await mkdir(path.join(root, 'config/upstream'), { recursive: true });
  await mkdir(path.join(root, 'src/assets'), { recursive: true });
  await writeFile(path.join(root, 'config/upstream/zcode-builtin.json'), json(doc));
  await writeFile(path.join(root, 'config/upstream/zcode-builtin.source.json'), '{}');
  await writeFile(path.join(root, 'src/assets/modelCatalog.json'), JSON.stringify(buildCatalog(doc)));
  const responses = [
    { target_commitish: 'main', tag_name: 'v1.0.0' },
    { object: { sha: 'a'.repeat(40) } },
    doc,
  ];
  return { root, fetchJson: async () => json(responses.shift()) };
}

{
  const { root, fetchJson } = await fixture();
  const first = await syncZcodeModelCatalog({ root, fetchJson });
  assert.equal(first.updated, true);
  assert.deepEqual(first.catalog.recommendations, [{ modelMatch: '.*known.*', contextWindow: 128000, vision: true, reasoningEfforts: ['low', 'high'] }]);
  const second = await syncZcodeModelCatalog({ root, fetchJson: async () => { throw new TypeError('offline'); } });
  assert.equal(second.offline, true);
  assert.deepEqual(second.catalog, first.catalog);
}

{
  const { root } = await fixture();
  await assert.rejects(() => syncZcodeModelCatalog({ root, fetchJson: async () => '{bad json' }), /JSON/);
  assert.equal(await readFile(path.join(root, 'config/upstream/zcode-builtin.json'), 'utf8'), json(doc));
}

{
  const { root } = await fixture();
  await assert.rejects(() => syncZcodeModelCatalog({ root, fetchJson: async () => { throw new TypeError('offline'); }, strict: true }), /offline/);
}

console.log('ZCode 模型表同步：更新、离线回退、严格模式与坏格式拒绝均通过。');
