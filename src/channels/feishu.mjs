/**
 * 飞书通道(基于 @larksuiteoapi/node-sdk,WebSocket 长连接)
 * =========================================================
 * 凭据:FEISHU_APP_ID / FEISHU_APP_SECRET(飞书开放平台 → 自建应用 → 凭证与基础信息)。
 * 前提:自建应用需开通「机器人」能力,并在事件订阅中添加 im.message.receive_v1
 *       (长连接模式由 SDK 自动建立连接)。
 * 消息:im.message.receive_v1(text/image/file);
 * 回复:im.v1.message.reply(文本);
 * 附件:im.v1.messageResource.get → writeFile 落盘 inbox/。
 * 白名单:FEISHU_ALLOWLIST 填用户 open_id(非白名单消息会打日志,可从日志抓取)。
 */
import path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';

export function createChannel({ cfg, core }) {
  const c = cfg.channels.feishu;
  const name = 'feishu';
  const enabled = !!(c.appId && c.appSecret);

  let client = null;
  let wsClient = null;
  let isConnected = false;

  function log(msg) { console.log('[' + name + '] ' + msg); }

  function parseContent(content) {
    try { return JSON.parse(content || '{}'); } catch { return {}; }
  }

  async function sendReply(messageId, content) {
    await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text: content }) },
    });
  }

  async function handleReceive(data) {
    const message = data?.message || {};
    const messageId = message.message_id;
    const chatId = message.chat_id || '';
    const chatType = message.chat_type === 'group' ? 'group' : 'single';
    const messageType = message.message_type || '';
    const senderId = message.sender?.sender_id?.open_id || message.sender?.sender_id?.user_id || 'unknown';
    if (!messageId) return;

    let text = '';
    let attachment = null;

    try {
      if (messageType === 'text') {
        text = parseContent(message.content).text || '';
      } else if (messageType === 'image' || messageType === 'file') {
        const parsed = parseContent(message.content);
        const fileKey = messageType === 'image' ? parsed.image_key : parsed.file_key;
        if (fileKey) {
          const res = await client.im.v1.messageResource.get({
            path: { message_id: messageId, file_key: fileKey },
            params: { type: messageType },
          });
          const ext = messageType === 'image' ? 'jpg' : (parsed.file_name ? path.extname(parsed.file_name).replace(/^\./, '') : 'bin');
          const filePath = core.makeInboxPath(senderId, ext);
          await res.writeFile(filePath);
          attachment = { filePath, fileName: path.basename(filePath) };
          log('附件已保存: ' + filePath);
        }
      } else {
        return; // 其他类型(卡片/富文本等)暂不处理
      }
    } catch (e) {
      log('解析消息失败: ' + e.message);
      return;
    }

    if (!text && !attachment) return;
    await core.handleMessage({
      channel: name, senderId, chatId, chatType, text, attachment,
      reply: (content) => sendReply(messageId, content),
      log,
    });
  }

  function start() {
    log('正在连接 (AppId: ' + c.appId.slice(0, 8) + '...)');
    client = new lark.Client({ appId: c.appId, appSecret: c.appSecret });
    wsClient = new lark.WSClient({ appId: c.appId, appSecret: c.appSecret, loggerLevel: lark.LoggerLevel.info });
    wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': handleReceive,
      }),
    }).then(() => {
      isConnected = true;
      log('已连接飞书,开始接收消息');
    }).catch((err) => {
      log('连接失败: ' + err.message);
    });
    log('已启动(长连接建立中...)');
  }

  function stop() {
    try { if (wsClient) wsClient.close(); } catch {}
  }

  function status() {
    return isConnected ? 'connected' : 'disconnected';
  }

  // 主动推送:向指定 receive_id(chat_id/open_id)发消息
  async function send(to, text) {
    if (!client) return { ok: false, error: '飞书未连接' };
    try {
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: to, msg_type: 'text', content: JSON.stringify({ text }) },
      });
      return { ok: true, note: '已发送到 ' + to };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { name, enabled, start, stop, status, send };
}
