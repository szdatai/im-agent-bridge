#!/usr/bin/env node
/**
 * 企业微信 ↔ Claude Code 双向通道桥接进程(唯一入口)
 * ====================================================
 * 企微长连接消息 → Claude Code 无头 agent(query(),cwd=WORK_DIR)→ 一次性回复企微。
 *
 * 用法:
 *   node --env-file-if-exists=.env bridge.mjs
 *   node bridge.mjs --bot-id=xxx --secret=xxx
 *
 * 环境变量说明见 .env.example;模型凭据缺失时兜底读 ~/.claude/settings.json。
 */
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { CFG, anthropicEnv, model } from './src/config.mjs';
import { askClaude, cleanAiResponse, truncateUtf8 } from './src/claude.mjs';
import { BridgeQueue } from './src/queue.mjs';
import { startHealthServer } from './src/health.mjs';
import { ensureGlobalAutoStart } from './src/autoregister.mjs';

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INBOX_DIR = path.join(BRIDGE_DIR, 'inbox');

// ── 启动校验 ──
if (!CFG.botId || !CFG.secret) {
  console.error('[bridge] 缺少 WECOM_BOT_ID / WECOM_BOT_SECRET(请填写 .env)');
  console.error('[bridge] 获取方式: 企业微信后台 → 智能机器人 → API 模式 → 长连接');
  process.exit(1);
}
if (!CFG.allowlist.length) {
  console.warn('[bridge] WECOM_ALLOWLIST 为空 → 处于白名单模式,将忽略所有消息');
}
if (!anthropicEnv.ANTHROPIC_BASE_URL || !anthropicEnv.ANTHROPIC_AUTH_TOKEN) {
  console.warn('[bridge] 未检测到 ANTHROPIC_BASE_URL/AUTH_TOKEN(已读 settings.json 兜底?若仍为空,agent 将无法连接模型)');
}

fs.mkdirSync(INBOX_DIR, { recursive: true });

// 自注册全局自动启动 hook:首次启动时把 SessionStart hook 写入 ~/.claude/settings.json,
// 此后任意目录启动 Claude Code 都会自动拉起 bridge(幂等,失败不影响运行)
ensureGlobalAutoStart()
  .then((r) => console.log('[bridge] 自动启动自注册: ' + r.reason))
  .catch((err) => console.warn('[bridge] 自动启动自注册失败(不影响运行): ' + err.message));

const AGENT_LABEL = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(BRIDGE_DIR, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')
    );
    return 'claude-agent-sdk@' + pkg.version;
  } catch {
    return 'claude-agent-sdk';
  }
})();

const START_TIME = Date.now();
const activeAborts = new Set();

// ── 附件暂存:image/file 与后续 text 是两条消息,先落盘再配对 ──
const pendingFiles = new Map();
const PENDING_FILE_TTL_MS = 30000;

function getPendingFile(senderId) {
  const entry = pendingFiles.get(senderId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > PENDING_FILE_TTL_MS) {
    pendingFiles.delete(senderId);
    return null;
  }
  return entry;
}

function setPendingFile(senderId, filePath, fileName) {
  pendingFiles.set(senderId, { filePath, fileName, timestamp: Date.now() });
}

function sanitize(name) {
  return String(name).replace(/[^\w.-]/g, '_').slice(0, 64) || 'unknown';
}

function saveToInbox(buffer, senderId, ext) {
  const dir = path.join(INBOX_DIR, sanitize(senderId));
  fs.mkdirSync(dir, { recursive: true });
  const name = Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8) + '.' + ext;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// ── 白名单(fail-closed:空列表=不响应任何人,与启动警告一致)──
function isAllowed(senderId, chatId) {
  if (!CFG.allowlist.length) return false;
  if (!CFG.allowlist.includes(senderId)) return false;
  if (CFG.allowChatIds.length && chatId && !CFG.allowChatIds.includes(chatId)) return false;
  return true;
}

// ── 组装 prompt(附件给出相对工作目录的路径)──
function buildPrompt(content, attachment) {
  if (!attachment) return content;
  let rel = path.relative(CFG.workDir, attachment.filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) rel = attachment.filePath;
  return content + '\n\n[附件已保存到: ' + rel + '。请根据需求读取并处理该附件。]';
}

// ── 队列与任务执行 ──
const queue = new BridgeQueue({
  maxConcurrent: CFG.maxConcurrent,
  maxDepth: CFG.queueMaxDepth,
  onTask: processTask,
});

async function processTask(task) {
  const { frame, prompt } = task;
  const ac = new AbortController();
  activeAborts.add(ac);
  try {
    const raw = await askClaude(prompt, {
      cwd: CFG.workDir,
      model,
      permissionMode: CFG.permissionMode,
      maxTurns: CFG.maxTurns,
      timeoutMs: CFG.timeoutMs,
      additionalDirectories: [INBOX_DIR],
      systemPrompt: CFG.systemPrompt,
      anthropicEnv,
      abortController: ac,
    });
    const reply = truncateUtf8(cleanAiResponse(raw), CFG.maxReplyBytes);
    console.log('[bridge] 回复: ' + reply.slice(0, 60) + '...');
    await replyToFrame(frame, reply);
  } finally {
    activeAborts.delete(ac);
  }
}

// ── 企微接入 ──
let client = null;
let isConnected = false;

