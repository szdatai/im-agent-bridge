# IM ↔ Claude Code Bridge

> **English** | [中文](README.md)

A bidirectional bridge between **multi-channel IM bots** (WeCom / DingTalk / WeChat / Feishu) and a **Claude Code headless agent**.

Send a message to your bot from any connected IM while away from your computer — the bridge launches a Claude Code headless agent (via `query()`, working in your project directory) to execute the task, then replies back to the same IM in a single message.

```
IM message (long connection) ─▶ bridge.mjs ─▶ claude-agent-sdk query() ─▶ headless agent (cwd=target project)
      ▲                                                                                       │
      └────────────── one-shot reply to original channel ◀─ cleanup/truncate ◀─ agent result ──┘
```

## Supported Channels

| Channel | SDK | Connection | Credentials |
|---|---|---|---|
| WeChat | iLink protocol (account files) | Long-polling `getupdates` | QR-login account files |
| WeCom | `@wecom/aibot-node-sdk` | WebSocket long connection | BotID + Secret |
| Feishu / Lark | `@larksuiteoapi/node-sdk` | WebSocket long connection | App ID + App Secret |
| DingTalk | `dingtalk-stream` | Stream-mode long connection | AppKey + AppSecret |

`ENABLED_CHANNELS` controls which channels are loaded. Channels without credentials are skipped automatically and do not affect the others.

## Features

- **Multi-channel access**: WeCom / DingTalk / Feishu use WebSocket long connections (no public IP, no callback URL, no message encryption; SDKs handle reconnect & auth). WeChat uses the iLink protocol (QR login, multi-account).
- **Claude Code headless agent**: built on `@anthropic-ai/claude-agent-sdk` `query()`; the SDK bundles its own CLI binary, no system install needed.
- **Secure by default**:
  - Per-channel `X_ALLOWLIST` whitelist (falls back to global `ALLOWLIST`, then fail-closed);
  - `acceptEdits` permission mode auto-accepts file edits;
  - Destructive commands (`rm -rf`, `git push --force`, `git clean -fx`, `docker rm`, `drop database`, `curl | sh`, …) are blocked by a two-layer guard: `disallowedTools` + `canUseTool`;
  - Model credentials are read only from `.env` / `~/.claude/settings.json`, never hardcoded.
- **Queueing**: serial per (channel + session), with a global concurrency cap (default 3).
- **Attachments**: images/files from each platform are decrypted to `inbox/`, readable by the agent; paired with a follow-up instruction within 30s.
- **Health check**: `GET http://127.0.0.1:18794/health` (includes per-channel status).
- **Timeout & truncation**: 180s agent timeout auto-aborts; oversized replies are truncated to 18000 bytes at UTF-8-safe boundaries.

## Quick Start

Requirements: Node.js ≥ 22.9 (uses `--env-file-if-exists`).

```bash
# 1. Install dependencies
npm install

# 2. Copy the config template and fill in real values
cp .env.example .env
#    edit .env: ENABLED_CHANNELS + per-channel credentials + per-channel ALLOWLIST

# 3. Start
node --env-file-if-exists=.env bridge.mjs
#    or: start.bat / ./start.sh

# 4. Verify
curl http://127.0.0.1:18794/health
#    → {"status":"connected","channels":{"wecom":"connected",...}, ...}
```

Then send a message to the bot from the connected IM and you'll get a reply from the Claude Code agent.

### Getting Credentials & Discovering your userid

- **WeCom**: Admin console → App Management → Smart Robot → API mode → Long connection → BotID + Secret. Whitelist userids can be looked up in the admin console.
- **DingTalk**: Open Platform → App Development → Enterprise internal app → AppKey + AppSecret. Whitelist userid (`senderStaffId`) can be grabbed from the console or the log.
- **WeChat**: iLink QR login generates an account file placed in `WECHAT_ACCOUNTS_DIR`; the process scans every 10s and auto-launches new accounts.
- **Feishu**: Open Platform → Developer console → Custom app → Credentials & Basic Info (enable the bot capability and subscribe to `im.message.receive_v1`). Whitelist `open_id` can be grabbed from the log of non-whitelisted messages.

> Tip: send one message to the bot — the bridge logs the `senderId` of the sender. Put that value into the channel's `X_ALLOWLIST`.

## Quick Command Templates

Send these as-is — the agent works in `WORK_DIR` (default: your project) autonomously: reads files, edits code, runs commands, then replies to the same IM in one message.

| Scenario | Send this |
|---|---|
| Project structure | List the top-level directories of <project> and what each is for |
| Recent commits | Show the last 10 git commits and summarize each |
| Working tree | Run git status and summarize uncommitted changes |
| Run tests | Find and run the core module tests, report the results |
| Syntax check | Run a syntax/static check on <file> |
| Add a field | Add field <field> to <DocType>, create the migration and register it |
| Change logic | Modify <logic> in <file>, explain your changes |
| Check errors | Look at recent log errors and analyze the cause |
| Fix a bug | <describe the symptom>, find the root cause, fix it, and run related tests to confirm |
| Code review | Review the changes on <branch/commit> and list issues |
| Run a command | Run <command> and explain the output |
| Explain code | Explain what <file> does and its key logic |

