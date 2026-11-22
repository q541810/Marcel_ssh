#!/usr/bin/env node
/** 构建前同步公开模型知识；不是客户端更新器，也不自动提交。 */
import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile, open, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, validateCatalog } from './zcode-model-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_STALE_MS = 90_000;
async function acquireLock(file) {
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(String(process.pid));
      return async () => { await handle.close(); await rm(file, { force: true }); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = Date.now() - await stat(file).then((s) => s.mtimeMs).catch(() => 0);
      if (age > LOCK_STALE_MS) await rm(file, { force: true });
      else if (Date.now() >= deadline) throw new Error('另一个构建正在更新 ZCode 模型表，请稍后重试');
      else await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}
const MAX_BYTES = 10_000_000;
const hash = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
class FetchError extends Error {}
const stringify = (value) => `${JSON.stringify(value, null, 2)}\n`;
const isNetworkError = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError' || error instanceof TypeError || error instanceof FetchError;
const minimalUpstream = (upstream) => ({
  schemaVersion: upstream.schemaVersion,
  revision: upstream.revision,
  config: {
    providerConfigRules: {
      templateRules: upstream.config.providerConfigRules.templateRules.map((rule) => ({ templateId: rule.templateId, config: { api: rule.config.api, builtinModelIds: rule.config.builtinModelIds } })),
      providerRules: upstream.config.providerConfigRules.providerRules.map((rule) => ({ providerId: rule.providerId, config: { api: rule.config.api, builtinModelIds: rule.config.builtinModelIds } })),
    },
    modelConfigRules: upstream.config.modelConfigRules,
  },
});

async function readJson(file, validate) {
  const text = await readFile(file, 'utf8');
  const parsed = JSON.parse(text);
  validate?.(parsed);
  return { text, parsed };
}
async function download(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Marcel-SSH-build' },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status >= 300 && response.status < 400) throw new FetchError(`上游返回未允许的重定向 (${response.status})`);
  if (!response.ok) throw new FetchError(`上游 HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) throw new Error('上游配置超过 10 MB');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('上游配置超过 10 MB');
  return text;
}
async function replace(files) {
  const temporary = files.map(([file, text]) => ({ file, text, temp: `${file}.${process.pid}.tmp` }));
  try {
    // 先把所有新内容落盘，再逐个替换；任何写失败都不产生新临时文件残留。
    await Promise.all(temporary.map(({ temp, text }) => writeFile(temp, text, 'utf8')));
    for (const { file, temp } of temporary) await rename(temp, file);
  } finally {
    await Promise.all(temporary.map(({ temp }) => rm(temp, { force: true })));
  }
}

export async function syncZcodeModelCatalog({
  root = ROOT,
  fetchJson = download,
  strict = process.env.MARCEL_ZCODE_SYNC_REQUIRED === '1',
} = {}) {
  const files = {
    snapshot: path.join(root, 'config/upstream/zcode-builtin.json'),
    provenance: path.join(root, 'config/upstream/zcode-builtin.source.json'),
    catalog: path.join(root, 'src/assets/modelCatalog.json'),
  };
  await mkdir(path.join(root, 'config/upstream'), { recursive: true });
  const releaseLock = await acquireLock(path.join(root, 'config/upstream/.sync.lock'));
  try {
    const previous = await readJson(files.snapshot);
    await readJson(files.provenance);
    const oldCatalog = (await readJson(files.catalog, validateCatalog)).parsed;
    if (previous.parsed.schemaVersion !== 1 || !Number.isSafeInteger(previous.parsed.revision)) throw new Error('本地 ZCode 快照损坏');
    try {
      const release = JSON.parse(await fetchJson('https://api.github.com/repos/zai-org/ZCode/releases/latest'));
      const tag = release.tag_name;
      if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('ZCode 最新 release 不是语义化正式版本');
      // release 的 target_commitish 可能是 main；tag ref 才是不可变的发布身份。
      const reference = JSON.parse(await fetchJson(`https://api.github.com/repos/zai-org/ZCode/git/ref/tags/${tag}`));
      const commit = reference.object?.sha;
      if (!/^[a-f0-9]{40}$/i.test(commit ?? '')) throw new Error('ZCode release tag 缺少固定的 commit SHA');
      const text = await fetchJson(`https://raw.githubusercontent.com/zai-org/ZCode/${commit}/config/provider/zcode-builtin.json`);
      const upstream = JSON.parse(text);
      const source = {
        repository: 'zai-org/ZCode', release: release.tag_name, commit, revision: upstream.revision,
        sha256: hash(text), license: 'Apache-2.0',
        upstreamUrl: `https://github.com/zai-org/ZCode/blob/${commit}/config/provider/zcode-builtin.json`,
      };
      const catalog = buildCatalog(upstream, source);
      const same = JSON.stringify(previous.parsed) === JSON.stringify(minimalUpstream(upstream)) && JSON.stringify(oldCatalog) === JSON.stringify(catalog);
      if (same) {
        console.log(`ZCode 模型表已是最新（${source.release} / revision ${source.revision}）`);
        return { updated: false, catalog };
      }
      if (upstream.revision < previous.parsed.revision) throw new Error(`上游 revision ${upstream.revision} 低于本地 ${previous.parsed.revision}`);
      if (upstream.revision === previous.parsed.revision && JSON.stringify(previous.parsed) !== JSON.stringify(minimalUpstream(upstream))) throw new Error('相同 revision 的上游内容发生变化，拒绝替换');
      await replace([[files.snapshot, stringify(minimalUpstream(upstream))], [files.provenance, stringify(source)], [files.catalog, stringify(catalog)]]);
      console.warn(`[warn] ZCode 模型表已更新：revision ${previous.parsed.revision} → ${upstream.revision}；本次构建使用新表。请审查并提交快照。`);
      return { updated: true, catalog };
    } catch (error) {
      if (!isNetworkError(error) || strict) throw error;
      console.warn(`[warn] 暂时无法检查 ZCode 模型表（${error.message}），沿用 revision ${previous.parsed.revision} 的有效快照。`);
      return { updated: false, catalog: oldCatalog, offline: true };
    }
  } finally {
    await releaseLock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncZcodeModelCatalog();
}