// 回复带简单重试(断线期间 SDK 会自动重连,~15s/3 次)
async function replyToFrame(frame, content) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!client) return;
    try {
      await client.replyStream(frame, generateReqId('stream'), content, true);
      return;
    } catch (err) {
      if (attempt === 3) {
        console.error('[bridge] 回复失败(重试 3 次后放弃): ' + err.message);
        return;
      }
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

function startBridge() {
  console.log('[bridge] 正在连接企业微信 (BotID: ' + CFG.botId.slice(0, 8) + '...)');
  console.log('[bridge] 工作目录: ' + CFG.workDir);
  console.log('[bridge] 模型: ' + model);
  console.log('[bridge] 权限模式: ' + CFG.permissionMode);
  console.log('[bridge] 白名单用户: ' + (CFG.allowlist.join(', ') || '(空)'));

  client = new WSClient({
    botId: CFG.botId,
    secret: CFG.secret,
    logger: {
      debug: () => {},
      info: (msg) => console.log('[wecom] ' + msg),
      warn: (msg) => console.warn('[wecom] ' + msg),
      error: (msg) => console.error('[wecom] ' + msg),
    },
  });

  client.on('connected', () => console.log('[bridge] WebSocket 已连接'));
  client.on('authenticated', () => {
    isConnected = true;
    console.log('[bridge] 认证成功,开始接收消息');
  });
  client.on('disconnected', (reason) => {
    isConnected = false;
    console.log('[bridge] 连接断开: ' + reason);
  });
  client.on('reconnecting', (attempt) => console.log('[bridge] 重连中 (第 ' + attempt + ' 次)'));
  client.on('error', (err) => console.error('[bridge] 错误: ' + err.message));

  // ── 文本消息:核心入口 ──
  client.on('message.text', async (frame) => {
    const content = frame.body?.text?.content || '';
    const senderId = frame.body?.from?.userid || 'unknown';
    const chatId = frame.body?.chatid || frame.body?.chat_id || '';
    const chatType = frame.body?.chattype || 'single';
    if (!content) return;
    if (!isAllowed(senderId, chatId)) {
      console.log('[bridge] 忽略非白名单消息 from ' + senderId + (chatId ? ' (chat ' + chatId + ')' : ''));
      return;
    }

    // 配对 30s 内的附件
    let attachment = null;
    const pending = getPendingFile(senderId);
    if (pending) {
      attachment = { filePath: pending.filePath, fileName: pending.fileName };
      pendingFiles.delete(senderId);
    }

    const prompt = buildPrompt(content, attachment);
    console.log('[bridge] 排队任务 from ' + senderId + ' (' + chatType + '): ' + content.slice(0, 60) + (attachment ? ' (+附件)' : ''));
    const dropped = queue.enqueue(senderId, { frame, prompt });
    for (const d of dropped) await replyToFrame(d.frame, '任务较多,请稍后重试');
  });

  // ── 图片/文件:解密落盘 inbox/,等待后续 text 配对 ──
  async function stashAttachment(frame, kind) {
    const senderId = frame.body?.from?.userid || 'unknown';
    const chatId = frame.body?.chatid || frame.body?.chat_id || '';
    if (!isAllowed(senderId, chatId)) return;
    const url = kind === 'image' ? frame.body?.image?.url : frame.body?.file?.url;
    const aesKey = kind === 'image' ? frame.body?.image?.aeskey : frame.body?.file?.aeskey;
    const name = kind === 'image'
      ? (frame.body?.image?.name || 'image.jpg')
      : (frame.body?.file?.name || 'file.bin');
    if (!url) return;
    try {
      const { buffer, filename } = await client.downloadFile(url, aesKey);
      const ext = path.extname(filename || name).replace(/^\./, '') || (kind === 'image' ? 'jpg' : 'bin');
      const filePath = saveToInbox(buffer, senderId, ext);
      setPendingFile(senderId, filePath, filename || name);
      console.log('[bridge] 附件已暂存 from ' + senderId + ': ' + (filename || name) + ' → ' + path.basename(filePath) + ' (30s 内等指令配对)');
    } catch (err) {
      console.error('[bridge] ' + kind + ' 处理失败: ' + err.message);
    }
  }
  client.on('message.image', (frame) => stashAttachment(frame, 'image'));
  client.on('message.file', (frame) => stashAttachment(frame, 'file'));

  // ── 用户进入会话(欢迎语)──
  client.on('event.enter_chat', async (frame) => {
    console.log('[bridge] 用户进入会话');
    try {
      await client.replyWelcome(frame, {
        msgtype: 'text',
        text: { content: '您好!我已连接 Claude Code,可在此发送指令或文件。' },
      });
    } catch (err) {
      console.error('[bridge] 发送欢迎语失败: ' + err.message);
    }
  });

  client.connect();
  console.log('[bridge] Bridge 已启动');
}

// ── 健康检查 ──
startHealthServer(CFG.bridgePort, () => ({
  status: isConnected ? 'connected' : 'disconnected',
  botId: CFG.botId ? CFG.botId.slice(0, 8) + '...' : '(未配置)',
  agent: AGENT_LABEL,
  model,
  queueDepth: queue.depth,
  running: queue.running,
  uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
}));

// ── 启动 ──
startBridge();

// ── 优雅退出 ──
function shutdown(signal) {
  console.log('[bridge] 收到 ' + signal + ',正在关闭...');
  for (const ac of activeAborts) ac.abort();
  if (client) client.disconnect();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
