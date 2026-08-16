#!/usr/bin/env node
/**
 * Claude Code AskUserQuestion / PermissionRequest hook → 推送决策/授权提醒到微信
 * ========================================================================
 * 交互 CLI 会话中,Claude 需要你决策(AskUserQuestion 提问)或请求授权(PermissionRequest)
 * 时,推一条「请回电脑处理」提醒到微信(5s 冷却,避免连续提问轰炸)。
 * bridge 内部 agent 会话(IM_AGENT_BRIDGE=1)不回推。
 *
 * 说明:这只能「提醒」你回电脑,无法从微信远程回复决策(交互会话需终端输入)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.IM_AGENT_BRIDGE === '1') process.exit(0);

let hook = {};
try { hook = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}
const ev = hook.hook_event_name;

let text = '';
if (ev === 'AskUserQuestion') {
  const q = hook.tool_input?.question || 'Claude 需要你决策';
  const opts = (hook.tool_input?.options || [])
    .map((o) => o.label)
    .filter(Boolean)
    .slice(0, 4)
    .join(' / ');
  text = '⚠️ Claude Code 需要你决策:\n' + q + (opts ? '\n选项: ' + opts : '');
} else if (ev === 'PermissionRequest') {
  const pr = hook.permission_request || {};
  const tool = pr.tool_name || '';
  const inp = pr.input ? String(pr.input).slice(0, 200) : '';
  text = '⚠️ Claude Code 请求授权: ' + tool + (inp ? '\n' + inp : '');
} else {
  process.exit(0);
}
text += '\n(请回电脑处理)';

// 冷却 5s
const logDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../logs');
const cooldownFile = path.join(logDir, 'last-decision.txt');
const COOLDOWN_MS = 5000;
try {
  fs.mkdirSync(logDir, { recursive: true });
  if (fs.existsSync(cooldownFile)) {
    const last = parseInt(fs.readFileSync(cooldownFile, 'utf8'), 10);
    if (Date.now() - last < COOLDOWN_MS) process.exit(0);
  }
  fs.writeFileSync(cooldownFile, String(Date.now()), 'utf8');
} catch {}

fetch('http://127.0.0.1:18794/api/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text }),
}).catch(() => {});
