/**
 * 配置加载模块
 * =============
 * 优先级:CLI 参数 --key=value > 环境变量(.env / shell)> 默认值。
 * 模型认证:ANTHROPIC_* 优先取环境变量,兜底读 ~/.claude/settings.json 的 env 块;
 * 仅透传 ANTHROPIC_* 前缀键,避免把无关 token 泄给子进程。
 *
 * 多通道:ENABLED_CHANNELS 决定启用哪些通道(wecom/dingtalk/wechat/feishu),
 * 各通道凭据与白名单见 CFG.channels。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(BRIDGE_DIR, '..');

// ── 显式加载本目录 .env(与 cwd 无关;真实环境变量优先,不覆盖)──
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

// .env / shell 优先,settings.json 兜底;只透传 ANTHROPIC_* 键
function resolveAnthropicEnv() {
  const merged = readAnthropicFromUserSettings();
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ANTHROPIC_') && v) merged[k] = v;
  }
  return merged;
}

// 默认角色框架(SYSTEM_PROMPT 可覆盖)
const DEFAULT_ROLE_PROMPT = [
  '你是一个连接 IM 平台(企业微信/钉钉/微信/飞书)与 Claude Code 的桥接助手,',
  '运行在用户指定的项目工作目录中,通过 IM 消息接收用户指令并执行。',
  '工作准则:',
  '1. 回复使用中文,简洁直接,先给结论再给细节。',
  '2. 修改文件前先简述将要执行的操作。',
  '3. 执行破坏性操作(删除、覆盖、强推等)前先说明风险。',
  '4. 禁止读取或修改桥接进程自身目录及其 .env 配置文件。',
  '5. 用户附件保存在 inbox/ 目录中,按需读取。',
].join('\n');

export const CFG = {
  // ── 通道启用与全局白名单 ──
  enabledChannels: splitList(process.env.ENABLED_CHANNELS || 'wecom'),
  globalAllowlist: splitList(process.env.ALLOWLIST),

  // ── 各通道凭据与白名单(通道自己的白名单优先,无则回落全局 ALLOWLIST)──
  channels: {
    wecom: {
      botId: pick('bot-id', process.env.WECOM_BOT_ID || ''),
      secret: pick('secret', process.env.WECOM_BOT_SECRET || ''),
      allowlist: splitList(process.env.WECOM_ALLOWLIST),
      allowChatIds: splitList(process.env.WECOM_ALLOW_CHATIDS),
    },
    dingtalk: {
      clientId: pick('client-id', process.env.DINGTALK_CLIENT_ID || ''),
      clientSecret: pick('client-secret', process.env.DINGTALK_CLIENT_SECRET || ''),
      allowlist: splitList(process.env.DINGTALK_ALLOWLIST),
      allowChatIds: splitList(process.env.DINGTALK_ALLOW_CHATIDS),
    },
    wechat: {
      baseUrl: process.env.WECHAT_BASE_URL || 'https://ilinkai.weixin.qq.com',
      accountsDir: process.env.WECHAT_ACCOUNTS_DIR || '',
      allowlist: splitList(process.env.WECHAT_ALLOWLIST),
      allowChatIds: splitList(process.env.WECHAT_ALLOW_CHATIDS),
    },
    feishu: {
      appId: process.env.FEISHU_APP_ID || '',
      appSecret: process.env.FEISHU_APP_SECRET || '',
      allowlist: splitList(process.env.FEISHU_ALLOWLIST),
      allowChatIds: splitList(process.env.FEISHU_ALLOW_CHATIDS),
    },
  },

  // ── agent 与运行参数 ──
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
