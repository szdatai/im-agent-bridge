#!/usr/bin/env node
/**
 * Claude Code Stop/StopFailure hook → 推送会话结果到微信
 * =====================================================
 * 由 ~/.claude/settings.json 的 Stop/StopFailure hook 调用:
 *   读 hook stdin(JSON,含 transcript_path)→ 提取最后一条 assistant 文本 →
 *   POST 到本机 bridge 的 /api/push → 微信通道发到 PUSH_TO 目标 wxid。
 *
 * 跳过 bridge 内部 agent 会话(IM_AGENT_BRIDGE=1),避免回推/刷屏。
 */
import fs from 'node:fs';

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
        const texts = rec.message.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text.trim())
          .filter(Boolean);
        if (texts.length) { result = texts.join('\n'); break; }
      }
    }
  } catch {}
}

const isFail = hook.hook_event_name === 'StopFailure';
const time = new Date().toTimeString().slice(0, 5);
const text = '【Claude Code ' + (isFail ? '失败' : '完成') + ' ' + time + '】\n' + result.slice(0, 1500);

fetch('http://127.0.0.1:18794/api/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text }),
}).catch(() => {});
