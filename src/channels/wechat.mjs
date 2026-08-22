/**
 * 微信通道(基于 @wechatbot/wechatbot 的 iLink Bot,账号文件驱动)
 * ===============================================================
 * 与企微/钉钉不同:凭据是「账号文件」(含 iLink token),通过扫码登录生成,
 * 放在账号目录(默认 wechat-accounts/,可用 WECHAT_ACCOUNTS_DIR 覆盖,也可
 * 指向既有 iLink 账号目录复用)。进程 10s 扫描目录,新账号自动拉起。
 *
 * 工作方式:每账号长轮询 /ilink/bot/getupdates,消息含文本+附件(CDN AES 解密),
 * 经 core 调 agent 后经 /ilink/bot/sendmessage 回复。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chunkUtf8 } from '../claude.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHANNEL_VERSION = '2.4.6';
const MAX_BYTES = 4000; // 微信单条文本约 5KB,取 4000 字节保守分块,避免超限被静默截断
const ILINK_APP_CLIENT_VERSION = String(
  (() => {
    const [major, minor, patch] = CHANNEL_VERSION.split('.').map(Number);
    return (major << 16) | (minor << 8) | patch;
  })()
);

// ── 微信 CDN 文件下载(AES-128-ECB 解密)──
function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error('aes_key must decode to 16 raw bytes or 32-char hex, got ' + decoded.length + ' bytes');
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function buildCdnUrl(encryptedQueryParam, cdnBaseUrl) {
  return cdnBaseUrl.replace(/\/$/, '') + '/download?encrypted_query_param=' + encodeURIComponent(encryptedQueryParam);
}

async function downloadWeChatFile(encryptQueryParam, aesKeyBase64, cdnBaseUrl, fullUrl) {
  const url = fullUrl || buildCdnUrl(encryptQueryParam, cdnBaseUrl);
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error('CDN download HTTP ' + resp.status);
  const encrypted = Buffer.from(await resp.arrayBuffer());
  if (aesKeyBase64) return decryptAesEcb(encrypted, parseAesKey(aesKeyBase64));
  return encrypted;
}

function getItemFileExt(item) {
  if (item.type === 4 && item.file_item?.file_name) {
    const ext = path.extname(item.file_item.file_name).replace(/^\./, '').toLowerCase();
    if (ext) return ext;
  }
  return 'bin';
}

export function createChannel({ cfg, core }) {
  const c = cfg.channels.wechat;
  const name = 'wechat';
  const accountsDir = c.accountsDir || path.join(PROJECT_DIR, 'wechat-accounts');
  const enabled = true; // 无需 bot 凭据,账号文件驱动(空目录则空转)

  const instances = new Map();

  function log(msg) { console.log('[' + name + '] ' + msg); }
  function accLog(accId, msg) { console.log('[' + name + ':' + accId.slice(0, 8) + '] ' + msg); }

  function clearAccountFiles(accId) {
    for (const suffix of ['.json', '.sync.json', '.context-tokens.json']) {
      try { fs.rmSync(path.join(accountsDir, accId + suffix), { force: true }); } catch {}
    }
  }

  class WeChatInstance {
    constructor(acc) {
      this.acc = acc;
      this.cursor = '';
      this.status = 'starting';
      this.retry = 0;
      this.timer = null;
      this.syncFilePath = path.join(accountsDir, acc.id + '.sync.json');
    }

    loadCursor() {
      try {
        if (fs.existsSync(this.syncFilePath)) {
          const raw = JSON.parse(fs.readFileSync(this.syncFilePath, 'utf8'));
          if (typeof raw.get_updates_buf === 'string' && raw.get_updates_buf) {
            this.cursor = raw.get_updates_buf;
            accLog(this.acc.id, '恢复 cursor (' + this.cursor.length + ' bytes)');
          }
        }
      } catch (e) {
        accLog(this.acc.id, '读取 cursor 失败: ' + e.message);
      }
    }

    saveCursor(buf) {
      try { fs.writeFileSync(this.syncFilePath, JSON.stringify({ get_updates_buf: buf }, null, 0), 'utf8'); } catch {}
    }

    getHeaders() {
      const uin = Buffer.from(String(Math.floor(Math.random() * 4294967296)), 'utf-8').toString('base64');
      return {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'Authorization': 'Bearer ' + this.acc.token,
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
        'X-WECHAT-UIN': uin,
      };
    }

    base() { return this.acc.baseUrl.replace(/\/$/, ''); }

    async init() {
      this.loadCursor();
      if (!this.acc.token) {
        this.status = 'error';
        accLog(this.acc.id, '无 Token,清理...');
        clearAccountFiles(this.acc.id);
        return false;
      }
      try {
        const resp = await fetch(this.base() + '/ilink/bot/msg/notifystart', {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({ base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'datai-agent-bridge' } }),
          signal: AbortSignal.timeout(10000),
        });
        if (resp.status === 401) {
          this.status = 'error';
          accLog(this.acc.id, 'Token 无效,清理...');
          clearAccountFiles(this.acc.id);
          core.notifyWechatSessionExpired(this.acc.id);
          return false;
        }
        accLog(this.acc.id, 'notifyStart ' + (resp.ok ? '成功' : 'HTTP ' + resp.status));
      } catch (err) {
        accLog(this.acc.id, 'notifyStart 失败: ' + err.message + ' (忽略)');
      }
      this.status = 'online';
      return true;
    }

    async poll() {
      if (this.status === 'offline') return;
      try {
        const resp = await fetch(this.base() + '/ilink/bot/getupdates', {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({
            get_updates_buf: this.cursor,
            base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'datai-agent-bridge' },
          }),
          signal: AbortSignal.timeout(35000),
        });

        if (resp.status === 401) {
          this.status = 'error';
          accLog(this.acc.id, 'Token 已失效,清理残存文件...');
          clearAccountFiles(this.acc.id);
          core.notifyWechatSessionExpired(this.acc.id);
          return;
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        const data = await resp.json();
        if (data.errcode) {
          accLog(this.acc.id, 'API errcode=' + data.errcode + ': ' + (data.errmsg || ''));
          if (data.errcode === 401 || data.errcode === 1101 || data.errcode === -14) {
            this.status = 'error';
            accLog(this.acc.id, '会话失效,清理残存账号...');
            clearAccountFiles(this.acc.id);
            core.notifyWechatSessionExpired(this.acc.id);
            return;
          }
        } else {
          if (data.get_updates_buf) {
            this.cursor = data.get_updates_buf;
            this.saveCursor(data.get_updates_buf);
          }
          this.retry = 0;
          if (this.status !== 'online') this.status = 'online';

          if (data.msgs && data.msgs.length) {
            for (const msg of data.msgs) {
              if (msg.message_type !== 1) continue;
              const items = msg.item_list || [];
              const userText = items.find((i) => i.type === 1)?.text_item?.text || '';
              const fileItem = items.find((i) => i.type === 2 || i.type === 4);

              let attachment = null;
              if (fileItem) {
                try {
                  const media = fileItem.type === 2 ? fileItem.image_item?.media : fileItem.file_item?.media;
                  const aesKey = fileItem.type === 2
                    ? (fileItem.image_item?.aeskey ? Buffer.from(fileItem.image_item.aeskey, 'hex').toString('base64') : media?.aes_key)
                    : media?.aes_key;
                  if (media?.encrypt_query_param || media?.full_url) {
                    const buf = await downloadWeChatFile(
                      media.encrypt_query_param || '',
                      aesKey || '',
                      this.acc.baseUrl || 'https://ilinkai.weixin.qq.com',
                      media.full_url
                    );
                    const ext = getItemFileExt(fileItem);
                    const filePath = core.saveToInbox(buf, msg.from_user_id || 'unknown', ext);
                    attachment = { filePath, fileName: path.basename(filePath) };
                    accLog(this.acc.id, '附件已保存: ' + filePath);
                  }
                } catch (e) {
                  accLog(this.acc.id, '附件下载失败: ' + e.message);
                }
              }

              if (!userText && !attachment) continue;
              accLog(this.acc.id, '收到消息: ' + userText.slice(0, 60) + (attachment ? ' (+附件)' : ''));

              // 异步处理消息,不阻塞轮询:agent 调用可能耗时较长,
              // 若轮询被阻塞,getupdates 空档变长会导致 iLink 会话空闲超时(-14)
              core.handleMessage({
                channel: name,
                senderId: msg.from_user_id || 'unknown',
                chatId: msg.from_user_id || 'unknown',
                chatType: 'single',
                text: userText,
                attachment,
                reply: (content) => this.sendMsg(msg.from_user_id, msg.context_token || '', content),
                log: (m) => accLog(this.acc.id, m),
              }).catch((e) => accLog(this.acc.id, '处理消息异常: ' + e.message));
            }
          }
        }
      } catch (err) {
        // AbortSignal.timeout() 产生的是 TimeoutError(非 AbortError),属于长轮询正常超时,不计入 retry
        if (err.name !== 'AbortError' && err.name !== 'TimeoutError') {
          accLog(this.acc.id, '轮询异常: ' + err.message);
          this.retry++;
        }
      }
      const delay = this.retry > 3 ? 10000 : 1000;
      this.timer = setTimeout(() => this.poll(), delay);
    }

    async sendMsg(toUser, ctxToken, text) {
      const parts = chunkUtf8(text, MAX_BYTES);
      for (let i = 0; i < parts.length; i++) {
        try {
          const resp = await fetch(this.base() + '/ilink/bot/sendmessage', {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
              msg: {
                from_user_id: '',
                to_user_id: toUser,
                client_id: 'datai-agent-bridge-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
                message_type: 2,
                message_state: 2,
                item_list: [{ type: 1, text_item: { text: parts[i] } }],
                // 回复上下文 token 只挂第一块;后续块是独立的新消息
                context_token: i === 0 ? (ctxToken || undefined) : undefined,
              },
              base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'datai-agent-bridge' },
            }),
          });
          if (!resp.ok) {
            accLog(this.acc.id, 'sendMsg 失败: HTTP ' + resp.status);
            break;
          }
        } catch (err) {
          accLog(this.acc.id, 'sendMsg 异常: ' + err.message);
          break;
        }
      }
    }
  }

  function getAccounts() {
    if (!fs.existsSync(accountsDir)) return [];
    return fs.readdirSync(accountsDir)
      .filter((f) => f.endsWith('.json') && !f.includes('context-tokens'))
      .map((f) => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(accountsDir, f), 'utf8'));
          if (!d.token) return null;
          return { id: f.replace('.json', ''), token: d.token, baseUrl: d.baseUrl || c.baseUrl || 'https://ilinkai.weixin.qq.com' };
        } catch { return null; }
      })
      .filter((a) => a);
  }

  async function scanAndLaunch() {
    const accounts = getAccounts();
    for (const acc of accounts) {
      if (instances.has(acc.id)) continue;
      accLog(acc.id, '发现新账号,启动...');
      const inst = new WeChatInstance(acc);
      instances.set(acc.id, inst);
      const ok = await inst.init();
      if (ok) inst.poll();
    }
    setTimeout(scanAndLaunch, 10000);
  }

  function start() {
    log('账号目录: ' + accountsDir);
    fs.mkdirSync(accountsDir, { recursive: true });
    log('已启动(10s 扫描新账号)');
    scanAndLaunch();
  }

  function stop() {
    for (const [id, inst] of instances) {
      if (inst.timer) clearTimeout(inst.timer);
      inst.status = 'offline';
    }
    log('已停止全部微信实例');
  }

  function status() {
    const online = [...instances.values()].some((i) => i.status === 'online');
    return online ? 'connected' : 'disconnected';
  }

  // 主动推送:向指定 wxid 发消息(无需上下文 token)
  async function send(toUser, text) {
    for (const inst of instances.values()) {
      if (inst.status === 'online') {
        await inst.sendMsg(toUser, '', text);
        return { ok: true, note: '已发送到 ' + toUser };
      }
    }
    return { ok: false, error: '无在线微信账号' };
  }

  return { name, enabled, start, stop, status, send };
}
