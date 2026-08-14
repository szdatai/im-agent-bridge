/**
 * 自动启动守卫脚本
 * =================
 * 由 Claude Code 的 SessionStart hook 调用(挂在项目 .claude/settings.local.json):
 *   - 若 bridge 已在运行(健康检查端口可达)则直接退出,什么都不做;
 *   - 否则在后台(detached)拉起 bridge,日志写入 logs/bridge.log,然后立即退出。
 *
 * 这样每次启动 Claude Code 时自动确保 bridge 在线,且不会重复启动、不会阻塞会话。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_PORT = readEnvInt('BRIDGE_PORT', 18794);

function readEnvInt(key, def) {
  try {
    const raw = fs.readFileSync(path.join(BRIDGE_DIR, '.env'), 'utf8');
    const m = raw.match(new RegExp('^' + key + '=(\\d+)', 'm'));
    if (m) return parseInt(m[1], 10);
  } catch {}
  return def;
}

// 端口可达 = bridge 已在运行
function isRunning() {
  return new Promise((resolve) => {
    const sock = net.connect(BRIDGE_PORT, '127.0.0.1');
    sock.setTimeout(1200);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });
}

if (await isRunning()) {
  console.log('[autostart] bridge 已在运行(端口 ' + BRIDGE_PORT + '),跳过');
  process.exit(0);
}

// 后台拉起(detached,不随本会话退出;stdout/stderr 落日志)
fs.mkdirSync(path.join(BRIDGE_DIR, 'logs'), { recursive: true });
const logFd = fs.openSync(path.join(BRIDGE_DIR, 'logs', 'bridge.log'), 'a');
const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'bridge.mjs'], {
  cwd: BRIDGE_DIR,
  detached: true,
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
});
child.unref();
console.log('[autostart] bridge 已后台启动 (pid ' + child.pid + ')');
