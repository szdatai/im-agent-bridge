#!/usr/bin/env node
/**
 * Claude Code Stop/StopFailure hook → 推送结果摘要到所有已配置的通道
 * ================================================================
 * 统一入口,替代 push-claude-result / push-wecom-result:
 *   - 微信/钉钉/飞书:POST bridge /api/push(bridge 按各自 PUSH_* 目标决定发不发,
 *     统一加 [HH:MM] 时间戳);
 *   - 企微群:直接 POST WECOM_WEBHOOK_URL(脚本自带时间戳)。
 * bridge 内部 agent 会话(IM_AGENT_BRIDGE=1)跳过,不再刷屏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.IM_AGENT_BRIDGE === '1') process.exit(0); // bridge 内部会话不回推

let hook = {};
try { hook = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}

let result = '(未能提取会话结果)';
const tp = hook.transcript_path;
if (tp && fs.existsSync(tp)) {
  try {
    const lines = fs.readFileSync(tp, 'utf8').split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = JSON.parse(lines[i]);
      if (rec.type === 'assistant' && rec.message?.content) {
        const content = rec.message.content;
        let found = '';
        if (typeof content === 'string') {
          found = content.trim();
        } else if (Array.isArray(content)) {
          found = content
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text.trim())
            .filter(Boolean)
            .join('\n');
        }
        if (found) { result = found; break; }
      }
    }
  } catch {}
}

const isFail = hook.hook_event_name === 'StopFailure';
const tag = '【Claude Code ' + (isFail ? '失败' : '完成') + '】\n' + result.slice(0, 1500);
const ts = new Date();
const hhmm = String(ts.getHours()).padStart(2, '0') + ':' + String(ts.getMinutes()).padStart(2, '0');
const logDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../logs');

// 微信/钉钉/飞书 → bridge(bridge 统一加 [HH:MM],按配置决定发不发)
for (const channel of ['wechat', 'dingtalk', 'feishu']) {
  fetch('http://127.0.0.1:18794/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, text: tag }),
  })
    .then((r) => { if (!r.ok) fs.appendFileSync(path.join(logDir, 'hook-push.log'), '[' + new Date().toISOString() + '] ' + channel + ' HTTP ' + r.status + '\n'); })
    .catch(() => {});
}

// 企微群 webhook(脚本自带时间戳)
if (process.env.WECOM_WEBHOOK_URL) {
  fetch(process.env.WECOM_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: '[' + hhmm + '] ' + tag } }),
  }).catch(() => {});
}
