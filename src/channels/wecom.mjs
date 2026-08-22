/**
 * 企业微信通道(基于 @wecom/aibot-node-sdk WebSocket 长连接)
 * ===========================================================
 * 凭据:WECOM_BOT_ID / WECOM_BOT_SECRET(企微后台 → 智能机器人 → API 模式 → 长连接)。
 * 消息:message.text / message.image / message.file;附件先落盘 inbox/ 并暂存,
 * 由 core 与后续 text 配对(30s TTL);event.enter_chat 发送欢迎语。
 */
import path from 'node:path';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import { chunkUtf8 } from '../claude.mjs';

export function createChannel({ cfg, core }) {
  const c = cfg.channels.wecom;
  const name = 'wecom';
  const enabled = !!(c.botId && c.secret);
  const MAX_BYTES = 2000; // 企微 markdown 消息 content 约 2048 字节,取 2000 保守分块

  let client = null;
  let isConnected = false;

  function log(msg) { console.log('[' + name + '] ' + msg); }

  async function replyWithRetry(frame, content) {
    const parts = chunkUtf8(content, MAX_BYTES);
    for (let i = 0; i < parts.length; i++) {
      // 超长回复:第一块走回复流(维持回复语义),续块走 sendMessage 新消息——
      // 企微回复协议可能只允许一次,新消息最可靠,且避免单条超限被截断尾部。
      if (i > 0 && client) {
        const chatTarget = frame.body?.chatid || frame.body?.chat_id || frame.body?.from?.userid;
        if (chatTarget) {
          try {
            await client.sendMessage(chatTarget, { msgtype: 'markdown', markdown: { content: parts[i] } });
            continue;
          } catch (e) {
            log('长回复续块发送失败: ' + e.message);
          }
        }
      }
      let ok = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (!client) return;
        try {
          await client.replyStream(frame, generateReqId('stream'), parts[i], true);
          ok = true;
          break;
        } catch (err) {
          if (attempt === 3) { log('回复失败(重试 3 次后放弃): ' + err.message); return; }
          await new Promise((r) => setTimeout(r, 5000 * attempt));
        }
      }
      if (!ok) return;
    }
  }

  async function stash(frame, kind) {
    const senderId = frame.body?.from?.userid || 'unknown';
    const chatId = frame.body?.chatid || frame.body?.chat_id || '';
    if (!core.isAllowed(name, senderId, chatId)) return;
    const url = kind === 'image' ? frame.body?.image?.url : frame.body?.file?.url;
    const aesKey = kind === 'image' ? frame.body?.image?.aeskey : frame.body?.file?.aeskey;
    const fname = kind === 'image'
      ? (frame.body?.image?.name || 'image.jpg')
      : (frame.body?.file?.name || 'file.bin');
    if (!url) return;
    try {
      const { buffer, filename } = await client.downloadFile(url, aesKey);
      const ext = path.extname(filename || fname).replace(/^\./, '') || (kind === 'image' ? 'jpg' : 'bin');
      const filePath = core.saveToInbox(buffer, senderId, ext);
      core.stashAttachment(name, senderId, filePath, filename || fname);
      log('附件已暂存 from ' + senderId + ': ' + (filename || fname) + ' (30s 内等指令配对)');
    } catch (err) {
      log(kind + ' 处理失败: ' + err.message);
    }
  }

  function start() {
    log('正在连接 (BotID: ' + c.botId.slice(0, 8) + '...)');

    client = new WSClient({
      botId: c.botId,
      secret: c.secret,
      logger: {
        debug: () => {},
        info: log,
        warn: (m) => console.warn('[' + name + '] ' + m),
        error: (m) => console.error('[' + name + '] ' + m),
      },
    });

    client.on('connected', () => log('WebSocket 已连接'));
    client.on('authenticated', () => {
      isConnected = true;
      log('认证成功,开始接收消息');
    });
    client.on('disconnected', (reason) => {
      isConnected = false;
      log('连接断开: ' + reason);
    });
    client.on('reconnecting', (attempt) => log('重连中 (第 ' + attempt + ' 次)'));
    client.on('error', (err) => log('错误: ' + err.message));

    // 文本消息:核心入口
    client.on('message.text', async (frame) => {
      const content = frame.body?.text?.content || '';
      const senderId = frame.body?.from?.userid || 'unknown';
      const chatId = frame.body?.chatid || frame.body?.chat_id || '';
      const chatType = frame.body?.chattype || 'single';
      if (!content) return;
      await core.handleMessage({
        channel: name, senderId, chatId, chatType, text: content, attachment: null,
        reply: (t) => replyWithRetry(frame, t),
        log,
      });
    });

    client.on('message.image', (frame) => stash(frame, 'image'));
    client.on('message.file', (frame) => stash(frame, 'file'));

    // 用户进入会话(欢迎语)
    client.on('event.enter_chat', async (frame) => {
      log('用户进入会话');
      try {
        await client.replyWelcome(frame, {
          msgtype: 'text',
          text: { content: '您好!我已连接 Claude Code,可在此发送指令或文件。' },
        });
      } catch (err) {
        log('发送欢迎语失败: ' + err.message);
      }
    });

    client.connect();
    log('已启动');
  }

  function stop() {
    if (client) client.disconnect();
  }

  function status() {
    return isConnected ? 'connected' : 'disconnected';
  }

  // 主动推送:向指定会话发消息(单聊填用户 userid,群聊填 chatid)
  // 注:sendMessage 仅支持 markdown/template_card/媒体,不含 text,用 markdown 承载文本
  async function send(to, text) {
    if (!client) return { ok: false, error: '企微未连接' };
    try {
      for (const part of chunkUtf8(text, MAX_BYTES)) {
        await client.sendMessage(to, { msgtype: 'markdown', markdown: { content: part } });
      }
      return { ok: true, note: '已发送到 ' + to };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { name, enabled, start, stop, status, send };
}
