/**
 * 配置加载模块
 * =============
 * 优先级:CLI 参数 --key=value > 环境变量(.env / shell)> 默认值。
 * 模型认证:ANTHROPIC_* 优先取环境变量,兜底读 ~/.claude/settings.json 的 env 块;
 * 仅透传 ANTHROPIC_* 前缀键,避免把无关 token 泄给子进程。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(BRIDGE_DIR, '..');

// ── 显式加载本目录 .env(与 cwd 无关;真实环境变量优先,不覆盖)──
// 这样无论从哪个目录启动 bridge.mjs 都能自动找到自己的 .env。
function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* .env 不存在则纯依赖环境变量 */
  }
}
loadDotEnv();

// ── CLI 参数 (--key=value) ──
function parseCli() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const CLI = parseCli();

function pick(key, fallback = '') {
  return CLI[key] || process.env[key] || fallback;
}

function splitList(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// ── 从 ~/.claude/settings.json 读取 ANTHROPIC_* env 块(兜底)──
function readAnthropicFromUserSettings() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(data?.env || {})) {
      if (k.startsWith('ANTHROPIC_') && typeof v === 'string' && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// .env(经 --env-file 注入)/shell 优先,settings.json 兜底;只透传 ANTHROPIC_* 键
function resolveAnthropicEnv() {
  const merged = readAnthropicFromUserSettings();
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ANTHROPIC_') && v) merged[k] = v;
  }
  return merged;
}

// 默认角色框架(SYSTEM_PROMPT 可覆盖)
const DEFAULT_ROLE_PROMPT = [
  '你是一个连接企业微信与 Claude Code 的桥接助手,运行在用户指定的项目工作目录中,通过企业微信接收用户指令并执行。',
  '工作准则:',
  '1. 回复使用中文,简洁直接,先给结论再给细节。',
  '2. 修改文件前先简述将要执行的操作。',
  '3. 执行破坏性操作(删除、覆盖、强推等)前先说明风险。',
  '4. 禁止读取或修改桥接进程自身目录(默认名 wecom-claude-bridge/)及其 .env 配置文件。',
  '5. 用户附件保存在 inbox/ 目录中,按需读取。',
].join('\n');

export const CFG = {
  botId: pick('bot-id', process.env.WECOM_BOT_ID || ''),
  secret: pick('secret', process.env.WECOM_BOT_SECRET || ''),
  allowlist: splitList(process.env.WECOM_ALLOWLIST),
  allowChatIds: splitList(process.env.WECOM_ALLOW_CHATIDS),
  // WORK_DIR 留空默认取桥接项目的父目录(即「把本子项目放在目标仓库内」的用法)
  workDir: pick('work-dir', process.env.WORK_DIR) || path.resolve(PROJECT_DIR, '..'),
  permissionMode: process.env.PERMISSION_MODE || 'acceptEdits',
  systemPrompt: process.env.SYSTEM_PROMPT || DEFAULT_ROLE_PROMPT,
  bridgePort: parseInt(pick('port', process.env.BRIDGE_PORT || '18794'), 10),
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '3', 10),
  queueMaxDepth: parseInt(process.env.QUEUE_MAX_DEPTH || '5', 10),
  timeoutMs: parseInt(process.env.AGENT_TIMEOUT_MS || '180000', 10),
  maxTurns: parseInt(process.env.MAX_TURNS || '40', 10),
  maxReplyBytes: 18000,
};

export const anthropicEnv = resolveAnthropicEnv();

export const model = anthropicEnv.ANTHROPIC_MODEL || 'deepseek-v4-flash[1M]';
