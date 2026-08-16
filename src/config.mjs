/**
 * 配置加载模块
 * =============
 * 优先级:CLI 参数 --key=value > 真实环境变量 > .env 文件 > 默认值。
 * 模型认证:ANTHROPIC_* 兜底读 ~/.claude/settings.json 的 env 块。
 *
 * 多通道:ENABLED_CHANNELS 决定启动时启用哪些通道;reloadConfig() 支持运行时
 * 重读 .env(用于维护页保存配置后动态启用/停用通道)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(BRIDGE_DIR, '..');

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

function splitList(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// ── 读取 .env 文件(每次调用都重新读,支持运行时重载)──
function readDotEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(PROJECT_DIR, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) {
        let val = m[2].trim();
        if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
          val = val.slice(1, -1);
        }
        out[m[1]] = val;
      }
    }
  } catch {}
  return out;
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

// 构建 CFG:CLI > 真实环境变量 > .env 文件 > 默认值
function buildConfig() {
  const envFile = readDotEnvFile();
  const pick = (cliKey, envKey, fallback = '') => CLI[cliKey] || process.env[envKey] || envFile[envKey] || fallback;
  const pickInt = (cliKey, envKey, fallback) => parseInt(pick(cliKey, envKey, String(fallback)), 10);

  const defaultRolePrompt = [
    '你是一个连接 IM 平台(企业微信/钉钉/微信/飞书)与 Claude Code 的桥接助手,',
    '运行在用户指定的项目工作目录中,通过 IM 消息接收用户指令并执行。',
    '工作准则:',
    '1. 回复使用中文,简洁直接,先给结论再给细节。',
    '2. 修改文件前先简述将要执行的操作。',
    '3. 执行破坏性操作(删除、覆盖、强推等)前先说明风险。',
    '4. 禁止读取或修改桥接进程自身目录及其 .env 配置文件。',
    '5. 用户附件保存在 inbox/ 目录中,按需读取。',
  ].join('\n');

  return {
    enabledChannels: splitList(pick('', 'ENABLED_CHANNELS') || 'wecom'),
    globalAllowlist: splitList(pick('', 'ALLOWLIST')),

    channels: {
      wechat: {
        baseUrl: pick('', 'WECHAT_BASE_URL') || 'https://ilinkai.weixin.qq.com',
        accountsDir: pick('', 'WECHAT_ACCOUNTS_DIR'),
        open: pick('', 'WECHAT_OPEN') !== '0', // 微信个人号默认开放
        allowlist: splitList(pick('', 'WECHAT_ALLOWLIST')),
        allowChatIds: splitList(pick('', 'WECHAT_ALLOW_CHATIDS')),
      },
      wecom: {
        botId: pick('bot-id', 'WECOM_BOT_ID'),
        secret: pick('secret', 'WECOM_BOT_SECRET'),
        allowlist: splitList(pick('', 'WECOM_ALLOWLIST')),
        allowChatIds: splitList(pick('', 'WECOM_ALLOW_CHATIDS')),
      },
      feishu: {
        appId: pick('', 'FEISHU_APP_ID'),
        appSecret: pick('', 'FEISHU_APP_SECRET'),
        allowlist: splitList(pick('', 'FEISHU_ALLOWLIST')),
        allowChatIds: splitList(pick('', 'FEISHU_ALLOW_CHATIDS')),
      },
      dingtalk: {
        clientId: pick('client-id', 'DINGTALK_CLIENT_ID'),
        clientSecret: pick('client-secret', 'DINGTALK_CLIENT_SECRET'),
        allowlist: splitList(pick('', 'DINGTALK_ALLOWLIST')),
        allowChatIds: splitList(pick('', 'DINGTALK_ALLOW_CHATIDS')),
      },
    },

    workDir: pick('work-dir', 'WORK_DIR') || path.resolve(PROJECT_DIR, '..'),
    permissionMode: pick('', 'PERMISSION_MODE') || 'acceptEdits',
    systemPrompt: pick('', 'SYSTEM_PROMPT') || defaultRolePrompt,
    bridgePort: pickInt('port', 'BRIDGE_PORT', 18794),
    maxConcurrent: pickInt('', 'MAX_CONCURRENT', 3),
    queueMaxDepth: pickInt('', 'QUEUE_MAX_DEPTH', 5),
    timeoutMs: pickInt('', 'AGENT_TIMEOUT_MS', 180000),
    maxTurns: pickInt('', 'MAX_TURNS', 40),
    maxReplyBytes: 18000,
  };
}

export const CFG = buildConfig();

/** 运行时重读 .env 得到新配置(用于维护页保存后动态启用/停用通道) */
export function reloadConfig() {
  return buildConfig();
}

// 模型认证:真实环境变量/.env 优先,settings.json 兜底;只透传 ANTHROPIC_* 键
function resolveAnthropicEnv() {
  const envFile = readDotEnvFile();
  const merged = readAnthropicFromUserSettings();
  for (const src of [envFile, process.env]) {
    for (const [k, v] of Object.entries(src)) {
      if (k.startsWith('ANTHROPIC_') && typeof v === 'string' && v) merged[k] = v;
    }
  }
  return merged;
}

export const anthropicEnv = resolveAnthropicEnv();
export const model = anthropicEnv.ANTHROPIC_MODEL || 'deepseek-v4-flash[1M]';
