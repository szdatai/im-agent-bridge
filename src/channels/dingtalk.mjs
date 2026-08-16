/**
 * 钉钉通道(基于 dingtalk-stream,Stream 模式 WebSocket 长连接)
 * =============================================================
 * 凭据:DINGTALK_CLIENT_ID(AppKey)/ DINGTALK_CLIENT_SECRET(AppSecret)。
 * 消息:registerCallbackListener(TOPIC_ROBOT) 收到机器人消息;
 * 回复:POST sessionWebhook + x-acs-dingtalk-access-token;
 * 附件:downloadCode / Drive API 下载 → inbox/,立即处理并暂存配对后续文本。
 */
import path from 'node:path';
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';

// DingTalk 文件下载 REST API(优先 /v1.0/robot/messageFiles/download)
async function downloadDingTalkMedia(downloadCode, robotCode, accessToken) {
  const hosts = ['https://api.dingtalk.com', 'https://oapi.dingtalk.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const resp = await fetch(host + '/v1.0/robot/messageFiles/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
        body: JSON.stringify({ downloadCode, robotCode }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) { lastErr = new Error('HTTP ' + resp.status); continue; }
      const json = await resp.json();
      if (json.downloadUrl) {
        const dl = await fetch(json.downloadUrl, { signal: AbortSignal.timeout(60000) });
        if (!dl.ok) throw new Error('download HTTP ' + dl.status);
        return Buffer.from(await dl.arrayBuffer());
      }
      lastErr = new Error('No downloadUrl');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('All download endpoints failed');
}

// 兜底:钉钉 Drive(存储)下载
async function downloadDingTalkSpaceFile(spaceId, fileId, accessToken) {
  const resp = await fetch(
    'https://api.dingtalk.com/v1.0/drive/spaces/' + encodeURIComponent(spaceId) + '/files/' + encodeURIComponent(fileId) + '/download',
    { method: 'POST', headers: { 'x-acs-dingtalk-access-token': accessToken }, signal: AbortSignal.timeout(15000) }
  );
  if (!resp.ok) throw new Error('Drive API HTTP ' + resp.status);
  const info = await resp.json();
  if (!info.downloadUrl) throw new Error('No downloadUrl');
  const dl = await fetch(info.downloadUrl, { headers: info.headers || {}, signal: AbortSignal.timeout(60000) });
  if (!dl.ok) throw new Error('download HTTP ' + dl.status);
  return Buffer.from(await dl.arrayBuffer());
}

export function createChannel({ cfg, core }) {
  const c = cfg.channels.dingtalk;
  const name = 'dingtalk';
  const enabled = !!(c.clientId && c.clientSecret);

  let client = null;

  function log(msg) { console.log('[' + name + '] ' + msg); }

  async function handleRobot(res) {
    let data;
    try { data = JSON.parse(res.data); } catch { return; }
    try {
      const senderId = data.senderStaffId || data.senderId || 'unknown';
      const chatId = data.conversationId || '';
      const messageId = res.headers?.messageId;
      const sessionWebhook = data.sessionWebhook;
      const msgtype = data.msgtype || '';
      const chatType = data.conversationType === '2' ? 'group' : 'single';

      // 回复(一次性)+ 确认已处理(防钉钉重推)
      const reply = async (content) => {
        if (!messageId) return;
        let respData = {};
        try {
          if (sessionWebhook) {
            const accessToken = await client.getAccessToken();
            const resp = await fetch(sessionWebhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
              body: JSON.stringify({ msgtype: 'text', text: { content } }),
              signal: AbortSignal.timeout(15000),
            });
            if (resp.ok) respData = await resp.json().catch(() => ({}));
          }
        } catch (e) {
          log('回复发送失败: ' + e.message);
        } finally {
          try { client.socketCallBackResponse(messageId, respData); } catch {}
        }
      };

      const emit = (text, attachment) => core.handleMessage({
        channel: name, senderId, chatId, chatType, text, attachment,
        reply, log,
      });

      if (msgtype === 'text') {
        if (data.text?.content) await emit(data.text.content, null);
        else if (messageId) client.socketCallBackResponse(messageId, {});
      } else if ((msgtype === 'picture' || msgtype === 'image') && (data.picture?.downloadCode || data.image?.downloadCode)) {
        const code = data.picture?.downloadCode || data.image?.downloadCode;
        const accessToken = await client.getAccessToken();
        const buf = await downloadDingTalkMedia(code, '', accessToken);
        const filePath = core.saveToInbox(buf, senderId, 'jpg');
        core.stashAttachment(name, senderId, filePath, 'image.jpg');
        await emit('[附件: 图片]', { filePath, fileName: 'image.jpg' });
      } else if (msgtype === 'file' && data.content?.downloadCode) {
        const fileName = data.content.fileName || data.content.file_name || 'file';
        const accessToken = await client.getAccessToken();
        const robotCode = data.robotCode || '';
        let buf;
        try {
          buf = await downloadDingTalkMedia(data.content.downloadCode, robotCode, accessToken);
        } catch (e2) {
          log('media 下载失败,尝试 Drive API: ' + e2.message);
          if (!(data.content.fileId && data.content.spaceId)) throw e2;
          buf = await downloadDingTalkSpaceFile(data.content.fileId, data.content.spaceId, accessToken);
        }
        const ext = path.extname(fileName).replace(/^\./, '') || 'bin';
        const filePath = core.saveToInbox(buf, senderId, ext);
        core.stashAttachment(name, senderId, filePath, fileName);
        await emit('[附件: ' + fileName + ']', { filePath, fileName });
      } else {
        // 其他类型(卡片/链接等):仅确认,不处理
        if (messageId) client.socketCallBackResponse(messageId, {});
      }
    } catch (err) {
      log('处理消息失败: ' + err.message);
      // 出错也确认,避免钉钉无限重推
      try { if (res.headers?.messageId) client.socketCallBackResponse(res.headers.messageId, {}); } catch {}
    }
  }

  function start() {
    log('正在连接 (ClientId: ' + c.clientId.slice(0, 8) + '...)');
    client = new DWClient({ clientId: c.clientId, clientSecret: c.clientSecret });
    client.registerCallbackListener(TOPIC_ROBOT, handleRobot);
    // 必须注册全局事件监听,否则 SDK 可能断开
    client.registerAllEventListener(() => ({ status: 0 }));
    client.on('error', (err) => log('错误: ' + err.message));
    client.connect();
    // 注:该 SDK 不 emit 'connect' 事件,连接状态用 client.connected 判断
    log('已启动');
  }

  function stop() {
    try { if (client) client.disconnect(); } catch {}
  }

  function status() {
    return (client && client.connected) ? 'connected' : 'disconnected';
  }

  // 主动推送:向指定 openConversationId 发消息(需 robotCode)
  async function send(to, text, robotCode) {
    if (!client) return { ok: false, error: '钉钉未连接' };
    try {
      const accessToken = await client.getAccessToken();
      const resp = await fetch('https://api.dingtalk.com/v1.0/robot/robotMessages/robotMessagesSend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': accessToken },
        body: JSON.stringify({
          msgParam: JSON.stringify({ content: text }),
          msgKey: 'sampleText',
          openConversationId: to,
          robotCode: robotCode || '',
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return { ok: false, error: '钉钉发送失败: HTTP ' + resp.status };
      return { ok: true, note: '已发送到 ' + to };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { name, enabled, start, stop, status, send };
}
