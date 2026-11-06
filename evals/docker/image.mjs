// 靶机镜像：评测台（server.mjs）和自测（selftest.mjs）共用这一份。
// 镜像上贴着 Dockerfile 内容的哈希；Dockerfile 一改（比如加了编译器），下次用到时自动重建，
// 不会拿旧镜像去考需要新工具的题。
// 直接运行：node evals/docker/image.mjs [--force]   （检查并按需重建；--force 强制重建）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IMAGE = 'marcel-eval-target:latest';
const LABEL = 'marcel.dockerfile';

function dockerfileHash() {
  const text = fs.readFileSync(path.join(HERE, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

async function docker(args) {
  try {
    const { stdout } = await exec('docker', args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e.message) };
  }
}

/** 镜像不存在或和 Dockerfile 对不上就重建。onLog 收进度文字。 */
export async function ensureImage(onLog, { force = false } = {}) {
  const want = dockerfileHash();
  const inspect = await docker(['image', 'inspect', IMAGE, '--format', `{{index .Config.Labels "${LABEL}"}}`]);
  const have = inspect.code === 0 ? inspect.stdout.trim() : null;
  if (!force && have === want) return;
  onLog?.(have == null ? '第一次使用：构建靶机镜像（几分钟）…' : '靶机镜像的 Dockerfile 改过了，重新构建（几分钟）…');
  const res = await docker(['build', '--label', `${LABEL}=${want}`, '-t', IMAGE, HERE]);
  if (res.code !== 0) throw new Error(`靶机镜像构建失败：${res.stderr.slice(-2000)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await ensureImage((l) => console.log(l), { force: process.argv.includes('--force') });
  console.log('靶机镜像就绪');
}