**Tips**:
- Be specific (file/path/acceptance criteria) for more accurate results;
- After editing code, append "run the related tests to confirm";
- Send an image/file, then add an instruction within 30s for the agent to read it;
- Use absolute paths in the instruction to work outside the working directory.

## Channel Maintenance Page

The bridge ships a local admin page (bound to `127.0.0.1` only):

```
http://127.0.0.1:<BRIDGE_PORT>/
```

What you can do:

- See real-time status of all 4 channels (connected / disconnected / not configured) and overall health (model, queue, uptime);
- Edit each channel's credentials & whitelist online (`💾 Save config` → writes `.env`; leave secret fields empty to keep the existing value);
- `🔄 Restart process` → gracefully restarts the bridge (spawns a detached instance then exits) so new config takes effect;
- WeChat accounts directory & account list (account files dropped there are auto-launched within 10s).

APIs: `/api/status`, `/api/config` (GET masked / POST save), `/api/restart`, `/api/wechat/accounts`, `/health`.

## Configuration

See [`.env.example`](./.env.example). Highlights:

| Variable | Description |
|---|---|
| `ENABLED_CHANNELS` | Enabled channels (wecom/dingtalk/wechat/feishu, comma-separated); missing creds are skipped |
| `ALLOWLIST` | Global whitelist fallback; used when a channel has no `X_ALLOWLIST`, otherwise fail-closed |
| `WECOM_*` | WeCom credentials + `WECOM_ALLOWLIST` |
| `DINGTALK_*` | DingTalk credentials + `DINGTALK_ALLOWLIST` |
| `WECHAT_*` | WeChat iLink base URL + accounts dir + whitelist (`WECHAT_OPEN=1` open by default, `0` = require whitelist) |
| `FEISHU_*` | Feishu App ID/Secret + `FEISHU_ALLOWLIST` |
| `WORK_DIR` | Agent working directory; defaults to the parent of this project |
| `PERMISSION_MODE` | `acceptEdits` by default; `default` for stricter checking |
| `BRIDGE_PORT` | Health/admin port, default 18794 |
| `MAX_CONCURRENT` | Global concurrency cap, default 3 |
| `QUEUE_MAX_DEPTH` | Per (channel+session) queue depth, default 5 |
| `AGENT_TIMEOUT_MS` | Per-call agent timeout, default 180000 |
| `MAX_TURNS` | Max agent tool-use turns, default 40 |
| `ANTHROPIC_*` | Model auth; leave empty to fall back to `~/.claude/settings.json` env |

### Model Auth

The agent connects via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL`
(the same DeepSeek/Anthropic setup you use with Claude Code). Precedence:

1. `ANTHROPIC_*` in `.env`;
2. `env` block of `~/.claude/settings.json` (only `ANTHROPIC_*` keys are passed to the child process to avoid leaking unrelated tokens).

## Permissions & Security

`acceptEdits` auto-approves file edits and filesystem commands (`mkdir/touch/rm/mv/cp/sed`) inside the working directory (Claude Agent SDK semantics). Therefore:

- **Hard-blocking destructive commands relies on `disallowedTools` (deny rules)** — they take the highest precedence and override both `acceptEdits` auto-approval and any project-settings allow rules;
- Other non-filesystem destructive commands (`git push --force`, `git clean -fx`, `docker rm`, `drop database`, `curl | sh`) are caught by the `canUseTool` permission gate via content regex;
- For **per-command review** (stronger security, less convenience), set `PERMISSION_MODE=default` — then `canUseTool` inspects every tool call.

Edge cases:

| Scenario | Handling |
|---|---|
| Agent timeout (180s) | Aborts and replies "timeout"; `maxTurns: 40` backstop |
| Oversized reply | UTF-8-safe truncation to 18000 bytes + marker |
| Channel disconnect | Each channel's SDK auto-reconnects; replies have simple retry |
| Concurrent messages | Serial per (channel+session) + global cap 3 |
| Agent crash / spawn failure | Replies "Claude Code unavailable" |
| Attachment with no follow-up in 30s | Temp file expires |
| SIGINT / SIGTERM | Abort all agents → disconnect → exit |

## Auto-Start (with Claude Code, global self-registration)

**On first bridge start, a global hook is written automatically**: `bridge.mjs` calls
`ensureGlobalAutoStart()` in `src/autoregister.mjs`, which adds a **`SessionStart` hook** to
`~/.claude/settings.json` (idempotent: skips if already registered; auto-updates the path if the
project is moved; keeps a `settings.json.bak` backup before modifying). After that, starting
Claude Code **from any directory** auto-checks and launches the bridge in the background.

The written hook:

```json
{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command",
    "command": "node <bridge-path>/scripts/autostart.mjs" }] }] } }
