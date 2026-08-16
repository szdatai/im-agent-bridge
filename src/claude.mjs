/**
 * Claude Code 无头 agent 封装(claude-agent-sdk)
 * ===============================================
 * askClaude() 用 query() 跑一次无头 agent,取最终 result 文本。
 * 权限:
 *   - disallowedTools 硬拦(deny 规则优先级最高,能覆盖 acceptEdits 自动批准
 *     与项目 settings 的 allow 规则)——主要用于 rm 家族等会被 acceptEdits 自动
 *     批准的文件系统命令;
 *   - canUseTool 权限门按命令内容正则兜底其余破坏性命令(git/docker/curl/sql 等,
 *     这些不会走 acceptEdits 自动批准,会正常落到 canUseTool)。
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

// ── 硬拦截:deny 规则。acceptEdits 会自动批准 cwd 内 rm/mv/cp 等文件系统命令,
//    canUseTool 根本不会看到它们,因此 rm 家族必须在此硬拦。 ──
export const disallowedTools = [
  'Bash(rm -rf *)',
  'Bash(rm -fr *)',
  'Bash(rm -rfv *)',
  'Bash(rm -rvf *)',
  'Bash(rm -r *)',
  'Bash(rm -R *)',
  'Bash(rm -f *)',
  'Bash(rm --recursive *)',
  'Bash(rm --force *)',
  'Bash(git push --force *)',
  'Bash(git push -f *)',
  'Bash(git clean -fdx *)',
  'Bash(git clean -fx *)',
  'Bash(docker rm -f *)',
  'Bash(docker rm -v *)',
  'Bash(shutdown *)',
  'Bash(reboot *)',
];

// ── canUseTool 兜底正则(覆盖未命中 deny 规则的破坏性命令)──
const DENY_PATTERNS = [
  /\bgit\s+push\s+.*(--force|-f)\b/,
  /\bgit\s+clean\s+-f[dx]?\b/,
  /\bdocker\s+rm\s+(-f|-v|-fv)?\s/,
  /\bdrop\s+database\b/i,
  /\b(curl|wget)\b[^|\n]*\|\s*(sh|bash|zsh)\b/i,
  /\brm\s+(-r|-f|--recursive|--force)\b[^\n]*(?:node_modules|\.git|dist|build|\.venv)/,
];

export function permissionGate(toolName, input) {
  if (toolName === 'Bash') {
    const cmd = typeof input === 'string' ? input : (input?.command || input?.cmd || '');
    for (const re of DENY_PATTERNS) {
      if (re.test(cmd)) {
        console.warn('[claude] canUseTool 拦截破坏性命令: ' + cmd.slice(0, 120));
        return { behavior: 'deny', message: '桥接层已拦截破坏性命令: ' + cmd.slice(0, 120) };
      }
    }
  }
  return { behavior: 'allow', updatedInput: input };
}

/**
 * 跑一次无头 agent。
 * @param {string} prompt
 * @param {object} opts
 * @param {string} opts.cwd                   工作目录
 * @param {string} opts.model                 模型 id(显式给 DeepSeek 等非 claude-* 名)
 * @param {string} opts.permissionMode        如 'acceptEdits'
 * @param {number} opts.maxTurns              最大工具轮数
 * @param {number} opts.timeoutMs             超时(触发 abort)
 * @param {string[]} opts.additionalDirectories agent 可读的额外目录(附件 inbox)
 * @param {string} opts.systemPrompt          角色框架
 * @param {Record<string,string>} opts.anthropicEnv ANTHROPIC_* 环境(已含兜底)
 * @param {AbortController} opts.abortController 取消句柄(由调用方持有,用于优雅退出)
 * @returns {Promise<string>} 回复文本(错误场景以 [错误] 开头)
 */
export async function askClaude(prompt, {
  cwd,
  model,
  permissionMode,
  maxTurns,
  timeoutMs,
  additionalDirectories,
  systemPrompt,
  anthropicEnv,
  abortController,
  resumeSessionId,
}) {
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    let finalText = null;
    let sessionId = null;
    const gen = query({
      prompt,
      options: {
        cwd,
        model,
        permissionMode,
        maxTurns,
        // 会话续接:resume 指定 session_id,让同一会话保持上下文(桥接层会话记忆)
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        // options.env 会整体替换子进程环境,必须展开 ...process.env 保留 PATH(Windows)
        // IM_AGENT_BRIDGE 标记:让 CLI 结果推送 hook 跳过 bridge 内部的 agent 会话(防回推/防刷屏)
        env: { ...process.env, ...anthropicEnv, ANTHROPIC_MODEL: model, IM_AGENT_BRIDGE: '1' },
        additionalDirectories,
        systemPrompt,
        canUseTool: permissionGate,
        disallowedTools,
        abortController,
      },
    });

    for await (const msg of gen) {
      if (msg.type === 'result') {
        sessionId = msg.session_id || null;
        if (msg.subtype === 'success') finalText = msg.result;
        break;
      }
    }

    if (finalText === null) return { text: '[错误] Claude Code 未返回结果(可能达到轮数上限或中断)', sessionId };
    return { text: finalText, sessionId };
  } catch (err) {
    if (abortController.signal.aborted) {
      return { text: '[错误] 处理超时(>' + Math.round(timeoutMs / 1000) + 's),已终止', sessionId: null };
    }
    const msg = String(err?.message || err);
    if (/reached maximum number of turns|max.*turns/i.test(msg)) {
      return { text: '[错误] 达到最大轮数上限(' + maxTurns + ')', sessionId: null };
    }
    console.error('[claude] agent 调用失败: ' + msg);
    return { text: '[错误] Claude Code 不可用: ' + msg.slice(0, 200), sessionId: null };
  } finally {
    clearTimeout(timer);
  }
}

// ── 回复清理:DeepSeek 偶发输出 DSML/XML 工具标记或工具执行错误,避免泄到用户端 ──
export function stripDsml(text) {
  if (!text) return text;
  const regex = /<\/?(?:｜｜|\|\|)?DSML(?:｜｜|\|\|)?(?:tool_calls|invoke|parameter|function_call|dsml)|<\/?(?:invoke|tool_calls|parameter|function_call|dsml)/i;
  const match = text.match(regex);
  if (match) {
    const idx = match.index;
    const stripped = text.substring(0, idx).trim();
    console.log('[claude] DSML/XML 已剥离(位置 ' + idx + ',保留 ' + stripped.length + ' 字符)');
    return stripped;
  }
  return text;
}

export function stripToolErrors(text) {
  if (!text) return text;
  const regex = /⚠️\s*🛠️\s+.+/i;
  const match = text.match(regex);
  if (match) {
    const idx = match.index;
    const before = text.substring(0, idx).trim();
    console.log('[claude] 工具错误标记已剥离(位置 ' + idx + ',保留 ' + before.length + ' 字符)');
    return before;
  }
  return text;
}

export function cleanAiResponse(text) {
  return stripToolErrors(stripDsml(text));
}

/**
 * UTF-8 安全截断:从第 maxBytes 个字节回溯到有效字符边界,不劈汉字。
 */
export function truncateUtf8(str, maxBytes) {
  if (!str) return str;
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + '\n\n…(回复过长,已截断)';
}
