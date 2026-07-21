/**
 * Run Tauri dev with mobile UI forced.
 *
 * Why: `pnpm tauri dev` loads devUrl without ?platform=, so the app window
 * always gets the desktop shell unless VITE_FORCE_PLATFORM is set.
 *
 * Note: project path may contain spaces (e.g. "Marcel SSH") — never use
 * shell:true with unquoted path args.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let tauriCli;
try {
  tauriCli = require.resolve('@tauri-apps/cli/tauri.js', { paths: [root] });
} catch {
  tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
}

const mobileConfig = path.join(root, 'scripts', 'tauri.mobile.dev.json');

process.env.VITE_FORCE_PLATFORM = 'mobile';

const child = spawn(
  process.execPath,
  [tauriCli, 'dev', '--config', mobileConfig],
  {
    stdio: 'inherit',
    shell: false,
    env: process.env,
    cwd: root,
  },
);

child.on('error', (err) => {
  console.error('[tauri:dev:mobile] failed to start:', err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
