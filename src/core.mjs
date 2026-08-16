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

export function createCore({ cfg: initialCfg, anthropicEnv, model, inboxDir, channelFactories = {}, reloadConfig }) {
  let cfg = initialCfg; // 可运行时重载(维护页保存配置后)
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
    const openDefault = cfg.channels[channelName]?.open === true; // 如微信个人号默认开放
    if (!al.length && !openDefault) return false; // 无白名单且非默认开放 → fail-closed
    if (al.length && !al.includes(senderId)) return false; // 有白名单则严格限制
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
      // 回复统一带 [HH:MM] 时间戳(与推送一致)
      const ts = new Date();
      const hhmm = String(ts.getHours()).padStart(2, '0') + ':' + String(ts.getMinutes()).padStart(2, '0');
      const reply = '[' + hhmm + '] ' + truncateUtf8(cleanAiResponse(raw), cfg.maxReplyBytes);
      (msg.log || console.log)('[' + msg.channel + '] 回复: ' + reply.slice(0, 60) + '...');
      await msg.reply(reply);
      // 方案1:IM 任务完成 → 自动推送到 PUSH_TO(微信),带来源;fire-and-forget
      if (cfg.pushTo) {
        const wc = channels.get('wechat');
        if (wc && typeof wc.send === 'function') {
          const summary = reply.replace(/\s+/g, ' ').trim().slice(0, 200);
          wc.send(cfg.pushTo, '[' + msg.channel + ' 任务完成]\n' + summary).catch(() => {});
        }
      }
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
    for (const name of Object.keys(channelFactories)) {
      const ch = channels.get(name);
      const configured = isChannelConfigured(name);
      if (ch) {
        const st = ch.status ? ch.status() : 'unknown';
        per[name] = { status: st, enabled: true, running: st === 'connected' };
      } else {
        per[name] = { status: configured ? 'stopped' : 'disabled', enabled: configured, running: false };
      }
    }
    return per;
  }

  // 通道是否已配置凭据(用于未注册通道的「未配置/可启动」判断)
  function isChannelConfigured(name) {
    const c = cfg.channels[name];
    if (!c) return false;
    switch (name) {
      case 'wecom': return !!(c.botId && c.secret);
      case 'dingtalk': return !!(c.clientId && c.clientSecret);
      case 'wechat': return true; // 账号文件驱动,无需 bot 凭据
      case 'feishu': return !!(c.appId && c.appSecret);
      default: return false;
    }
  }

  function setConfig(newCfg) { cfg = newCfg; }
  function reload() { if (reloadConfig) cfg = reloadConfig(); return cfg; }

  // 运行时启动通道:已注册则重连;未注册则按当前配置重新创建(维护页保存配置后可动态启用)
  async function startChannel(name) {
    const existing = channels.get(name);
    if (existing) {
      try { await existing.start(); return { ok: true, note: '已重新启动' }; }
      catch (e) { return { ok: false, error: e.message }; }
    }
    const factory = channelFactories[name];
    if (!factory) return { ok: false, error: '未知通道 ' + name };
    const ch = factory({ cfg, core });
    if (!ch.enabled) return { ok: false, error: '未配置完整凭据,请先在维护页填写并保存' };
    register(ch);
    try { await ch.start(); return { ok: true, note: '已启动' }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  function stopChannel(name) {
    const ch = channels.get(name);
    if (!ch) return { ok: false, error: '通道未运行' };
    try { ch.stop(); return { ok: true, note: '已停止' }; }
    catch (e) { return { ok: false, error: e.message }; }
  }

  // 微信 iLink 会话过期(账号被清理)时,经其他已配置通道提醒用户重新扫码(1 小时冷却)
  let lastWechatExpiryNotify = 0;
  function notifyWechatSessionExpired(accId) {
    const now = Date.now();
    if (now - lastWechatExpiryNotify < 3600000) return;
    lastWechatExpiryNotify = now;
    const short = String(accId || 'unknown').slice(0, 8);
    const text = '[微信] ⚠️ iLink 会话已过期(' + short + '),请到维护页重新扫码登录';
    const targets = [
      { name: 'wecom', to: cfg.pushWecomTo, extra: undefined },
      { name: 'dingtalk', to: cfg.pushDingtalkConvId, extra: cfg.pushDingtalkRobotCode },
      { name: 'feishu', to: cfg.pushFeishuTo, extra: undefined },
    ];
    for (const t of targets) {
      if (!t.to) continue;
      const ch = channels.get(t.name);
      if (ch && typeof ch.send === 'function') {
        ch.send(t.to, text, t.extra).catch(() => {});
      }
    }
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
    setConfig,
    reload,
    startChannel,
    stopChannel,
    isChannelConfigured,
    notifyWechatSessionExpired,
    channelFactories,
    channels,
    queue,
    activeAborts,
  };
}
