/**
 * 多通道核心编排模块
 * ===================
 * 所有 IM 通道共用的部分:白名单(fail-closed)、附件配对(30s TTL)、
 * 队列(每 通道+会话 串行 + 全局并发上限)、调 agent、一次性回复。
 *
 * 通道模块约定:每个通道导出 `createChannel({ cfg, core })`,返回
 *   { name, enabled, start(), stop(), status() }
 * 通道收到消息后调用 `core.handleMessage(msg)`:
 *   msg = { channel, senderId, chatId, chatType, text,
 *           attachment: {filePath,fileName}|null,
 *           reply(content), ack?(), log?(msg) }
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BridgeQueue } from './queue.mjs';
import { askClaude, cleanAiResponse, truncateUtf8 } from './claude.mjs';

const PENDING_FILE_TTL_MS = 30000;

export function createCore({ cfg, anthropicEnv, model, inboxDir }) {
  const pendingFiles = new Map(); // key = channel:senderId
  const activeAborts = new Set();
  const channels = new Map();

  const queue = new BridgeQueue({
    maxConcurrent: cfg.maxConcurrent,
    maxDepth: cfg.queueMaxDepth,
    onTask: processTask,
  });

  const keyOf = (ch, sender) => ch + ':' + sender;

  function sanitize(s) {
    return String(s).replace(/[^\w.-]/g, '_').slice(0, 64) || 'unknown';
  }

  // ── 附件落盘 inbox/<sender>/<随机名> ──
  // makeInboxPath:仅生成路径(供 writeFile(filePath) 型下载,如飞书 messageResource)
  // saveToInbox:生成路径并写入 buffer(供 downloadFile 型下载,如企微/钉钉/微信)
  function makeInboxPath(senderId, ext) {
    const dir = path.join(inboxDir, sanitize(senderId));
    fs.mkdirSync(dir, { recursive: true });
    const name = Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8) + '.' + ext;
    return path.join(dir, name);
  }

  function saveToInbox(buffer, senderId, ext) {
    const filePath = makeInboxPath(senderId, ext);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }

  // ── 白名单:通道自己的列表优先,否则全局,再否则 fail-closed ──
  function effectiveAllowlist(channelName) {
    const per = cfg.channels[channelName]?.allowlist;
    if (per && per.length) return per;
    return cfg.globalAllowlist;
  }

  function isAllowed(channelName, senderId, chatId) {
    const al = effectiveAllowlist(channelName);
    if (!al.length) return false;
    if (!al.includes(senderId)) return false;
    const cl = cfg.channels[channelName]?.allowChatIds || [];
    if (cl.length && chatId && !cl.includes(chatId)) return false;
    return true;
  }

  // ── 附件暂存/配对 ──
  function getPendingFile(channelName, senderId) {
    const k = keyOf(channelName, senderId);
    const entry = pendingFiles.get(k);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > PENDING_FILE_TTL_MS) {
      pendingFiles.delete(k);
      return null;
    }
    return entry;
  }

  function stashAttachment(channelName, senderId, filePath, fileName) {
    pendingFiles.set(keyOf(channelName, senderId), { filePath, fileName, timestamp: Date.now() });
  }

  function buildPrompt(content, attachment) {
    if (!attachment) return content;
    let rel = path.relative(cfg.workDir, attachment.filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) rel = attachment.filePath;
    return content + '\n\n[附件已保存到: ' + rel + '。请根据需求读取并处理该附件。]';
  }

  // ── 队列任务:调 agent → 清理 → 截断 → 一次性回复 ──
  async function processTask(task) {
    const { msg, prompt } = task;
    const ac = new AbortController();
    activeAborts.add(ac);
    try {
      const raw = await askClaude(prompt, {
        cwd: cfg.workDir,
        model,
        permissionMode: cfg.permissionMode,
        maxTurns: cfg.maxTurns,
        timeoutMs: cfg.timeoutMs,
        additionalDirectories: [inboxDir],
        systemPrompt: cfg.systemPrompt,
        anthropicEnv,
        abortController: ac,
      });
      const reply = truncateUtf8(cleanAiResponse(raw), cfg.maxReplyBytes);
      (msg.log || console.log)('[' + msg.channel + '] 回复: ' + reply.slice(0, 60) + '...');
      await msg.reply(reply);
      if (msg.ack) {
        try { await msg.ack(); } catch (e) { console.error('[' + msg.channel + '] ack 失败: ' + e.message); }
      }
    } finally {
      activeAborts.delete(ac);
    }
  }

  async function handleMessage(msg) {
    const { channel, senderId, chatId, text } = msg;
    const log = msg.log || ((m) => console.log('[' + channel + '] ' + m));

    if (!isAllowed(channel, senderId, chatId)) {
      log('忽略非白名单消息 from ' + senderId + (chatId ? ' (chat ' + chatId + ')' : ''));
      return;
    }

    // 若未带附件,尝试配对 30s 内暂存的附件
    let attachment = msg.attachment || null;
    if (!attachment) {
      const pending = getPendingFile(channel, senderId);
      if (pending) {
        attachment = { filePath: pending.filePath, fileName: pending.fileName };
        pendingFiles.delete(keyOf(channel, senderId));
      }
    }

    const prompt = buildPrompt(text, attachment);
    log('排队任务 from ' + senderId + ' (' + (msg.chatType || 'single') + '): ' + text.slice(0, 60) + (attachment ? ' (+附件)' : ''));
    const dropped = queue.enqueue(keyOf(channel, senderId), { msg, prompt });
    for (const d of dropped) await d.msg.reply('任务较多,请稍后重试');
  }

  // ── 通道注册与生命周期 ──
  function register(channel) {
    channels.set(channel.name, channel);
  }

  async function start() {
    for (const ch of channels.values()) {
      try {
        await ch.start();
        console.log('[core] 通道 ' + ch.name + ' 已启动');
      } catch (e) {
        console.error('[core] 通道 ' + ch.name + ' 启动失败: ' + e.message);
      }
    }
  }

  function stop() {
    for (const ac of activeAborts) ac.abort();
    for (const ch of channels.values()) {
      try { ch.stop(); } catch {}
    }
  }

  function status() {
    const per = {};
    for (const ch of channels.values()) per[ch.name] = ch.status ? ch.status() : 'unknown';
    return per;
  }

  return {
    cfg,
    saveToInbox,
    makeInboxPath,
    stashAttachment,
    isAllowed,
    handleMessage,
    register,
    start,
    stop,
    status,
    channels,
    queue,
    activeAborts,
  };
}
