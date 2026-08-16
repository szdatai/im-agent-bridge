#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook → 推送「进行中」进度到微信
 * =======================================================
 * 由 ~/.claude/settings.json 的 PostToolUse hook 调用(需在维护页开启「进度推送」)。
 * 只推关键工具(Edit/Write/NotebookEdit/Bash)并带 10s 冷却,避免刷屏。
 * bridge 内部 agent 会话(IM_AGENT_BRIDGE=1)不回推。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.IM_AGENT_BRIDGE === '1') process.exit(0); // bridge 内部会话不回推

let hook = {};
try { hook = JSON.parse(fs.readFileSync(0, 'utf8')); } catch {}

const tool = hook.tool_name || '';
const KEY_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'];
if (!KEY_TOOLS.includes(tool)) process.exit(0);

const input = hook.tool_input || {};
let line = '';
if (tool === 'Bash') {
  const cmd = String(input.command || input.cmd || '').trim().slice(0, 120);
  if (!cmd) process.exit(0);
  line = '⚙️ ' + cmd;
} else {
  const fp = String(input.file_path || '').trim();
  if (!fp) process.exit(0);
  line = '📝 ' + fp;
}

// 冷却:10s 内只推一条,避免连续工具调用轰炸
const logDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../logs');
const cooldownFile = path.join(logDir, 'last-progress.txt');
const COOLDOWN_MS = 10000;
try {
  fs.mkdirSync(logDir, { recursive: true });
  if (fs.existsSync(cooldownFile)) {
    const last = parseInt(fs.readFileSync(cooldownFile, 'utf8'), 10);
    if (Date.now() - last < COOLDOWN_MS) process.exit(0);
  }
  fs.writeFileSync(cooldownFile, String(Date.now()), 'utf8');
} catch {}

const text = '【进行中】' + line;
fetch('http://127.0.0.1:18794/api/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, kind: 'progress' }),
}).catch(() => {});
