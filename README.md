# IM ↔ Claude Code Bridge

多通道 IM(企业微信 / 钉钉 / 微信 / 飞书)智能机器人与 **Claude Code 无头 agent**
的双向桥接进程。

离开电脑时,通过任一已接入的 IM 向机器人发指令,桥接进程启动 Claude Code 无头 agent
(以 `query()` 运行,工作目录为你的项目仓库)执行任务,再把结果一次性回复到原 IM。

```
IM 消息(长连接) ──▶ bridge.mjs ──▶ claude-agent-sdk query() ──▶ 无头 agent(cwd=目标项目)
      ▲                                                                         │
      └────────────────── 原通道一次性回复 ◀── 清理/截断 ◀── agent result ────────┘
```

## 支持通道

| 通道 | SDK | 连接方式 | 凭据 |
|---|---|---|---|
| 企微 wecom | `@wecom/aibot-node-sdk` | WebSocket 长连接 | BotID + Secret |
| 钉钉 dingtalk | `dingtalk-stream` | Stream 模式长连接 | AppKey + AppSecret |
| 微信 wechat | iLink 协议(账号文件) | 长轮询 getupdates | 扫码登录账号文件 |
| 飞书 feishu | `@larksuiteoapi/node-sdk` | WebSocket 长连接 | App ID + App Secret |

`ENABLED_CHANNELS` 控制启用哪些通道;未配置凭据的通道自动跳过,不影响其他通道。

## 特性

- **多通道接入**:企微/钉钉/飞书走 WebSocket 长连接(无需公网 IP、无需回调 URL、
  无需消息加解密,SDK 内置自动重连与鉴权);微信走 iLink 协议(扫码登录、多账号)。
- **Claude Code 无头 agent**:基于 `@anthropic-ai/claude-agent-sdk` 的 `query()`,
  SDK 自带 CLI 二进制,无需系统安装 claude。
- **安全默认值**:
  - 每通道 `X_ALLOWLIST` 白名单(通道未设则回落全局 `ALLOWLIST`,再否则 fail-closed);
  - `acceptEdits` 权限模式自动接受文件编辑;
  - 破坏性命令(`rm -rf`、`git push --force`、`git clean -fx`、`docker rm`、
    `drop database`、`curl | sh` 等)经 `disallowedTools` + `canUseTool` 双层拦截;
  - 模型凭据只从 `.env` / `~/.claude/settings.json` 读取,不写入代码。
- **队列**:每个 通道+会话 串行处理 + 全局并发上限(默认 3),避免同时跑太多 agent。
- **附件**:各平台图片/文件解密落盘 `inbox/`,agent 可读取;30s 内与后续指令配对。
- **健康检查**:`GET http://127.0.0.1:18794/health`(含各通道状态)。
- **超时与截断**:agent 单次 180s 超时自动终止;回复超长时按 UTF-8 安全截断(18000 字节)。

## 快速开始

要求:Node.js ≥ 22.9(使用 `--env-file-if-exists`)。

```bash
# 1. 安装依赖
npm install

# 2. 复制配置模板并填写真实值
cp .env.example .env
#    编辑 .env:ENABLED_CHANNELS + 各通道凭据 + 各通道 ALLOWLIST

# 3. 启动
node --env-file-if-exists=.env bridge.mjs
#    或:start.bat / ./start.sh

# 4. 验证
curl http://127.0.0.1:18794/health
#    → {"status":"connected","channels":{"wecom":"connected",...}, ...}
```

然后在对应 IM 里给机器人发消息,即可收到 Claude Code agent 的回复。

### 各通道凭据获取与 userid 发现

- **企微**:管理后台 → 应用管理 → 智能机器人 → API 模式 → 长连接 → BotID + Secret。
  白名单 userid 可从后台用户详情查询。
- **钉钉**:开放平台 → 应用开发 → 企业内部应用 → AppKey + AppSecret。
  白名单 userid(senderStaffId)可从后台或日志抓取。
- **微信**:iLink 扫码登录生成账号文件放入 `WECHAT_ACCOUNTS_DIR`,进程 10s 扫描自动拉起。
- **飞书**:开放平台 → 开发者后台 → 自建应用 → 凭证与基础信息(需开通机器人能力并
  订阅 `im.message.receive_v1`)。白名单 open_id 可从非白名单消息日志抓取。

