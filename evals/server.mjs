// Marcel 评测台：调度器 + 本地 GUI。
//
// 用法：pnpm eval   （自动打开浏览器；Ctrl+C 退出）
//
// 它负责：
// - 编译评测入口（src-tauri 的测试程序，内含 eval_runner），按 git 提交 + 是否有未提交改动标记版本；
// - 每次考试：起一台全新 Docker 靶机 → 布置考题 → 调起评测入口跑真实 agent → 判卷 → 销毁靶机；
// - 模型请求全部经本地中转站转发到你的 API：真实 Key 只在这里，且同一时刻最多 4 个请求在路上
//   （一道题里 agent 会并行派子 agent、审批模型会并行预取，只限「同时考几道题」挡不住）；
// - 成绩落在 evals/results/（不入库），GUI 读它出成绩单、对比、回放。

import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TAURI_DIR = path.join(ROOT, 'src-tauri');
const TASKS_DIR = process.env.EVAL_TASKS_DIR ? path.resolve(process.env.EVAL_TASKS_DIR) : path.join(HERE, 'tasks');
const RESULTS_DIR = process.env.EVAL_RESULTS_DIR ? path.resolve(process.env.EVAL_RESULTS_DIR) : path.join(HERE, 'results');
const LOCAL_DIR = path.join(HERE, '.local');
const CONFIG_PATH = path.join(LOCAL_DIR, 'config.json');
const WORK_DIR = path.join(LOCAL_DIR, 'work');
const IMAGE = 'marcel-eval-target:latest';
/** 用户硬要求：对 API 的并发不超过 4。中转站与「同时考几道」都按它封顶。 */
const MAX_API_CONCURRENCY = 4;
const SSH_PASSWORD = 'marcel-eval';
/** 判为「考试作废」后自动重考的次数（API 报错 / 靶机起不来，不算模型答错）。 */
const VOID_RETRIES = 2;

// ═══════════════════════ 小工具 ═══════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const shortId = () => crypto.randomBytes(4).toString('hex');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      ...opts,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message) };
  }
}

const docker = (...args) => run('docker', args);

// ═══════════════════════ 配置 ═══════════════════════

const DEFAULT_CONFIG = {
  baseUrl: '',
  apiKey: '',
  /** [{ id, modelName, displayName, contextWindow, temperature, priceIn, priceOut, extraBody }] */
  models: [],
  /** 同时考几道题（≤ 4）。 */
  parallelTasks: 4,
};

async function loadConfig() {
  return { ...DEFAULT_CONFIG, ...(await readJson(CONFIG_PATH, {})) };
}

function publicConfig(config) {
  const { apiKey, ...rest } = config;
  return { ...rest, apiKeySet: Boolean(apiKey), apiKeyHint: apiKey ? `…${apiKey.slice(-4)}` : '' };
}

// ═══════════════════════ 考题 ═══════════════════════

/** 读不进来的考题（task.json 写错、缺文件）：GUI 里明确列出来，别让题目悄悄消失。 */
let taskProblems = [];

async function loadTasks() {
  let entries = [];
  try {
    entries = await fs.readdir(TASKS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const tasks = [];
  const problems = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(TASKS_DIR, entry.name);
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(dir, 'task.json'), 'utf8'));
    } catch (e) {
      problems.push({ id: entry.name, error: `task.json 读不进来：${e.message}` });
      continue;
    }
    const missing = ['setup.sh', 'check.sh'].filter((f) => !fss.existsSync(path.join(dir, f)));
    if (missing.length) {
      problems.push({ id: entry.name, error: `缺少 ${missing.join('、')}` });
      continue;
    }
    tasks.push({
      id: entry.name,
      title: meta.title ?? entry.name,
      category: meta.category ?? '其他',
      difficulty: meta.difficulty ?? 'medium',
      hidden: Boolean(meta.hidden),
      prompt: meta.prompt ?? '',
      timeoutSecs: meta.timeoutSecs ?? 600,
      answers: meta.answers ?? [],
      defaultAnswer: meta.defaultAnswer ?? null,
      forbidden: meta.forbidden ?? [],
      expectInAnswer: meta.expectInAnswer ?? [],
      mode: meta.mode ?? null,
    });
  }
  const order = ['排障', '部署', '文件', '信息检索', '上下文压力', '长任务', '澄清', '安全'];
  tasks.sort((a, b) => (order.indexOf(a.category) - order.indexOf(b.category)) || a.id.localeCompare(b.id));
  taskProblems = problems;
  return tasks;
}

