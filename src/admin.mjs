/**
 * 管理 Web 服务器(通道维护页)
 * ===========================
 * 仅绑定 127.0.0.1。提供:
 *   GET  /                        → 通道维护页(public/index.html)
 *   GET  /health                  → 健康检查(兼容旧接口)
 *   GET  /api/status              → 整体状态(含各通道)
 *   GET  /api/config              → 当前配置(密钥只回 true/false 是否已设置)
 *   POST /api/config              → 保存配置(写 .env;密钥留空=保持不变)
 *   POST /api/restart             → 优雅重启进程(detached 拉起新实例后退出,应用新配置)
 *   GET  /api/wechat/accounts     → 微信账号目录与账号列表
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');

// 密钥字段:GET 只回 xxxSet,POST 空值表示保持不变
const SECRET_FIELDS = new Set(['secret', 'clientSecret', 'appSecret']);

// 前端字段 → .env 键 映射
const ENV_MAP = {
  enabledChannels: 'ENABLED_CHANNELS',
  globalAllowlist: 'ALLOWLIST',
  workDir: 'WORK_DIR',
  wecom: { botId: 'WECOM_BOT_ID', secret: 'WECOM_BOT_SECRET', allowlist: 'WECOM_ALLOWLIST', allowChatIds: 'WECOM_ALLOW_CHATIDS' },
  dingtalk: { clientId: 'DINGTALK_CLIENT_ID', clientSecret: 'DINGTALK_CLIENT_SECRET', allowlist: 'DINGTALK_ALLOWLIST', allowChatIds: 'DINGTALK_ALLOW_CHATIDS' },
  wechat: { baseUrl: 'WECHAT_BASE_URL', accountsDir: 'WECHAT_ACCOUNTS_DIR', allowlist: 'WECHAT_ALLOWLIST', allowChatIds: 'WECHAT_ALLOW_CHATIDS' },
  feishu: { appId: 'FEISHU_APP_ID', appSecret: 'FEISHU_APP_SECRET', allowlist: 'FEISHU_ALLOWLIST', allowChatIds: 'FEISHU_ALLOW_CHATIDS' },
};

function readDotEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {}
  return out;
}

// 定向更新 .env 的若干键,保留其余行/注释
function writeDotEnv(updates) {
  const p = path.join(PROJECT_DIR, '.env');
  let lines = [];
  try { lines = fs.readFileSync(p, 'utf8').split(/\r?\n/); } catch {}
  const keySet = new Set(Object.keys(updates));
  const written = new Set();
  const result = lines.map((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m && keySet.has(m[1])) {
      written.add(m[1]);
      return m[1] + '=' + updates[m[1]];
    }
    return line;
  });
  for (const k of keySet) if (!written.has(k)) result.push(k + '=' + updates[k]);
  fs.writeFileSync(p, result.join('\n') + '\n', 'utf8');
}

function buildConfigView() {
  const env = readDotEnv();
  const view = {
    enabledChannels: env.ENABLED_CHANNELS || 'wecom',
    globalAllowlist: env.ALLOWLIST || '',
    workDir: env.WORK_DIR || '',
    channels: {},
  };
  for (const [name, fieldMap] of Object.entries(ENV_MAP)) {
    if (!fieldMap || typeof fieldMap === 'string') continue;
    const fields = {};
    for (const [field, key] of Object.entries(fieldMap)) {
      if (SECRET_FIELDS.has(field)) fields[field + 'Set'] = !!env[key];
      else fields[field] = env[key] ?? '';
    }
    view.channels[name] = fields;
  }
  return view;
}

function applyConfig(body) {
  const updates = {};
  if (typeof body.enabledChannels === 'string') updates.ENABLED_CHANNELS = body.enabledChannels.trim();
  if (typeof body.globalAllowlist === 'string') updates.ALLOWLIST = body.globalAllowlist.trim();
  if (typeof body.workDir === 'string' && body.workDir.trim()) updates.WORK_DIR = body.workDir.trim();
  for (const [name, fieldMap] of Object.entries(ENV_MAP)) {
    if (!fieldMap || typeof fieldMap === 'string') continue;
    const ch = body.channels?.[name];
    if (!ch || typeof ch !== 'object') continue;
    for (const [field, key] of Object.entries(fieldMap)) {
      const v = ch[field];
      if (v === undefined || v === null) continue;
      if (SECRET_FIELDS.has(field)) {
        if (v) updates[key] = v; // 密钥:仅填了新值才覆盖,留空保持不变
      } else {
        updates[key] = String(v).trim();
      }
    }
  }
  writeDotEnv(updates);
  return Object.keys(updates).length;
}

function restartBridge() {
  fs.mkdirSync(path.join(PROJECT_DIR, 'logs'), { recursive: true });
  const logFd = fs.openSync(path.join(PROJECT_DIR, 'logs', 'bridge.log'), 'a');
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'bridge.mjs'], {
    cwd: PROJECT_DIR, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
  });
  child.unref();
  setTimeout(() => process.exit(0), 150); // 先回响应,再退出;新实例随即接管端口
}

function wechatAccounts() {
  const dir = cfg.channels.wechat.accountsDir || path.join(PROJECT_DIR, 'wechat-accounts');
  let accounts = [];
  try {
    accounts = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.includes('context-tokens'))
      .map((f) => f.replace('.json', ''));
  } catch {}
  return { accountsDir: dir, accounts };
}

let cfg = null;

export function startAdminServer({ cfg: _cfg, core, model, agentLabel, port }) {
  cfg = _cfg;
  const START_TIME = Date.now();

  function healthPayload() {
    const ch = core.status();
    return {
      status: Object.values(ch).every((s) => s === 'connected') ? 'connected' : 'degraded',
      channels: ch,
      agent: agentLabel,
      model,
      queueDepth: core.queue.depth,
      running: core.queue.running,
      uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const sendJson = (obj, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };

    try {
      // 静态页
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && (p === '/health' || p === '/api/status')) {
        sendJson(healthPayload());
        return;
      }
      if (req.method === 'GET' && p === '/api/config') {
        sendJson(buildConfigView());
        return;
      }
      if (req.method === 'POST' && p === '/api/config') {
        const body = JSON.parse(await readBody(req));
        const applied = applyConfig(body);
        sendJson({ ok: true, applied });
        return;
      }
      if (req.method === 'POST' && p === '/api/restart') {
        sendJson({ ok: true, message: 'restarting' });
        restartBridge();
        return;
      }
      if (req.method === 'GET' && p === '/api/wechat/accounts') {
        sendJson(wechatAccounts());
        return;
      }
      sendJson({ ok: false, error: 'not found' }, 404);
    } catch (err) {
      sendJson({ ok: false, error: err.message }, 500);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[admin] 端口 ' + port + ' 已被占用,疑似另一个实例在运行,退出');
      process.exit(1);
    }
    console.error('[admin] 监听失败: ' + err.message);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log('[admin] 管理页: http://127.0.0.1:' + port + '/');
  });
  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data || '{}'));
    req.on('error', reject);
  });
}
