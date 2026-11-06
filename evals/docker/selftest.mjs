// 题目自测：每道题起一台全新靶机，验证题目本身没出错。
//   布置后（什么都不做）：判卷脚本一分不给，也没有扣分和红线；
//   跑完参考解法 solve.sh 后：判卷脚本的得分点全部拿到，没有扣分和红线；
//   solve.sh 的输出当作「结论」：answerPoints 的得分项全部命中，扣分项一条不中。
// 用法：node evals/docker/selftest.mjs [题目 id ...]   不带参数跑全部（同时跑 4 道）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS = path.join(HERE, '..', 'tasks');
const IMAGE = 'marcel-eval-target:latest';

const docker = async (...args) => {
  try {
    const { stdout, stderr } = await exec('docker', args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message };
  }
};

function parse(out) {
  const r = { points: [], deducts: [], redlines: [] };
  for (const line of out.split('\n').map((l) => l.trim())) {
    let m = line.match(/^POINT\s+(\d+(?:\.\d+)?)\s+([01])\s+(.*)$/);
    if (m) r.points.push({ w: Number(m[1]), ok: m[2] === '1', desc: m[3] });
    else if ((m = line.match(/^DEDUCT\s+(\d+(?:\.\d+)?)\s+(.*)$/))) r.deducts.push(m[2]);
    else if ((m = line.match(/^REDLINE\s+(.*)$/))) r.redlines.push(m[1]);
  }
  return r;
}

async function selftest(id) {
  const dir = path.join(TASKS, id);
  const task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
  const name = `marcel-selftest-${id}`;
  const problems = [];
  await docker('rm', '-f', name);
  const tmpfs = Object.entries(task.tmpfs ?? {}).flatMap(([d, size]) => ['--tmpfs', `${d}:rw,exec,size=${size}`]);
  const started = await docker('run', '-d', '--rm', '--name', name, '--memory', '1g', ...tmpfs, IMAGE);
  if (started.code !== 0) return { id, problems: [`容器起不来：${started.stderr.trim()}`] };
  try {
    await docker('cp', dir, `${name}:/tmp/task`);
    const setup = await docker('exec', name, 'bash', '/tmp/task/setup.sh');
    if (setup.code !== 0) return { id, problems: [`setup 失败：${(setup.stderr || setup.stdout).trim().slice(-600)}`] };
    const before = parse((await docker('exec', name, 'bash', '/tmp/task/check.sh')).stdout);
    for (const p of before.points.filter((p) => p.ok)) problems.push(`什么都不做就拿到了分：${p.desc}`);
    for (const d of before.deducts) problems.push(`什么都不做就被扣分：${d}`);
    for (const r of before.redlines) problems.push(`什么都不做就踩红线：${r}`);
    const solve = await docker('exec', name, 'bash', '/tmp/task/solve.sh');
    if (solve.code !== 0) problems.push(`solve 失败：${(solve.stderr || solve.stdout).trim().slice(-600)}`);
    const after = parse((await docker('exec', name, 'bash', '/tmp/task/check.sh')).stdout);
    for (const p of after.points.filter((p) => !p.ok)) problems.push(`参考解法没拿到分：${p.desc}`);
    for (const d of after.deducts) problems.push(`参考解法被扣分：${d}`);
    for (const r of after.redlines) problems.push(`参考解法踩红线：${r}`);
    const answer = solve.stdout;
    for (const ap of task.answerPoints ?? []) {
      const hit = new RegExp(ap.re, 'i').test(answer);
      if (ap.deduct && hit) problems.push(`参考结论命中了扣分项：${ap.desc}`);
      if (!ap.deduct && !hit) problems.push(`参考结论没命中得分项：${ap.desc}`);
    }
    if (!after.points.length && !(task.answerPoints ?? []).length) problems.push('这道题没有任何得分点');
    const total = after.points.reduce((s, p) => s + p.w, 0) + (task.answerPoints ?? []).filter((a) => !a.deduct).reduce((s, a) => s + Number(a.points ?? 10), 0);
    return { id, problems, total };
  } finally {
    await docker('rm', '-f', name);
  }
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(TASKS).filter((d) => fs.existsSync(path.join(TASKS, d, 'task.json')));
const queue = [...ids];
const results = [];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let id; (id = queue.shift()); ) {
    const r = await selftest(id);
    results.push(r);
    console.log(r.problems.length ? `[失败] ${id}\n${r.problems.map((p) => `    - ${p}`).join('\n')}` : `[通过] ${id}（满分点合计 ${r.total}）`);
  }
}));
const bad = results.filter((r) => r.problems.length).length;
console.log(`合计：通过 ${results.length - bad}，失败 ${bad}`);
process.exit(bad ? 1 : 0);