```

`scripts/autostart.mjs` guard logic:
- **Already running** (health port reachable) → exits immediately, no duplicate;
- **Not running** → launches detached in the background, logs to `logs/bridge.log`, returns instantly (does not block the session);
- The bridge also self-protects against double instances: it exits when the health port is taken (EADDRINUSE), to avoid stealing the WeCom long connection;
- The bridge's own agent sessions also trigger this hook, but the port is already occupied → the guard skips, so no recursion.

To register manually without starting the bridge:

```bash
node scripts/autostart.mjs   # launch the bridge
node --input-type=module -e "import('./src/autoregister.mjs').then(m=>m.ensureGlobalAutoStart().then(r=>console.log(r.reason)))"
```

## CLI ↔ IM Remote Control

Start a Claude Code task in the terminal, leave your desk — stay on top of progress and results from your IM (WeChat / WeCom / DingTalk / Feishu), pushed via the bridge + each channel.

### Three kinds of push

| Type | Trigger | Example | Toggle |
|---|---|---|---|
| Result push | Session ends (Stop / StopFailure hook, `push-claude-all.mjs`) | `[14:30] 【Claude Code 完成】…final result summary…` | Always on; target = configured PUSH_* channels |
| Progress push | Key tool calls during a task (PostToolUse hook) | `[14:32] 【进行中】📝 src/foo.py`, `[14:33] ⚙️ npm test` | Admin page "进度推送" switch (`PUSH_PROGRESS`) |
| Decision alert | Claude asks / requests permission (AskUserQuestion / PermissionRequest hook) | `⚠️ Claude Code 需要你决策:continue modifying…? Options: continue / undo` | Always on |

### Config

| Variable | Description |
|---|---|
| `PUSH_TO` | Result push target WeChat wxid |
| `PUSH_DINGTALK_CONV_ID` | Result push target DingTalk openConversationId |
| `PUSH_DINGTALK_ROBOT_CODE` | DingTalk robot code (required to send) |
| `PUSH_FEISHU_TO` | Result push target Feishu receive_id (chat_id / open_id) |
| `WECOM_WEBHOOK_URL` | WeCom group robot webhook (in settings.json env) |
| `PUSH_PROGRESS` | Progress push switch: `1` = on (toggled from the admin page) |

Channels without a configured target are skipped; every push carries a `[HH:MM]` timestamp.

### Two additional pushes

- **IM task-completion auto-push (option 1)**: tasks sent to the agent via WeChat/WeCom/DingTalk/Feishu push a result summary (with source, e.g. `[wechat 任务完成]`) to `PUSH_TO` on completion;
- **Manual CLI push (option 2)**: in a session, have the agent run `node D:/AI/im-agent-bridge/scripts/push.mjs "text"` (or just say "push the result to WeChat") to push a message manually.

### Notes & limits

- Progress/decision pushes have a cooldown (10s / 5s) to avoid spam;
- The bridge's own agent sessions (`IM_AGENT_BRIDGE`) are skipped — no self-push loops;
- Decision alerts only tell you to "return to the computer" — **you cannot answer decisions remotely from WeChat** (interactive sessions require terminal input);
- Related hooks are registered automatically in `~/.claude/settings.json` (Stop / StopFailure / PostToolUse / AskUserQuestion / PermissionRequest).

## Project Structure

```
im-agent-bridge/
├── package.json          # type:module; start scripts
├── bridge.mjs            # single entry: dynamically loads channels by ENABLED_CHANNELS
├── scripts/
│   ├── autostart.mjs     # auto-start guard (port probe + detached launch)
│   ├── push-claude-result.mjs   # CLI result push hook
│   ├── push-claude-progress.mjs # CLI progress push hook
│   └── push-claude-decision.mjs # CLI decision alert hook
├── public/
│   └── index.html        # channel maintenance web UI
├── src/
│   ├── config.mjs        # multi-channel config loading + settings.json fallback
│   ├── core.mjs          # orchestration: whitelist/attachment-pairing/queue/agent/reply
│   ├── claude.mjs        # askClaude (query wrapper) + permission gate + reply cleanup
│   ├── queue.mjs         # per (channel+session) serial + global concurrency semaphore
│   ├── admin.mjs         # management web server (static page + /api/*)
│   ├── autoregister.mjs  # global SessionStart hook self-registration
│   └── channels/
│       ├── wecom.mjs     # WeCom (@wecom/aibot-node-sdk)
│       ├── dingtalk.mjs  # DingTalk (dingtalk-stream)
│       ├── wechat.mjs    # WeChat (iLink account files)
│       └── feishu.mjs    # Feishu/Lark (@larksuiteoapi/node-sdk)
├── .env.example          # config template (copy to .env)
└── inbox/                # attachment temp storage (created at runtime, gitignored)
```

## License

[MIT](./LICENSE)
