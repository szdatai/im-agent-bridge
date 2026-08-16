#!/usr/bin/env node
/**
 * 手动推送工具(方案2:CLI 会话里程碑手动推送到微信)
 * ==================================================
 * 用法:
 *   node scripts/push.mjs "要推送的内容"
 *   node scripts/push.mjs 任务X 已完成,结果见上
 *
 * 在 Claude Code 会话中想推送某条进度/结果时,直接说「把结果推送到微信」,
 * 或让 agent 执行这条命令即可(经 bridge /api/push → PUSH_TO 微信)。
 */
const text = process.argv.slice(2).join(' ');
if (!text) {
  console.log('用法: node scripts/push.mjs "要推送的内容"');
  process.exit(1);
}
fetch('http://127.0.0.1:18794/api/push', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text }),
})
  .then((r) => r.json())
  .then((d) => console.log(d.ok ? '✅ 已推送' : '❌ 推送失败: ' + (d.error || '')))
  .catch((e) => console.log('❌ 推送失败: ' + e.message));
