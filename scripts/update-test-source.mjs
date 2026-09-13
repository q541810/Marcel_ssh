#!/usr/bin/env node
/**
 * 无感更新本地测试源（Marcel SSH）
 *
 * 起一个本地 HTTP 服务，向外提供一份「假的新版本」 latest.json + 更新包，
 * 配合客户端内置的开发钩子 `MARCEL_LATEST_JSON_URL`，就能在不发版的情况下
 * 把「检查 → 下载 → 校验 → 就绪 → 安装」整条链路跑通。
 *
 * 用法（在仓库根目录）：
 *   node scripts/update-test-source.mjs                    # 3MB 哑负载 + 真签名 + 自动选版本
 *   node scripts/update-test-source.mjs --no-assets        # 只给版本号：测「仅提示跳浏览器」降级
 *   node scripts/update-test-source.mjs --break-hash       # 故意写错 sha256：测校验失败提示
 *   node scripts/update-test-source.mjs --payload "src-tauri\target\release\bundle\nsis\Marcel SSH_1.4.1_x64-setup.exe"
 *   node scripts/update-test-source.mjs --host 0.0.0.0 --android <apk>   # 安卓真机联调
 *
 * 客户端跑法（另开一个终端，脚本会把这一行直接打出来）：
 *   $env:MARCEL_LATEST_JSON_URL="http://127.0.0.1:8765/latest.json"; pnpm tauri dev
 *
 * 说明：
 * - 客户端必须是 **debug 构建**（`pnpm tauri dev` / `pnpm tauri android dev`）：读取
 *   `MARCEL_LATEST_JSON_URL` 的测试钩子只在 debug 下编译进去（见
 *   `src-tauri/src/commands/update.rs`），release 构建会忽略该变量、照常走官方更新源。
 * - Windows 的更新包**必须有 minisign 签名**（客户端用内置公钥验签），所以默认会调用
 *   项目自带的 `tauri signer sign` 用 `~/.tauri/marcel-update.key` 签名；私钥不在本机
 *   时会明确报错并提示怎么办，不会静默出一份永远验不过的 latest.json。
 * - 安卓的 APK **不需要**签名（系统安装器强制校验签名一致），只需要 sha256 + size；
 *   但版本号必须递增（versionCode 单调），否则系统拒绝覆盖安装 —— debug 客户端要真机
 *   验证安装时，`--android` 得指向同一 debug keystore 签出的 APK，否则签名不一致被拒。
 * - 默认哑负载不是合法安装器：若客户端正常退出，那次静默安装会立刻失败（日志一行
 *   warn），不会改动本机任何已安装的程序 —— 这正好用来测「下载/校验/就绪」而不真装。
 *   要测真实安装，用 `--payload` 指向真安装包（会真的替换你装的应用）。
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_IDENTIFIER = 'com.marcel.ssh'; // 决定 Windows 上 app_cache_dir 的位置
const TAURI_CLI = path.join(REPO_ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

// ── 参数解析 ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    payload: null,
    sizeMb: 3,
    version: null,
    port: 8765,
    host: '127.0.0.1',
    assets: true,
    breakHash: false,
    android: null,
    sign: true,
    slowMbps: 0,
    keyPath: path.join(os.homedir(), '.tauri', 'marcel-update.key'),
    out: path.join(os.tmpdir(), 'marcel-update-test'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`参数 ${arg} 缺少取值`);
      }
      i += 1;
      return v;
    };
    switch (arg) {
      case '--payload': opts.payload = path.resolve(next()); break;
      case '--size': opts.sizeMb = Number(next()); break;
      case '--version': opts.version = next(); break;
      case '--port': opts.port = Number(next()); break;
      case '--host': opts.host = next(); break;
      case '--android': opts.android = path.resolve(next()); break;
      case '--slow': opts.slowMbps = Number(next()); break;
      case '--key': opts.keyPath = path.resolve(next()); break;
      case '--out': opts.out = path.resolve(next()); break;
      case '--no-assets': opts.assets = false; break;
      case '--break-hash': opts.breakHash = true; break;
      case '--no-sign': opts.sign = false; break;
      case '--help':
      case '-h': opts.help = true; break;
      default: throw new Error(`未知参数: ${arg}`);
    }
  }
  return opts;
}

const HELP = `无感更新本地测试源

  --payload <file>    用真实安装包当更新包（默认生成哑负载，不会真装）
  --size <MB>         哑负载大小（默认 3）
  --version <ver>     伪装的新版本号（默认 = 当前版本 patch +1）
  --port <n>          监听端口（默认 8765）
  --host <ip>         监听地址（默认 127.0.0.1；安卓真机用 0.0.0.0）
  --no-assets         不写 installer_url/signature/sha256/size（测「仅提示跳浏览器」）
  --break-hash        故意写错 sha256（测校验失败提示）
  --android <apk>     同时写 android 对象的资产字段（安卓端测试用）
  --slow <MB/s>       限速下发更新包（默认不限速）。验下载进度 UI 用：
                      本地 3MB 不到 1 秒就下完，药丸一闪而过根本看不清
  --no-sign           跳过签名（安卓可跳过；Windows 会退化为「仅提示」）
  --key <file>        签名私钥（默认 ~/.tauri/marcel-update.key）
  --out <dir>         工作目录（默认 <tmp>/marcel-update-test）
`;

// ── 小工具 ───────────────────────────────────────────────────────

const log = (msg = '') => console.log(msg);
const step = (msg) => console.log(`\n▸ ${msg}`);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256AndSize(file) {
  return {
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    size: fs.statSync(file).size,
  };
}

/** 当前版本 patch +1（够用且不会误判成「无更新」）。 */
function defaultVersion() {
  const { version } = readJson(path.join(REPO_ROOT, 'package.json'));
  const [major, minor, patch] = version.split('.').map((n) => Number.parseInt(n, 10));
  return `${major}.${minor}.${(patch || 0) + 1}`;
}

