import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { setTimeout, clearTimeout } from 'node:timers';
import { log } from 'node:console';
import { URL } from 'node:url';

// Exercise the browser-built artifact without a DOM, not Node's differently resolved dependencies.
if (isMainThread) {
  const assets = new URL('../dist/assets/', import.meta.url);
  const names = (await readdir(assets)).filter((name) => /^markdown\.worker-.*\.js$/.test(name));
  assert.equal(names.length, 1, 'Run the frontend build before this check.');
  const worker = new Worker(new URL(import.meta.url), { workerData: new URL(names[0], assets).href });
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Markdown worker did not respond')), 15000);
      worker.once('message', (message) => { clearTimeout(timeout); resolve(message); });
      worker.once('error', (error) => { clearTimeout(timeout); reject(error); });
      worker.postMessage({
        id: 1,
        text: '# Worker &copy;\n\n```js\nconst answer = 42;\n```\n\n$$E = mc^2$$',
      });
    });
    assert.equal(result.id, 1);
    assert.equal(result.tree?.type, 'root', 'Worker must return an AST, not fall back to the main thread.');
    const tree = JSON.stringify(result.tree);
    assert.ok(tree.includes('katex'), 'Math rendering must work without DOMParser.');
    assert.ok(tree.includes('hljs'), 'Code highlighting must work without a document.');
    assert.ok(tree.includes('\u00a9'), 'Named character references must decode without a document.');
    log('Browser-built Markdown worker: parsing, math, highlighting and entities passed without a DOM.');
  } finally {
    await worker.terminate();
  }
} else {
  globalThis.self = { postMessage: (message) => parentPort.postMessage(message) };
  await import(workerData);
  parentPort.on('message', (data) => globalThis.self.onmessage({ data }));
}