> 白名单发现技巧:让机器人接收一条你发的消息,bridge 日志会打印 `senderId`,
> 把该值填入对应通道的 `X_ALLOWLIST` 即可。

## 通道维护页

bridge 内置一个本地管理页(仅绑定 127.0.0.1):

```
http://127.0.0.1:<BRIDGE_PORT>/
```

功能:
- 查看 4 个通道的实时状态(已连接 / 未连接 / 未配置)与整体健康(模型、队列、运行时长);
- 在线编辑各通道凭据与白名单(`💾 保存配置` → 写入 `.env`,密钥留空=保持不变);
- `🔄 重启进程` → 优雅重启 bridge(detached 拉起新实例后退出),让新配置生效;
- 微信账号目录与账号列表(扫码登录生成的账号文件放入后 10s 自动拉起)。

接口:`/api/status`、`/api/config`(GET 掩码 / POST 保存)、`/api/restart`、`/api/wechat/accounts`、`/health`。

## 配置说明

见 [`.env.example`](./.env.example)。要点:

| 变量 | 说明 |
|---|---|
| `ENABLED_CHANNELS` | 启用通道(wecom/dingtalk/wechat/feishu,逗号分隔);未配凭据自动跳过 |
| `ALLOWLIST` | 全局白名单兜底;通道未设 `X_ALLOWLIST` 时使用,再否则 fail-closed |
| `WECOM_*` | 企微凭据 + `WECOM_ALLOWLIST` 白名单 |
| `DINGTALK_*` | 钉钉凭据 + `DINGTALK_ALLOWLIST` 白名单 |
| `WECHAT_*` | 微信 iLink baseUrl + 账号目录 + 白名单 |
| `FEISHU_*` | 飞书 App ID/Secret + `FEISHU_ALLOWLIST` 白名单 |
| `WORK_DIR` | agent 工作目录;留空默认取本目录上一级 |
| `PERMISSION_MODE` | 默认 `acceptEdits`;更严格可设 `default` |
| `BRIDGE_PORT` | 健康检查端口,默认 18794 |
| `MAX_CONCURRENT` | 全局并发上限,默认 3 |
| `QUEUE_MAX_DEPTH` | 单 通道+会话 排队上限,默认 5 |
| `AGENT_TIMEOUT_MS` | agent 单次超时,默认 180000 |
| `MAX_TURNS` | agent 最大工具轮数,默认 40 |
| `ANTHROPIC_*` | 模型认证;留空自动读 `~/.claude/settings.json` 的 env 块兜底 |

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
| 任一通道断线 | 各通道 SDK 自动重连;回复带简单重试 |
| 多消息并发 | 每 通道+会话 串行 + 全局并发上限 3 |
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
im-agent-bridge/
├── package.json      # type:module;start 脚本
├── bridge.mjs        # 唯一入口:按 ENABLED_CHANNELS 动态加载通道
├── scripts/
│   └── autostart.mjs # 自动启动守卫(端口探测 + detached 拉起)
├── src/
│   ├── config.mjs    # 多通道配置加载 + settings.json 兜底
│   ├── core.mjs      # 多通道编排:白名单/附件配对/队列/agent/回复
│   ├── claude.mjs    # askClaude(query 封装)+ 权限门 + 回复清理
│   ├── queue.mjs     # 每 通道+会话 串行 + 全局并发信号量
│   ├── health.mjs    # HTTP /health(含各通道状态)
│   ├── autoregister.mjs # 全局自动启动 hook 自注册
│   └── channels/
│       ├── wecom.mjs     # 企业微信(@wecom/aibot-node-sdk)
│       ├── dingtalk.mjs  # 钉钉(dingtalk-stream)
│       ├── wechat.mjs    # 微信(iLink 账号文件)
│       └── feishu.mjs    # 飞书(@larksuiteoapi/node-sdk)
├── .env.example      # 配置模板(复制为 .env)
└── inbox/            # 附件临时落盘(运行时创建,gitignore)
```

## License

[MIT](./LICENSE)
