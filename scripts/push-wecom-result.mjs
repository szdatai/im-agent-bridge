#!/usr/bin/env node
/**
 * Claude Code Stop/StopFailure hook → 推送结果摘要到企微群 webhook
 * ==============================================================
 * 替代原先固定的「任务已完成 HH:MM」bash 推送:
 *   提取最后一条 assistant 结果(截 1500 字)+ 带时间戳;
 *   bridge 内部 agent 会话(IM_AGENT_BRIDGE=1)跳过,不再刷屏。
 * 目标:环境变量 WECOM_WEBHOOK_URL(企微群机器人 webhook)。
 */
import fs from 'node:fs';

if (process.env.IM_AGENT_BRIDGE === '1') process.exit(0); // bridge 内部会话不回推
const webhook = process.env.WECOM_WEBHOOK_URL;
if (!webhook) process.exit(0);

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
const ts = new Date();
const hhmm = String(ts.getHours()).padStart(2, '0') + ':' + String(ts.getMinutes()).padStart(2, '0');
const msg = '[' + hhmm + '] 【Claude Code ' + (isFail ? '失败' : '完成') + '】\n' + result.slice(0, 1500);

fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ msgtype: 'text', text: { content: msg } }),
}).catch(() => {});
