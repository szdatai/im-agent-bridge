/**
 * 全局自动启动自注册模块
 * =======================
 * 在 bridge 启动时把「随 Claude Code 自动拉起 bridge」的 SessionStart hook
 * 写入全局 ~/.claude/settings.json,使任意目录启动 Claude Code 都会自动拉起 bridge。
 *
 * 幂等:已注册(命令完全一致)则跳过;若存在指向旧路径的同款 hook(项目移动过),
 * 自动替换为当前路径;每次只做最小改动,保留其余全部配置。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const AUTO_MARKER = 'im-agent-bridge/scripts/autostart.mjs';

/**
 * 确保全局 settings.json 已注册本项目的自动启动 hook。
 * @param {string} [settingsPath] 覆盖设置文件路径(测试用),默认 ~/.claude/settings.json
 * @returns {Promise<{changed: boolean, reason: string}>}
 */
export async function ensureGlobalAutoStart(settingsPath = DEFAULT_SETTINGS_PATH) {
  const autoStartPath = path.join(BRIDGE_DIR, 'scripts', 'autostart.mjs');
  const command = 'node ' + autoStartPath.replace(/\\/g, '/');

  let settings = {};
  let existed = true;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    existed = false; // 文件不存在或损坏 → 从空对象重建
  }

  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    settings = {};
  }
  if (typeof settings.hooks !== 'object' || settings.hooks === null) {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks.SessionStart)) {
    settings.hooks.SessionStart = [];
  }

  const sessionEntries = settings.hooks.SessionStart;
  const hasExact = sessionEntries.some((entry) =>
    (entry?.hooks || []).some((h) => h?.command === command)
  );
  if (hasExact) {
    return { changed: false, reason: '已注册(命令一致),跳过' };
  }

  // 去掉指向本项目 autostart 的旧条目(路径可能因项目移动而不同),再写入当前路径
  const kept = sessionEntries.filter((entry) =>
    !(entry?.hooks || []).some((h) => typeof h?.command === 'string' && h.command.includes(AUTO_MARKER))
  );
  kept.push({ hooks: [{ type: 'command', command }] });
  settings.hooks.SessionStart = kept;

  const json = JSON.stringify(settings, null, 2) + '\n';
  if (!existed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  } else {
    fs.copyFileSync(settingsPath, settingsPath + '.bak'); // 修改前留备份
  }
  fs.writeFileSync(settingsPath, json, 'utf8');
  return { changed: true, reason: '已写入全局 SessionStart hook: ' + command };
}