// ═══════════════════════ 版本与编译 ═══════════════════════

async function versionInfo() {
  const head = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })).stdout.trim();
  const subject = (await run('git', ['log', '-1', '--format=%s'], { cwd: ROOT })).stdout.trim();
  const status = (await run('git', ['status', '--porcelain', '--', 'src-tauri'], { cwd: ROOT })).stdout.trim();
  return { commit: head, subject, dirty: status.length > 0 };
}

/** 编译评测入口，返回一份按内容哈希缓存的可执行文件路径。 */
async function buildRunner(onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', ['test', '--lib', '--no-run', '--message-format=json-render-diagnostics'], {
      cwd: TAURI_DIR,
      windowsHide: true,
    });
    let exe = null;
    let buf = '';
    const errors = [];
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try {
          const msg = JSON.parse(line);
          // `--lib` 只产出一个测试程序（crate 类型写的是 rlib/cdylib/staticlib，不是 "lib"）。
          if (msg.reason === 'compiler-artifact' && msg.executable && msg.profile?.test) {
            exe = msg.executable;
          } else if (msg.reason === 'compiler-artifact' && msg.target?.name) {
            onLog?.(`编译 ${msg.target.name}`);
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      errors.push(text);
      const last = text.trim().split('\n').pop();
      if (last) onLog?.(last.trim());
    });
    child.on('close', async (code) => {
      if (code === 0 && !exe) {
        reject(new Error('编译成功了，但没在 cargo 输出里找到测试程序（cargo 输出格式可能变了，看 buildRunner）'));
        return;
      }
      if (code !== 0) {
        // 只摘真正的报错段落（以 error 开头到下一个空行），别把几百条 warning 糊给人看。
        const text = errors.join('');
        const blocks = text.split(/\n(?=\S)/).filter((b) => /^error/.test(b));
        reject(new Error(`编译失败：\n${(blocks.length ? blocks.join('\n') : text).slice(-6000)}`));
        return;
      }
      // 直接用 cargo 产出的那份，不复制：复制出来的测试 exe 会被杀毒软件（火绒）当场删掉。
      // 代价是这一轮跑的途中若有人重新编译，后面的考试会换成新程序——所以开跑时记下哈希，
      // 每场考试前核对，对不上就判作废并说明原因，不会悄悄混用两个版本。
      try {
        resolve({ exe, buildHash: await fileHash(exe) });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function fileHash(file) {
  const bytes = await fs.readFile(file);
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

// ═══════════════════════ 限流中转站 ═══════════════════════

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  acquire() {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

/** 每场考试的请求账：token 是 job 里的 modelToken。 */
const proxyStats = new Map();
const apiGate = new Semaphore(MAX_API_CONCURRENCY);
let proxyPort = 0;
let liveConfig = DEFAULT_CONFIG;

function statsFor(token) {
  let s = proxyStats.get(token);
  if (!s) {
    s = { requests: 0, errors: 0, errorSamples: [], queueWaitMs: 0, upstreamMs: 0 };
    proxyStats.set(token, s);
  }
  return s;
}

function startProxy() {
  const server = http.createServer(async (req, res) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token.startsWith('eval-')) {
      res.writeHead(401).end('unknown eval token');
      return;
    }
    const stats = statsFor(token);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const waitStart = Date.now();
    await apiGate.acquire();
    stats.queueWaitMs += Date.now() - waitStart;
    stats.requests++;
    const upstreamStart = Date.now();
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        stats.upstreamMs += Date.now() - upstreamStart;
        apiGate.release();
      }
    };
    try {
      const base = liveConfig.baseUrl.replace(/\/+$/, '');
      const suffix = req.url.replace(/^\/v1/, '');
      const headers = {
        'content-type': req.headers['content-type'] ?? 'application/json',
        authorization: `Bearer ${liveConfig.apiKey}`,
        accept: req.headers.accept ?? '*/*',
      };
      const upstream = await fetch(`${base}${suffix}`, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
      if (upstream.status >= 400) {
        stats.errors++;
        const text = await upstream.text();
        if (stats.errorSamples.length < 5) stats.errorSamples.push(`HTTP ${upstream.status}: ${text.slice(0, 300)}`);
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' });
        res.end(text);
        release();
        return;
      }
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-cache',
      });
      if (!upstream.body) {
        res.end();
        release();
        return;
      }
      const stream = Readable.fromWeb(upstream.body);
      stream.on('error', (e) => {
        stats.errors++;
        if (stats.errorSamples.length < 5) stats.errorSamples.push(`断流: ${e.message}`);
        res.destroy(e);
        release();
      });
      stream.on('end', release);
      res.on('close', () => {
        stream.destroy();
        release();
      });
      stream.pipe(res);
    } catch (e) {
      stats.errors++;
      if (stats.errorSamples.length < 5) stats.errorSamples.push(`网络错误: ${e.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end(String(e.message));
      release();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      proxyPort = server.address().port;
      resolve();
    });
  });
}

// ═══════════════════════ 靶机 ═══════════════════════

async function ensureImage(onLog) {
  const inspect = await docker('image', 'inspect', IMAGE, '--format', '{{.Id}}');
  if (inspect.code === 0) return;
  onLog?.('第一次使用：构建靶机镜像（几分钟）…');
  const res = await run('docker', ['build', '-t', IMAGE, path.join(HERE, 'docker')]);
  if (res.code !== 0) throw new Error(`靶机镜像构建失败：${res.stderr.slice(-2000)}`);
}

function tcpReady(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.setTimeout(1500);
    sock.once('data', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('error', () => resolve(false));
  });
}

async function startTarget(task) {
  const name = `marcel-eval-${shortId()}`;
  const started = await docker('run', '-d', '--rm', '--name', name, '--memory', '1g', '-p', '127.0.0.1::22', IMAGE);
  if (started.code !== 0) throw new Error(`起靶机失败：${started.stderr.trim()}`);
  const id = started.stdout.trim();
  try {
    const portOut = (await docker('port', id, '22/tcp')).stdout.trim().split('\n')[0] ?? '';
    const port = Number(portOut.split(':').pop());
    if (!port) throw new Error(`拿不到靶机 SSH 端口：${portOut}`);
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      ready = await tcpReady(port);
      if (!ready) await sleep(250);
    }
    if (!ready) throw new Error('靶机 SSH 没起来');
    // 考题文件只在布置期间存在：判卷脚本与参考解法绝不能留给 agent 看见。
    const cp = await docker('cp', path.join(TASKS_DIR, task.id), `${id}:/eval-task`);
    if (cp.code !== 0) throw new Error(`拷贝考题失败：${cp.stderr}`);
    const setup = await docker('exec', id, 'bash', '/eval-task/setup.sh');
    await docker('exec', id, 'rm', '-rf', '/eval-task');
    if (setup.code !== 0) throw new Error(`布置考题失败：${(setup.stderr || setup.stdout).slice(-1500)}`);
    const fpOut = (await docker('exec', id, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub')).stdout.trim();
    const fingerprint = fpOut.split(/\s+/)[1];
    if (!fingerprint?.startsWith('SHA256:')) throw new Error(`读不到靶机主机指纹：${fpOut}`);
    return { id, port, fingerprint };
  } catch (e) {
    await docker('rm', '-f', id);
    throw e;
  }
}

async function gradeTarget(target, task) {
  const cp = await docker('cp', path.join(TASKS_DIR, task.id, 'check.sh'), `${target.id}:/tmp/eval-check.sh`);
  if (cp.code !== 0) return { ok: false, reason: `拷贝判卷脚本失败：${cp.stderr}` };
  const res = await docker('exec', target.id, 'bash', '/tmp/eval-check.sh');
  const lines = `${res.stdout}`.trim().split('\n').filter(Boolean);
  return { ok: res.code === 0, reason: lines.pop() ?? (res.code === 0 ? '通过' : `判卷脚本退出码 ${res.code}`) };
}

// ═══════════════════════ 单场考试 ═══════════════════════

function runRunner(exe, jobPath, logPath, hardTimeoutMs) {
  return new Promise((resolve) => {
    const out = fss.createWriteStream(logPath);
    const child = spawn(exe, ['eval_runner::run_job', '--exact', '--ignored', '--nocapture', '--test-threads=1'], {
      cwd: TAURI_DIR,
      env: { ...process.env, MARCEL_EVAL_JOB: jobPath, RUST_LOG: process.env.RUST_LOG ?? 'warn' },
      windowsHide: true,
    });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    const timer = setTimeout(() => child.kill(), hardTimeoutMs);
    let settled = false;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) out.write(`
[评测台] 启动评测入口失败：${error.message}
`);
      out.end();
      resolve({ code, error });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code, null));
  });
}

function compileRegexes(list) {
  return (list ?? []).map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/** 判一场考试。verdict: pass / fail / void（作废，不计入成绩、会重考）。 */
function judge(task, result, check, api) {
  const reasons = [];
  if (!result) return { verdict: 'void', reasons: ['评测入口没有产出结果（崩溃或被强杀，看日志）'] };
  if (result.status === 'harness_error') return { verdict: 'void', reasons: [result.harnessError ?? 'harness 错误'] };
  if (result.status === 'failed' && api.errors > 0 && (result.toolCalls?.length ?? 0) === 0) {
    return { verdict: 'void', reasons: [`API 出错：${api.errorSamples[0] ?? result.failure ?? ''}`] };
  }
  if (result.status !== 'completed') reasons.push(`agent 没有正常结束（${result.status}${result.failure ? `：${result.failure}` : ''}）`);
  if (!check.ok) reasons.push(`判卷不通过：${check.reason}`);
  for (const re of compileRegexes(task.forbidden)) {
    const hit = (result.toolCalls ?? []).find((c) => c.command && re.test(c.command));
    if (hit) reasons.push(`执行了禁止的命令：${hit.command.slice(0, 200)}`);
  }
  for (const re of compileRegexes(task.expectInAnswer)) {
    if (!re.test(result.finalText ?? '')) reasons.push(`最终回复里没有找到 ${re.source}`);
  }
  return reasons.length ? { verdict: 'fail', reasons } : { verdict: 'pass', reasons: [check.reason] };
}

async function runAttempt(ctx, attempt) {
  const { run: runRec, exe } = ctx;
  const task = ctx.tasks.get(attempt.taskId);
  const model = runRec.models.find((m) => m.id === attempt.modelId);
  const attemptDir = path.join(RESULTS_DIR, runRec.id, 'attempts');
  const workDir = path.join(WORK_DIR, `${runRec.id}-${attempt.id}`);
  await fs.mkdir(attemptDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });
  const token = `eval-${runRec.id}-${attempt.id}-${attempt.tries}`;
  let target = null;
  let result = null;
  let check = { ok: false, reason: '未判卷' };
  const startedAt = Date.now();
  try {
    update(ctx, attempt, { state: 'preparing' });
    target = await startTarget(task);
    update(ctx, attempt, { state: 'running' });
    const resultPath = path.join(workDir, 'result.json');
    const job = {
      modelBaseUrl: `http://127.0.0.1:${proxyPort}/v1`,
      modelToken: token,
      model: {
        modelName: model.modelName,
        displayName: model.displayName || model.modelName,
        ...(model.contextWindow ? { contextWindow: Number(model.contextWindow) } : {}),
        ...(model.temperature !== undefined && model.temperature !== '' ? { temperature: Number(model.temperature) } : {}),
        ...(model.extraBody ? { extraBody: model.extraBody } : {}),
      },
      ssh: {
        host: '127.0.0.1',
        port: target.port,
        username: 'root',
        password: SSH_PASSWORD,
        hostKeyAlgorithm: 'ssh-ed25519',
        hostKeyFingerprint: target.fingerprint,
      },
      prompt: task.prompt,
      mode: task.mode ?? runRec.mode,
      answers: task.answers,
      defaultAnswer: task.defaultAnswer,
      timeoutSecs: task.timeoutSecs,
      settingsPatch: runRec.settingsPatch ?? null,
      resultPath,
      workDir,
    };
    const jobPath = path.join(workDir, 'job.json');
    await writeJson(jobPath, job);
    if ((await fileHash(exe).catch(() => null)) !== runRec.buildHash) {
      throw new Error('评测入口程序在这一轮途中被重新编译或删除了（杀毒软件？），为免混用两个版本，这场作废');
    }
    const launched = await runRunner(exe, jobPath, path.join(attemptDir, `${attempt.id}.log`), (task.timeoutSecs + 180) * 1000);
    if (launched.error) throw new Error(`启动评测入口失败：${launched.error.message}`);
    result = await readJson(resultPath, null);
    update(ctx, attempt, { state: 'grading' });
    check = await gradeTarget(target, task);
  } catch (e) {
    result = { status: 'harness_error', harnessError: e.message };
  } finally {
    if (target) await docker('rm', '-f', target.id);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
  const api = statsFor(token);
  proxyStats.delete(token);
  const verdict = judge(task, result, check, api);
  const usage = result?.usage ?? {};
  const cost = model.priceIn || model.priceOut
    ? ((usage.promptTokens ?? 0) - (usage.cachedReadTokens ?? 0)) / 1e6 * Number(model.priceIn || 0)
      + (usage.cachedReadTokens ?? 0) / 1e6 * Number(model.priceCached || model.priceIn || 0)
      + (usage.completionTokens ?? 0) / 1e6 * Number(model.priceOut || 0)
    : null;
  const summary = {
    verdict: verdict.verdict,
    reasons: verdict.reasons,
    status: result?.status ?? null,
    durationMs: Date.now() - startedAt,
    agentMs: result?.durationMs ?? null,
    queueWaitMs: api.queueWaitMs,
    apiRequests: api.requests,
    apiErrors: api.errors,
    tokens: usage.totalTokens ?? 0,
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    cachedTokens: usage.cachedReadTokens ?? 0,
    cost,
    rounds: result?.mainRounds ?? 0,
    toolCalls: result?.toolCalls?.length ?? 0,
    toolErrors: (result?.toolCalls ?? []).filter((c) => c.success === false).length,
    blockedCalls: (result?.toolCalls ?? []).filter((c) => c.blocked).length,
    approvals: (result?.interactions ?? []).filter((i) => i.kind === 'approval').length,
    questions: (result?.interactions ?? []).filter((i) => i.kind === 'question').length,
    subagents: result?.subagents ?? 0,
    compactions: result?.compactions ?? 0,
  };
  await writeJson(path.join(attemptDir, `${attempt.id}-try${attempt.tries}.json`), {
    attempt: { ...attempt },
    task: { id: task.id, title: task.title, prompt: task.prompt },
    model: { id: model.id, modelName: model.modelName, displayName: model.displayName },
    summary,
    api: { ...api },
    check,
    result,
  });
  return summary;
}

// ═══════════════════════ 一轮评测 ═══════════════════════

const runs = new Map(); // 活动中的轮次 id → ctx
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function update(ctx, attempt, patch) {
  Object.assign(attempt, patch);
  broadcast('attempt', { runId: ctx.run.id, attempt });
}

async function persistRun(ctx) {
  await writeJson(path.join(RESULTS_DIR, ctx.run.id, 'run.json'), ctx.run);
}

async function startRun(body) {
  const config = await loadConfig();
  if (!config.baseUrl || !config.apiKey) throw new Error('还没配置 API 地址和 Key（右上角「设置」）');
  const allTasks = await loadTasks();
  const tasks = new Map(allTasks.map((t) => [t.id, t]));
  const taskIds = (body.taskIds ?? []).filter((id) => tasks.has(id));
  const models = config.models.filter((m) => (body.modelIds ?? []).includes(m.id));
  if (!taskIds.length) throw new Error('至少选一道题');
  if (!models.length) throw new Error('至少选一个模型');
  if ([...runs.values()].some((c) => !c.run.finishedAt)) throw new Error('上一轮还在跑，等它结束或先停止');
  const repeat = Math.max(1, Math.min(20, Number(body.repeat) || 3));
  const id = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${shortId()}`;
  const attempts = [];
  for (let r = 0; r < repeat; r++) {
    for (const taskId of taskIds) {
      for (const model of models) {
        attempts.push({ id: `${taskId}__${model.id}__${r + 1}`, taskId, modelId: model.id, round: r + 1, state: 'queued', tries: 0 });
      }
    }
  }
  const run = {
    id,
    label: (body.label ?? '').trim() || '未命名',
    note: body.note ?? '',
    createdAt: nowIso(),
    finishedAt: null,
    phase: 'building',
    phaseDetail: '准备中',
    version: await versionInfo(),
    buildHash: null,
    mode: body.mode === 'auto' ? 'auto' : 'agent',
    repeat,
    parallelTasks: Math.max(1, Math.min(MAX_API_CONCURRENCY, Number(config.parallelTasks) || MAX_API_CONCURRENCY)),
    settingsPatch: body.settingsPatch ?? null,
    models: models.map(({ id, modelName, displayName, priceIn, priceOut, priceCached, contextWindow, temperature, extraBody }) => ({
      id, modelName, displayName, priceIn, priceOut, priceCached, contextWindow, temperature, extraBody,
    })),
    tasks: taskIds.map((tid) => ({ id: tid, title: tasks.get(tid).title, category: tasks.get(tid).category, hidden: tasks.get(tid).hidden })),
    attempts,
    error: null,
  };
  const ctx = { run, tasks, exe: null, cancelled: false };
  runs.set(id, ctx);
  await persistRun(ctx);
  broadcast('run', run);
  executeRun(ctx).catch(async (e) => {
    run.error = e.message;
    run.phase = 'error';
    run.finishedAt = nowIso();
    await persistRun(ctx);
    broadcast('run', run);
  });
  return run;
}

function setPhase(ctx, phase, detail) {
  ctx.run.phase = phase;
  ctx.run.phaseDetail = detail;
  broadcast('phase', { runId: ctx.run.id, phase, detail });
}

async function executeRun(ctx) {
  const { run } = ctx;
  liveConfig = await loadConfig();
  setPhase(ctx, 'building', '编译评测入口（改了 Rust 代码会慢一些）');
  let lastLog = 0;
  const built = await buildRunner((line) => {
    if (Date.now() - lastLog > 400) {
      lastLog = Date.now();
      setPhase(ctx, 'building', line.slice(0, 160));
    }
  });
  ctx.exe = built.exe;
  run.buildHash = built.buildHash;
  setPhase(ctx, 'building', '检查靶机镜像');
  await ensureImage((l) => setPhase(ctx, 'building', l));
  setPhase(ctx, 'running', '');
  await persistRun(ctx);

  const queue = [...run.attempts];
  let lastPersist = 0;
  const worker = async () => {
    while (!ctx.cancelled) {
      const attempt = queue.shift();
      if (!attempt) return;
      let summary;
      do {
        attempt.tries++;
        summary = await runAttempt(ctx, attempt);
      } while (summary.verdict === 'void' && attempt.tries <= VOID_RETRIES && !ctx.cancelled);
      update(ctx, attempt, { state: 'done', summary });
      if (Date.now() - lastPersist > 2000) {
        lastPersist = Date.now();
        await persistRun(ctx);
      }
    }
  };
  await Promise.all(Array.from({ length: run.parallelTasks }, worker));
  for (const a of run.attempts) if (a.state !== 'done') a.state = 'cancelled';
  run.phase = ctx.cancelled ? 'cancelled' : 'done';
  run.finishedAt = nowIso();
  await persistRun(ctx);
  broadcast('run', run);
}

async function listRuns() {
  let dirs = [];
  try {
    dirs = await fs.readdir(RESULTS_DIR);
  } catch {
    return [];
  }
  const list = [];
  for (const d of dirs) {
    const active = runs.get(d);
    const run = active ? active.run : await readJson(path.join(RESULTS_DIR, d, 'run.json'), null);
    if (run) list.push(run);
  }
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return list;
}

// 上次进程退出时还在跑的轮次：标成中断，免得 GUI 一直显示「进行中」。
async function recoverStaleRuns() {
  for (const run of await listRuns()) {
    if (!run.finishedAt) {
      run.finishedAt = nowIso();
      run.phase = 'cancelled';
      for (const a of run.attempts) if (a.state !== 'done') a.state = 'cancelled';
      await writeJson(path.join(RESULTS_DIR, run.id, 'run.json'), run);
    }
  }
  // 清掉上次遗留的靶机。
  const left = (await docker('ps', '-aq', '--filter', 'name=marcel-eval-')).stdout.trim();
  if (left) await docker('rm', '-f', ...left.split(/\s+/));
}

// ═══════════════════════ HTTP / GUI ═══════════════════════

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function fetchUpstreamModels(baseUrl, apiKey) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`接口返回 ${res.status}：${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return (json.data ?? []).map((m) => m.id).filter(Boolean).sort();
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await fs.readFile(path.join(HERE, 'ui', 'index.html')));
      return;
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (p === '/api/state' && req.method === 'GET') {
      const [config, tasks, runList, version, image] = await Promise.all([
        loadConfig(), loadTasks(), listRuns(), versionInfo(), docker('image', 'inspect', IMAGE, '--format', '{{.Id}}'),
      ]);
      const dockerOk = (await docker('info', '--format', '{{.ServerVersion}}')).code === 0;
      sendJson(res, 200, {
        config: publicConfig(config),
        tasks,
        taskProblems,
        runs: runList,
        version,
        docker: { ok: dockerOk, image: image.code === 0 },
        maxConcurrency: MAX_API_CONCURRENCY,
      });
      return;
    }
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const current = await loadConfig();
      const next = {
        ...current,
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : current.baseUrl,
        apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : current.apiKey,
        models: Array.isArray(body.models) ? body.models.map((m) => ({ ...m, id: m.id || shortId() })) : current.models,
        parallelTasks: Math.max(1, Math.min(MAX_API_CONCURRENCY, Number(body.parallelTasks ?? current.parallelTasks) || 4)),
      };
      await writeJson(CONFIG_PATH, next);
      liveConfig = next;
      sendJson(res, 200, publicConfig(next));
      return;
    }
    if (p === '/api/upstream-models' && req.method === 'POST') {
      const body = await readBody(req);
      const current = await loadConfig();
      const list = await fetchUpstreamModels(body.baseUrl || current.baseUrl, body.apiKey || current.apiKey);
      sendJson(res, 200, { models: list });
      return;
    }
    if (p === '/api/runs' && req.method === 'POST') {
      sendJson(res, 200, await startRun(await readBody(req)));
      return;
    }
    let m = p.match(/^\/api\/runs\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const active = runs.get(m[1]);
      const run = active ? active.run : await readJson(path.join(RESULTS_DIR, m[1], 'run.json'), null);
      sendJson(res, run ? 200 : 404, run ?? { error: '没有这一轮' });
      return;
    }
    if (m && req.method === 'DELETE') {
      if (runs.get(m[1]) && !runs.get(m[1]).run.finishedAt) throw new Error('这一轮还在跑，先停止');
      await fs.rm(path.join(RESULTS_DIR, m[1]), { recursive: true, force: true });
      runs.delete(m[1]);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (m && req.method === 'PATCH') {
      const body = await readBody(req);
      const active = runs.get(m[1]);
      const file = path.join(RESULTS_DIR, m[1], 'run.json');
      const run = active ? active.run : await readJson(file, null);
      if (!run) throw new Error('没有这一轮');
      if (typeof body.label === 'string') run.label = body.label.trim() || run.label;
      if (typeof body.note === 'string') run.note = body.note;
      await writeJson(file, run);
      broadcast('run', run);
      sendJson(res, 200, run);
      return;
    }
    m = p.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (m && req.method === 'POST') {
      const ctx = runs.get(m[1]);
      if (ctx) {
        ctx.cancelled = true;
        setPhase(ctx, 'cancelling', '等正在考的几道题收尾');
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    m = p.match(/^\/api\/runs\/([^/]+)\/attempts\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const dir = path.join(RESULTS_DIR, m[1], 'attempts');
      const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.startsWith(`${m[2]}-try`) && f.endsWith('.json'));
      files.sort((a, b) => Number(a.match(/try(\d+)/)[1]) - Number(b.match(/try(\d+)/)[1]));
      const tries = [];
      for (const f of files) tries.push(await readJson(path.join(dir, f), null));
      const log = await fs.readFile(path.join(dir, `${m[2]}.log`), 'utf8').catch(() => '');
      sendJson(res, 200, { tries, log: log.slice(-20000) });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

async function main() {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  liveConfig = await loadConfig();
  await startProxy();
  await recoverStaleRuns().catch(() => {});
  const server = http.createServer(handle);
  const port = Number(process.env.EVAL_PORT) || 4780;
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Marcel 评测台已启动：${url}`);
    console.log(`模型请求中转：127.0.0.1:${proxyPort}（并发上限 ${MAX_API_CONCURRENCY}）`);
    if (!process.env.EVAL_NO_OPEN) {
      const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  });
  const shutdown = async () => {
    for (const ctx of runs.values()) ctx.cancelled = true;
    const left = (await docker('ps', '-q', '--filter', 'name=marcel-eval-')).stdout.trim();
    if (left) await docker('rm', '-f', ...left.split(/\s+/));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
