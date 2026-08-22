#!/usr/bin/env node
/**
 * IM ↔ Claude Code 双向通道桥接进程(唯一入口,多通道)
 * ====================================================
 * 支持通道:wecom(企微)/ dingtalk(钉钉)/ wechat(微信)/ feishu(飞书)。
 * 消息 → 无头 agent(query(),cwd=WORK_DIR)→ 一次性回复原通道。
 *
 * 启用与凭据见 .env(ENABLED_CHANNELS + 各通道 X_ALLOWLIST/凭据)。
 * 用法:
 *   node bridge.mjs            (读取 .env)
 *   node bridge.mjs --bot-id=xxx --secret=xxx   (CLI 覆盖企微)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CFG, anthropicEnv, model, reloadConfig } from './src/config.mjs';
import { createCore } from './src/core.mjs';
import { startAdminServer } from './src/admin.mjs';
import { ensureGlobalAutoStart, ensureProjectAutoStart } from './src/autoregister.mjs';
import { createChannel as createWecomChannel } from './src/channels/wecom.mjs';
import { createChannel as createDingtalkChannel } from './src/channels/dingtalk.mjs';
import { createChannel as createWechatChannel } from './src/channels/wechat.mjs';
import { createChannel as createFeishuChannel } from './src/channels/feishu.mjs';

// 全部通道工厂(供启动时启用 + 维护页运行时动态启停)
// 顺序:微信、企微、飞书、钉钉(与维护页一致)
const channelFactories = {
  wechat: createWechatChannel,
  wecom: createWecomChannel,
  feishu: createFeishuChannel,
  dingtalk: createDingtalkChannel,
};

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INBOX_DIR = path.join(BRIDGE_DIR, 'inbox');
fs.mkdirSync(INBOX_DIR, { recursive: true });

// ── 自注册全局自动启动 hook(幂等,失败不影响运行)──
// 全局 hook 会被 CC Switch 切供应商时重写 settings.json 而抹掉,故同时注册到
// 项目级 settings.local.json(WORK_DIR),两者任一存活都能在会话启动时拉起桥。
ensureGlobalAutoStart()
  .then((r) => console.log('[bridge] 自动启动自注册: ' + r.reason))
  .catch((err) => console.warn('[bridge] 自动启动自注册失败(不影响运行): ' + err.message));
ensureProjectAutoStart(CFG.workDir)
  .then((r) => console.log('[bridge] 项目级自启动注册: ' + r.reason))
  .catch((err) => console.warn('[bridge] 项目级自启动注册失败(不影响运行): ' + err.message));

const AGENT_LABEL = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(BRIDGE_DIR, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')
    );
    return 'claude-agent-sdk@' + pkg.version;
  } catch {
    return 'claude-agent-sdk';
  }
})();

if (!anthropicEnv.ANTHROPIC_BASE_URL || !anthropicEnv.ANTHROPIC_AUTH_TOKEN) {
  console.warn('[bridge] 未检测到 ANTHROPIC_BASE_URL/AUTH_TOKEN(已读 settings.json 兜底?若仍为空,agent 将无法连接模型)');
}

// ── 核心编排 ──
const core = createCore({ cfg: CFG, anthropicEnv, model, inboxDir: INBOX_DIR, projectDir: BRIDGE_DIR, channelFactories, reloadConfig });

// ── 按 ENABLED_CHANNELS 加载通道 ──
let enabledCount = 0;
for (const name of CFG.enabledChannels) {
  const factory = channelFactories[name];
  if (!factory) { console.warn('[bridge] 未知通道 ' + name + ',已忽略'); continue; }
  const channel = factory({ cfg: CFG, core });
  if (!channel.enabled) {
    console.warn('[bridge] 通道 ' + name + ' 未配置完整凭据,已跳过');
    continue;
  }
  const al = (CFG.channels[name]?.allowlist || []).concat(CFG.globalAllowlist).filter(Boolean);
  const openDefault = CFG.channels[name]?.open === true;
  if (!al.length && !openDefault) {
    console.warn('[bridge] 通道 ' + name + ' 无白名单 → fail-closed,将忽略所有消息');
  }
  core.register(channel);
  enabledCount++;
}
if (enabledCount === 0) {
  console.error('[bridge] 没有任何已启用且已配置的通道 (ENABLED_CHANNELS=' + CFG.enabledChannels.join(',') + ')');
  console.error('[bridge] 请填写至少一个通道的凭据,参考 .env.example');
  process.exit(1);
}

console.log('[bridge] 工作目录: ' + CFG.workDir);
console.log('[bridge] 模型: ' + model);
console.log('[bridge] 权限模式: ' + CFG.permissionMode);
console.log('[bridge] 启用通道: ' + [...core.channels.keys()].join(','));

// ── 管理 Web 服务器(通道维护页 + /health + API)──
startAdminServer({ cfg: CFG, core, model, agentLabel: AGENT_LABEL, port: CFG.bridgePort });

// ── 启动全部通道 ──
await core.start();

// ── 优雅退出 ──
function shutdown(signal) {
  console.log('[bridge] 收到 ' + signal + ',正在关闭...');
  core.stop();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
