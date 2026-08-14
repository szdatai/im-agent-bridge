# WeCom ↔ Claude Code Bridge

企业微信(WeCom)智能机器人与 **Claude Code 无头 agent** 的双向桥接进程。

离开电脑时,通过企业微信向机器人发指令,桥接进程启动 Claude Code 无头 agent
(以 `query()` 运行,工作目录为你的项目仓库)执行任务,再把结果一次性回复到企微。

```
企微消息(长连接) ──▶  bridge.mjs  ──▶  claude-agent-sdk query()  ──▶  无头 agent(cwd=项目仓库)
       ▲                                                                        │
       └───────────────────── 企微 replyStream ◀── 一次性回复 ◀── agent result ──┘
```

## 特性

- **企微长连接接入**:基于 `@wecom/aibot-node-sdk` 的 WebSocket 长连接,无需公网 IP、
  无需回调 URL、无需消息加解密;内置自动重连与鉴权。
- **Claude Code 无头 agent**:基于 `@anthropic-ai/claude-agent-sdk` 的 `query()`,
  SDK 自带 CLI 二进制,无需系统安装 claude。
- **安全默认值**:
  - 仅响应 `WECOM_ALLOWLIST` 白名单用户;
  - `acceptEdits` 权限模式自动接受文件编辑;
  - 破坏性命令(`rm -rf`、`git push --force`、`git clean -fx`、`docker rm`、
    `drop database`、`curl | sh` 等)经 `disallowedTools` + `canUseTool` 双层拦截;
  - 模型凭据只从 `.env` / `~/.claude/settings.json` 读取,不写入代码。
- **队列**:每个会话串行处理 + 全局并发上限(默认 3),避免同时跑太多 agent。
- **附件**:企微图片/文件经 `downloadFile` 解密落盘 `inbox/`,agent 可读取。
- **健康检查**:`GET http://127.0.0.1:18794/health`。
- **超时与截断**:agent 单次 180s 超时自动终止;回复超长时按 UTF-8 安全截断(18000 字节)。

## 快速开始

要求:Node.js ≥ 22.9(使用 `--env-file-if-exists`)。

```bash
# 1. 安装依赖
npm install

# 2. 复制配置模板并填写真实值
cp .env.example .env
#    编辑 .env:WECOM_BOT_ID / WECOM_BOT_SECRET / WECOM_ALLOWLIST(必填)

# 3. 启动
node --env-file-if-exists=.env bridge.mjs
#    或:start.bat / ./start.sh

# 4. 验证
curl http://127.0.0.1:18794/health
#    → {"status":"connected", ...}
```

然后在企微里给机器人发消息,即可收到 Claude Code agent 的回复。

### 企微机器人凭据获取

企业微信管理后台 → 应用管理 → 智能机器人 → 开启 **API 模式** → 选择**「长连接」**
→ 获取 **BotID** 与 **Secret**。

### 获取你的 userid

白名单需要填你的企微 userid。让机器人接收一条你发的消息,bridge 日志会打印
`senderId`;也可以从企微后台用户详情查询。

## 配置说明

见 [`.env.example`](./.env.example)。要点:

| 变量 | 必填 | 说明 |
|---|---|---|
| `WECOM_BOT_ID` / `WECOM_BOT_SECRET` | ✅ | 企微智能机器人长连接凭据 |
| `WECOM_ALLOWLIST` | ✅ | 允许响应的企微 userid(逗号分隔);白名单外忽略 |
| `WECOM_ALLOW_CHATIDS` | - | 限定可响应的会话 chatid(逗号分隔) |
| `WORK_DIR` | - | agent 工作目录;留空默认取本目录上一级 |
| `PERMISSION_MODE` | - | 默认 `acceptEdits`;更严格可设 `default` |
| `BRIDGE_PORT` | - | 健康检查端口,默认 18794 |
| `MAX_CONCURRENT` | - | 全局并发上限,默认 3 |
| `QUEUE_MAX_DEPTH` | - | 单会话排队上限,默认 5 |
| `AGENT_TIMEOUT_MS` | - | agent 单次超时,默认 180000 |
| `MAX_TURNS` | - | agent 最大工具轮数,默认 40 |
| `ANTHROPIC_*` | - | 模型认证;留空自动读 `~/.claude/settings.json` 的 env 块兜底 |