/** 安卓真机联调时打印本机局域网地址。 */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

// ── 主流程 ───────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log(HELP);
    return;
  }

  if (!fs.existsSync(TAURI_CLI)) {
    throw new Error(`找不到 tauri CLI：${TAURI_CLI}（先 pnpm install）`);
  }
  fs.mkdirSync(opts.out, { recursive: true });

  const version = opts.version ?? defaultVersion();

  // 1. 更新包：真实安装包或哑负载
  step('准备更新包');
  let payloadPath;
  if (opts.payload) {
    if (!fs.existsSync(opts.payload)) {
      throw new Error(`--payload 文件不存在: ${opts.payload}`);
    }
    payloadPath = path.join(opts.out, path.basename(opts.payload));
    fs.copyFileSync(opts.payload, payloadPath);
    log(`  真实安装包: ${payloadPath}`);
  } else {
    payloadPath = path.join(opts.out, 'payload.bin');
    fs.writeFileSync(payloadPath, Buffer.alloc(opts.sizeMb * 1024 * 1024));
    log(`  哑负载 ${opts.sizeMb}MB: ${payloadPath}`);
    log('  （不是合法安装器：客户端退出时那次静默安装会立刻失败，不会改动本机）');
  }

  // 2. 签名（Windows 必填；安卓不需要）
  let signature = null;
  if (opts.sign) {
    step('用内置密钥签名（Windows 客户端靠内置公钥验签）');
    if (!fs.existsSync(opts.keyPath)) {
      throw new Error(
        `找不到签名私钥: ${opts.keyPath}\n` +
          '  生成: pnpm tauri signer generate -w "$env:USERPROFILE\\.tauri\\marcel-update.key" --password "" --ci\n' +
          '  （生成后要把 .pub 的 base64 写进 src-tauri/src/updater/mod.rs 的 UPDATE_PUBKEY_B64 才能被现有客户端接受）\n' +
          '  只想测安卓/降级路径时可以加 --no-sign',
      );
    }
    const res = spawnSync(
      process.execPath,
      [TAURI_CLI, 'signer', 'sign', payloadPath],
      {
        cwd: REPO_ROOT,
        // inherit：不捕获子进程输出（避免管道 stdio 引发的权限问题），签名会写成 .sig 文件
        stdio: 'inherit',
        env: {
          ...process.env,
          TAURI_SIGNING_PRIVATE_KEY_PATH: opts.keyPath,
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
        },
      },
    );
    if (res.status !== 0) {
      throw new Error(`签名失败（exit ${res.status}）`);
    }
    const sigFile = `${payloadPath}.sig`;
    if (!fs.existsSync(sigFile)) {
      throw new Error(`签名命令没有产出 ${sigFile}`);
    }
    signature = fs.readFileSync(sigFile, 'utf8').trim();
    log(`  签名已写入 ${sigFile}`);
  } else {
    step('按 --no-sign 跳过签名');
  }

  // 3. 组装 latest.json（以仓库里那份为基底，保持另一平台字段真实）
  step('生成 latest.json');
  const latestPath = path.join(opts.out, 'latest.json');
  const sourceLatest = readJson(path.join(REPO_ROOT, 'latest.json'));
  const { sha256, size } = sha256AndSize(payloadPath);
  const latest = {
    ...sourceLatest, // android 对象的原值原样保留（「只发桌面」正是要测的场景）
    version,
    release_url:
      sourceLatest.release_url?.replace(/\/tag\/v[\d.]+$/, `/tag/v${version}`) ??
      `https://github.com/q541810/Marcel_ssh/releases/tag/v${version}`,
  };

  if (opts.assets) {
    latest.installer_url = `http://${opts.host === '0.0.0.0' ? lanAddress() ?? opts.host : opts.host}:${opts.port}/${path.basename(payloadPath)}`;
    latest.sha256 = opts.breakHash ? sha256.replace(/^./, sha256[0] === 'a' ? 'b' : 'a') : sha256;
    latest.size = size;
    if (signature) latest.signature = signature;
  } else {
    delete latest.installer_url;
    delete latest.signature;
    delete latest.sha256;
    delete latest.size;
  }

  if (opts.android) {
    if (!fs.existsSync(opts.android)) {
      throw new Error(`--android 文件不存在: ${opts.android}`);
    }
    const apkName = path.basename(opts.android);
    fs.copyFileSync(opts.android, path.join(opts.out, apkName));
    const apk = sha256AndSize(path.join(opts.out, apkName));
    latest.android = {
      ...(sourceLatest.android ?? {}),
      version,
      release_url: latest.release_url,
      installer_url: `http://${opts.host === '0.0.0.0' ? lanAddress() ?? opts.host : opts.host}:${opts.port}/${apkName}`,
      sha256: apk.sha256,
      size: apk.size,
    };
  }

  fs.writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
  log(`  ${latestPath}`);
  log(`  顶层 version=${version}${opts.assets ? ` sha256=${latest.sha256.slice(0, 12)}… size=${size}` : ' （无资产字段 → 客户端应降级为「仅提示」）'}`);
  if (latest.android) {
    log(`  android.version=${latest.android.version}（资产字段在 android 对象内）`);
  }

  // 4. 起服务
  const host = opts.host;
  const baseUrl = `http://${host === '0.0.0.0' ? lanAddress() ?? '127.0.0.1' : host}:${opts.port}`;
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
    const file = path.join(opts.out, name || 'latest.json');
    if (!file.startsWith(opts.out) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      log(`  [404] ${req.url}`);
      res.writeHead(404).end('not found');
      return;
    }
    const total = fs.statSync(file).size;
    log(
      `  [200] ${req.url} (${total} B${opts.slowMbps > 0 && file !== latestPath ? `, 限速 ${opts.slowMbps}MB/s` : ''})`,
    );
    res.writeHead(200, {
      'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'content-length': total,
    });

    // 限速只作用在更新包上：latest.json 要是也拖慢，客户端会卡在「检查更新」。
    if (opts.slowMbps > 0 && file !== latestPath) {
      const buf = fs.readFileSync(file);
      const chunkSize = 64 * 1024;
      const perChunkMs = Math.max(1, (chunkSize / (opts.slowMbps * 1024 * 1024)) * 1000);
      let offset = 0;
      const pump = () => {
        if (res.writableEnded || res.destroyed) return;
        const end = Math.min(offset + chunkSize, buf.length);
        res.write(buf.subarray(offset, end));
        offset = end;
        if (offset >= buf.length) {
          res.end();
          return;
        }
        setTimeout(pump, perChunkMs);
      };
      pump();
      return;
    }

    fs.createReadStream(file).pipe(res);
  });
  server.listen(opts.port, host, () => {
    step('测试源已就绪');
    log(`  更新源      : ${baseUrl}/latest.json`);
    log(`  工作目录    : ${opts.out}`);
    log(`  Windows 缓存: %LOCALAPPDATA%\\${APP_IDENTIFIER}\\update\\`);
    log('');
    log('  客户端（另开终端，从仓库根目录执行）：');
    log(`    $env:MARCEL_LATEST_JSON_URL="${baseUrl}/latest.json"; pnpm tauri dev`);
    log('');
    log('  观察点：');
    log('    1. 30 秒后（或 设置→关于→检查更新→后台下载）标题栏出现 ↓ 进度药丸');
    log('    2. 缓存目录出现 .part → 更新包 + pending.json，随后药丸变 ✓ 版本号');
    log('    3. 点开药丸应有「立即安装 / 稍后」及「稍后不取消安装」的说明');
    log('    4. 若要测「无更新」，把 --version 设成小于当前版本的值再重启服务');
    log('    5. 想看清「下载中」状态：加 --slow 2 --size 20（约 2MB/s，能看够 10 秒进度）');
    log('');
    if (host === '0.0.0.0') {
      log(`  安卓真机：手机浏览器先访问 ${baseUrl}/latest.json 确认通网；`);
      log('    注意 Android 9+ 默认禁明文 HTTP，实测可能需 https 或临时放行 cleartext。');
    }
    log('  结束时 Ctrl+C；清理：删 %LOCALAPPDATA%\\' + `${APP_IDENTIFIER}\\update 目录并清掉该环境变量`);
    log('  （否则客户端每次退出都会重试安装那个哑负载）');
  });
}

try {
  main();
} catch (err) {
  console.error(`\n[错误] ${err.message}\n`);
  process.exit(1);
}
