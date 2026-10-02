#!/usr/bin/env node
/**
 * 无感更新门控的注入自检（Marcel SSH）
 *
 * 干什么：把 `src-tauri/src/updater/mod.rs` 里「坏包会被放过」的几处关键判定**逐条改坏**，
 * 每改一次就跑 `cargo test --lib updater::`，确认 `update_gate` 那组用例真的变红；跑完把
 * 文件写回原样（用内容写回，不用 copyFileSync —— Windows 的 CopyFile 会连 mtime 一起复制，
 * 于是 cargo 认为源码没变、继续复用「用注入版编出来的二进制」，后面测的全是坏代码）。
 *
 * 为什么需要它：门控自己也会慢慢变假 —— 断言写松、路径改了、cfg 门控把用例整个跳过。
 * 只有「改坏生产代码 → 门控必须红」这件事能证明它还在岗位上。release skill 的前置检查
 * 要求跑 `cargo test --lib updater::update_gate`；这个脚本证明那条门控不是摆设。
 *
 * 用法（仓库根目录）：node scripts/update-gate-inject.mjs
 * 退出码：0 = 每种改坏法都被门控抓到；1 = 有改坏法没被抓到（门控失效）或过程中出错。
 *
 * 注意：会临时改写 `src-tauri/src/updater/mod.rs`（约 5 次编译，几分钟）。被 Ctrl+C 打断也会
 * 还原；备份同时落在系统临时目录，万一进程被强杀可手工恢复（路径会打印出来）。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(REPO_ROOT, 'src-tauri/src/updater/mod.rs');

/** 每种改坏法：`re` 必须在文件里恰好命中一次，`to` 是替换内容。 */
const INJECTIONS = [
  {
    name: '去掉 sha256 把关（比对恒过）',
    re: /!\s*expected\.is_empty\(\) && norm\(actual\) == norm\(expected\)/,
    to: 'true',
  },
  {
    name: 'sha256 把关恒拒（好包也拒）',
    re: /!\s*expected\.is_empty\(\) && norm\(actual\) == norm\(expected\)/,
    to: 'false',
  },
  {
    name: '跳过 Windows 验签',
    re: /(fn verify_signature_with\(\n    pubkey_line: &str,\n    file_bytes: &\[u8\],\n    signature_b64: &str,\n\) -> Result<\(\), String> \{\n)/,
    to: '$1    let _ = (pubkey_line, file_bytes, signature_b64);\n    return Ok(());\n',
  },
  {
    name: '校验过了却不写 pending.json',
    re: /std::fs::write\(dir\.join\(PENDING_FILE_NAME\), meta_json\)\n\s*\.map_err\(\|e\| format!\("无法写入更新元数据: \{\}", e\)\)\?;\n/,
    to: 'let _ = meta_json;\n',
  },
  {
    name: '判出 sha 不符却不拦（继续落库）',
    re: /    if !hash_equal\(&actual_hash, &expected_hash\) \{\n        let _ = std::fs::remove_file\(&part_path\);\n        return Err\("更新包校验失败（内容不完整或被篡改）"\.into\(\)\);\n    \}\n/,
    to: '\n',
  },
];

const originalText = readFileSync(FILE, 'utf8');
const originalMd5 = createHash('md5').update(originalText).digest('hex');
const recovery = path.join(os.tmpdir(), `marcel-update-gate-backup-${Date.now()}.rs`);
writeFileSync(recovery, originalText);
console.log(`目标文件 : ${path.relative(REPO_ROOT, FILE)}（md5 ${originalMd5}）`);
console.log(`应急备份 : ${recovery}\n`);

let restored = false;
function restore(reason) {
  if (restored) return;
  restored = true;
  writeFileSync(FILE, originalText);
  if (reason) console.error(`\n[已还原源码：${reason}]`);
}
process.on('SIGINT', () => { restore('SIGINT'); process.exit(130); });
process.on('SIGTERM', () => { restore('SIGTERM'); process.exit(143); });
process.on('exit', () => restore('exit'));

/** 跑 updater 的全部用例（含 update_gate），返回变红的用例名。 */
function runTests() {
  const res = spawnSync(
    'cargo',
    ['test', '--lib', 'updater::', '--manifest-path', path.join('src-tauri', 'Cargo.toml')],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  const out = `${res.stdout}\n${res.stderr}`;
  if (!/test result:/.test(out)) {
    const errs = out.split('\n').filter((l) => /^error/.test(l)).slice(0, 4).join('\n');
    return { compileError: errs || '(未产出 test result，原因不明)' };
  }
  return {
    failed: [...out.matchAll(/^test (\S+) \.\.\. FAILED/gm)].map((m) => m[1]),
    passed: (out.match(/^test .* \.\.\. ok/gm) ?? []).length,
  };
}

const short = (t) => t.split('::').pop();
let allCaught = true;

for (const inj of INJECTIONS) {
  const hits = [...originalText.matchAll(new RegExp(inj.re.source, 'g'))].length;
  console.log(`● ${inj.name}`);
  if (hits !== 1) {
    console.log(`    !! 注入点命中 ${hits} 次（期望 1）—— 锚点过期，无法判断门控是否还有效\n`);
    allCaught = false;
    continue;
  }
  writeFileSync(FILE, originalText.replace(inj.re, inj.to));
  const r = runTests();
  writeFileSync(FILE, originalText);

  if (r.compileError) {
    console.log(`    !! 改坏后编译不过（注入写法要跟上代码）：${r.compileError}\n`);
    allCaught = false;
    continue;
  }
  const caught = r.failed.filter((t) => t.includes('update_gate'));
  const others = r.failed.filter((t) => !t.includes('update_gate'));
  console.log(`    update_gate 变红 ${caught.length} 条：${caught.map(short).join(', ') || '（无 —— 门控没抓到！）'}`);
  console.log(`    其它旧用例变红 ${others.length} 条：${others.map(short).join(', ') || '（无）'}`);
  console.log(`    通过 ${r.passed} 条\n`);
  if (caught.length === 0) allCaught = false;
}

const finalText = readFileSync(FILE, 'utf8');
const finalMd5 = createHash('md5').update(finalText).digest('hex');
const identical = finalMd5 === originalMd5;
console.log(`源码 md5 ${finalMd5} / 原始 ${originalMd5} → ${identical ? '一致（未留痕）' : '不一致！'}`);
console.log(allCaught ? '\n结论：每种改坏法都被门控抓到 —— 门控在岗。' : '\n结论：有改坏法没被门控抓到（或锚点/编译问题）—— 门控需要修。');
process.exit(allCaught && identical ? 0 : 1);