### 模型认证

agent 通过 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL` 连到
模型端点(可与 Claude Code 日常使用相同的 DeepSeek/Anthropic 配置)。优先级:

1. `.env` 中的 `ANTHROPIC_*`;
2. `~/.claude/settings.json` 的 `env` 块(仅透传 `ANTHROPIC_*` 键,避免泄露无关 token)。

## 权限与安全

`acceptEdits` 会自动批准**工作目录内**的文件编辑与 `mkdir/touch/rm/mv/cp/sed` 等
文件系统命令(Claude Agent SDK 语义)。因此:

- **破坏性命令的硬拦截依赖 `disallowedTools`(deny 规则)**,它优先级最高,能覆盖
  `acceptEdits` 的自动批准与项目自身 settings 的 allow 规则;
- 其余非文件系统破坏性命令(`git push --force`、`git clean -fx`、`docker rm`、
  `drop database`、`curl | sh`)由 `canUseTool` 权限门按命令内容正则拦截;
- 如需**每个命令**都过一遍审查(更强的安全性、牺牲一点便利),把
  `PERMISSION_MODE` 设为 `default`,此时 `canUseTool` 会审查全部工具调用。

边界情况:

| 场景 | 处理 |
|---|---|
| Agent 超时 180s | 中止并回复「处理超时」;`maxTurns: 40` 兜底 |
| 回复超长 | UTF-8 安全截断至 18000 字节并标记 |
| 企微断线 | SDK 自动重连;回复带简单重试 |
| 多消息并发 | 每会话串行 + 全局并发上限 3 |
| agent 崩溃 / spawn 失败 | 回复「Claude Code 不可用」 |
| 附件 30s 无后续指令 | 临时文件过期清理 |
| SIGINT / SIGTERM | 中止全部 agent → 断开连接 → 退出 |

## 自动启动(随 Claude Code,全局自注册)

**首次启动 bridge 时自动写入全局 hook**:`bridge.mjs` 启动时会调用
`src/autoregister.mjs` 的 `ensureGlobalAutoStart()`,把一条 **`SessionStart` hook**
写入 `~/.claude/settings.json`(幂等:已注册则跳过;项目移动后自动替换为新路径;
修改前自动留 `settings.json.bak` 备份)。此后**任意目录**启动 Claude Code 都会自动
检查并后台拉起 bridge,无需手动 `npm start`。

写入的 hook:

```json
{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command",
    "command": "node <bridge路径>/scripts/autostart.mjs" }] }] } }
```

`scripts/autostart.mjs` 守卫逻辑:
- **已在运行**(健康检查端口可达)→ 直接退出,不重复启动;
- **未运行** → detached 后台拉起,日志写入 `logs/bridge.log`,立即返回不阻塞会话;
- bridge 自身也带防双实例保护:健康端口被占用(EADDRINUSE)时自动退出,避免抢企微长连接;
- bridge 的 agent 也会触发该 hook,但端口已被占用 → 直接跳过,不会递归。

如需手动立即注册(不启动 bridge),可执行:

```bash
node scripts/autostart.mjs   # 拉起 bridge
node --input-type=module -e "import('./src/autoregister.mjs').then(m=>m.ensureGlobalAutoStart().then(r=>console.log(r.reason)))"
```

## 项目结构

```
wecom-claude-bridge/
├── package.json      # type:module;start 脚本
├── bridge.mjs        # 唯一入口(企微 WS + 编排 + 队列 + 优雅退出)
├── src/
│   ├── config.mjs    # 配置加载 + settings.json 兜底
│   ├── claude.mjs    # askClaude(query 封装)+ 权限门 + 回复清理
│   ├── queue.mjs     # 每会话串行 + 全局并发信号量
│   └── health.mjs    # HTTP /health
├── .env.example      # 配置模板(复制为 .env)
└── inbox/            # 附件临时落盘(运行时创建,gitignore)
```

## License

[MIT](./LICENSE)
