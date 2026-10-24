# 同类「Agent CLI ↔ 聊天平台」桥接项目调研

> 调研日期：2026-10-23。只读调研，没有改仓库。
> star 数和最后活跃时间来自 `gh api repos/...` 的 `stargazers_count` / `pushed_at`，取于调研当天。
> 标 **未核实** 的条目来自二手资料或记忆，没有在源码或官方文档里确认。

---

## 0. 我们现在的情况（cli-in-wechat，327★，2026-10-24 有推送）

对照 README.md、src/bridge/router.ts、src/adapters/*.ts、src/ilink/*.ts 整理：

- **已有**：5 个 CLI（Claude 走 Agent SDK，失败时退回 CLI；Codex、Gemini、Kimi、OpenCode 走子进程，OpenCode 另有 SDK/JSONL 两条路径）；`@tool` 切换、`>>` 接力、`@a>b` 链式调用；40+ 个 `/` 命令；`/resume` 浏览历史会话；`/session set` 和终端互相接续；`/fork`、`/cancel`；`/msgmode` 有 verbose/normal/compact 三档；AskUserQuestion 转发到微信，回编号作答；媒体收发（图片、文件、视频，AES 解密）；`/send` 和 `wcli send`；allowedUsers 白名单；单实例锁；按 context_token 计的发送配额和 outbox 持久化，用户发「继续」可恢复排队消息。
- **已确认的缺口**
  1. **工具权限审批不存在**：`src/adapters/claude.ts` 的 `canUseTool` 只拦截 `AskUserQuestion`，其他工具一律 `allow`。所以即使 `/mode safe`（SDK `permissionMode: 'default'`），工具也被静默放行，不会问用户。另外 4 个 CLI 在 `safe` 下要么没有交互通道（子进程 `-p` 模式），要么被沙箱拦下后直接失败。
  2. **流式不均衡**：Claude、OpenCode 有 `onIntermediate` 中间消息；Codex、Gemini 声明了 `streaming: true`，但 grep 不到 `onIntermediate` 调用，大概是结束后一次性返回（**未核实**运行时行为）；Kimi 是 `streaming: false`。另外微信 iLink 不能编辑已发消息，每条用户消息对应的 context_token 只有约 10 条的发送额度（`DEFAULT_QUOTA_LIMITS.maxItemsPerToken = 10`），所以只能「分条推送 + 限额」，做不到「原地编辑」。
  3. **只有微信一个平台**：`Router` 构造函数直接依赖 `ILinkClient`，入参类型是 `WeixinMessage`（issue #17 想要飞书）。

---

## 1. 同类项目一览（按相关度排序）

| # | 项目 | ★ | 最后推送 | 语言 | 一句话 |
|---|---|---|---|---|---|
| 1 | [chenhg5/cc-connect](https://github.com/chenhg5/cc-connect) | 16,079 | 2026-10-24 | Go | 最全面的「多 Agent × 多平台」桥，**已经支持个人微信 ilink**，是直接竞品 |
| 2 | [slopus/happy](https://github.com/slopus/happy) | 24,287 | 2026-10-23 | TS | 自带 App（iOS/Android/Web）+ 加密中继，不走 IM |
| 3 | [tiann/hapi](https://github.com/tiann/hapi) | 5,287 | 2026-10-19 | TS/Bun | Happy 的本地优先替代，自带原生 App、PWA，一键审批 |
| 4 | [op7418/Claude-to-IM-skill](https://github.com/op7418/Claude-to-IM-skill)（核心库 [op7418/Claude-to-IM](https://github.com/op7418/Claude-to-IM) 472★） | 2,894 | 2026-03-23 | TS/Node20 | **技术栈和我们最接近**；Telegram/Discord/飞书/QQ/微信，审批走按钮或回 1/2/3 |
| 5 | [RichardAtCT → overwirehq/claude-code-telegram](https://github.com/overwirehq/claude-code-telegram) | 2,816 | 2026-10-01 | Python | Telegram 单平台做得最深：cron、webhook、语音、成本、审计 |
| 6 | [siteboon/claudecodeui (CloudCLI)](https://github.com/siteboon/claudecodeui) | 14,258 | 2026-10-22 | TS | Web/移动 UI，有插件系统，不走 IM |
| 7 | [JessyTsui/Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) | 1,287 | 2025-12-06 | JS | 邮件/Telegram/LINE，靠 hooks + tmux/PTY 注入；基本停更 |
| 8 | [Johnixr/claude-code-wechat-channel](https://github.com/Johnixr/claude-code-wechat-channel) | 312 | 2026-03-24 | TS | 用官方 Channels（MCP）协议把微信 ilink 接进**正在运行的** Claude Code 会话 |
| 9 | [LinekForge/claude-code-wechat](https://github.com/LinekForge/claude-code-wechat) → [forge-hub](https://github.com/LinekForge/forge-hub)（23★） | — | 2026-06-02 | TS/Bun | 微信 Channel，**能在微信里远程审批**，后来并入 forge-hub（微信/TG/飞书/iMessage） |
| 10 | [zebbern/claude-code-discord](https://github.com/zebbern/claude-code-discord) | 233 | 2026-08-01 | Deno/TS | Discord：每个会话一个 thread、Allow/Deny 按钮、rewind、RBAC、Docker |
| 11 | [JayZtwo/codex-feishu](https://github.com/JayZtwo/codex-feishu) | 9 | 2026-04-16 | TS | Codex app-server + 飞书长连接，审批卡片、线程切换卡片 |
| 12 | [mpociot/claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot) | 180 | 2025-06-27 | TS | 早期 Slack 示例：Socket Mode，一个 thread 一个会话，编辑消息做流式；已停更 |
| 参考 | [openclaw/openclaw](https://github.com/openclaw/openclaw) | 392,891 | 2026-10-24 | TS | 通用 AI 助手，20 多个渠道；它的微信插件 `openclaw-weixin` 和我们用的是同一套 ilink 协议 |

**官方能力**
- **Claude Code Remote Control**（[文档](https://code.claude.com/docs/en/remote-control)）：在本机跑 `claude remote-control` 或 `/rc`，然后从 claude.ai/code 或 Claude App 接管本地会话，多端同步，能传图片和文件；server 模式支持 `--spawn worktree`、`--capacity`（默认 32）、`--permission-mode`。需要 Pro/Max/Team/Enterprise 订阅，**不支持 API key**，也不支持自定义 `ANTHROPIC_BASE_URL`。
- **Claude Code Channels**（[文档](https://code.claude.com/docs/en/channels)、[reference](https://code.claude.com/docs/en/channels-reference)）：research preview。channel 本质是 MCP server，把外部事件推进**正在运行的**会话。官方插件有 Telegram、Discord、iMessage（都要 Bun）。用配对码把用户加进 allowlist。channel 可以声明 **permission relay capability**，把权限提示转发到聊天里审批。第三方可以用 `--dangerously-load-development-channels` 测试自己的 channel（Johnixr、LinekForge 的微信 channel 就是这么跑的）。
- **Claude in Slack**：@Claude 时开一个**云端**会话（见 channels 文档里的对比表）。
- **Codex Slack 集成**（[文档](https://developers.openai.com/codex/integrations/slack)）：@Codex 开一个**云端** task，可读 thread 上下文，完成后回一个链接，可以合并或拉回本地。需要付费 ChatGPT 计划、GitHub 和 cloud environment。这和「控制本机 CLI」不是一回事。

> 结论：官方路线是「自家 App 远程控制」或「云端 task」，**不覆盖微信、飞书、钉钉**，也不覆盖 Codex、Gemini、Kimi 的本机 CLI。国内 IM + 多 CLI 这个位置目前主要是 cc-connect 和 Claude-to-IM 在做。

---

## 2. 逐个项目拆解

### 2.1 cc-connect（Go，16k★，最重要的参照）
- **CLI**：Claude Code、Codex、Cursor Agent、Gemini CLI、Qoder、OpenCode、iFlow、Kimi、Pi、Copilot、Devin，以及任何 **ACP**（Agent Client Protocol）agent，还有 tmux、antigravity 等。
- **平台（13+）**：飞书/Lark、WPS 协作、钉钉、Telegram、Slack、Discord、LINE、企业微信、微博、**个人微信（ilink）**、QQ（NapCat/OneBot）、QQ 官方 Bot、Matrix、Google Chat、Webex 等。除 LINE 和企业微信 webhook 外都**不需要公网 IP**（飞书 WS、钉钉 Stream、Slack Socket Mode、Discord Gateway、TG 长轮询）。
- **架构**：每个 agent 一个**常驻进程会话**（`AgentSession.Send/Events/RespondPermission`），不是每条消息起一次 `-p`。Claude Code 以 `--permission-prompt-tool stdio` 启动，走 stream-json 控制协议（见 docs/usage.md「Claude Code PermissionRequest Hooks」）；Codex 走 `app-server`（`agent/codex/appserver_session.go`）；Copilot、ACP 走 JSON-RPC。
- **平台抽象**（`core/interfaces.go`，见第 4 节）：核心 `Platform` 接口只有 5 个方法，其余能力拆成几十个**可选接口**，按需实现：`MessageUpdater`、`StreamingCardPlatform`、`InlineButtonSender`、`CardSender`、`ImageSender`、`FileSender`、`TypingIndicator`、`ProgressUpdateThrottler`、`ReplyContextReconstructor`（cron 主动推送用）、`FormattingInstructionProvider`（往系统提示里注入平台 markdown 方言）等。
- **会话**：按用户/会话 key 隔离；`/new /list /switch /current /history`；空闲 30 分钟自动开新会话（`reset_on_idle_mins`）；多 workspace（一个 thread 绑一个目录）；`/dir` 有历史；`/model` 切换时保留会话。
- **流式**：`[stream_preview]` 节流参数为 `interval_ms=1500`、`min_delta_chars=30`、`max_chars=2000`，在 TG/Discord/飞书上原地编辑；钉钉 AI Card 和飞书卡片是流式卡片；`progress_style = legacy | compact | card`；显示模式 full/compact/quiet（quiet 模式结束时加一个 done 表情，用来触发推送）；按平台配置出站限速（`outgoing_rate_limit.platforms.weixin` 等）。
- **审批**：回复 `allow / deny / allow all`；飞书、TG 等用卡片或按钮（飞书需要订阅 `card.action.trigger`）；`/allow <tool>` 预授权；`/mode` 可选 default/acceptEdits/auto/plan/yolo；`/ps`、`/btw` 在任务运行中补充指令（steer）。
- **多用户/权限**：`allow_from` 白名单；`admin_from` 限定特权命令（`/dir /shell /restart /upgrade`）；`run_as_user` 用另一个 Unix 用户跑 agent 做文件系统隔离，并有 `doctor user-isolation` 预检；入站限速 `[rate_limit]`。
- **部署**：npm、Homebrew、二进制；`daemon` 支持 launchd/systemd/Windows；`cc-connect update` 自更新；Web 管理台（:9820）带 i18n；Management API；Bridge 协议（外部适配器可通过 WS 接入）。
- **其他**：自然语言 cron 和 timer、语音 STT/TTS、多 bot 在群里 relay、`/memory` 编辑 CLAUDE.md、provider 切换、用量统计、5 种界面语言、`NO_REPLY` 静默回复、`cc-connect send --image/--file`（让 agent 主动回传附件，和我们的 `wcli send` 是同一个思路）。

### 2.2 Claude-to-IM（-skill）（TS，Node 20，2.9k★，最值得借鉴代码结构）
- **CLI**：Claude（Agent SDK `query()`）、Codex（Codex SDK `runStreamed()`），通过 `CTI_RUNTIME` 选择。
- **平台**：Telegram、Discord、飞书、QQ（只支持私聊）、微信（扫码登录，单账号）。
- **架构**：host 无关的桥接库（`src/lib/bridge/`），模块包括 `channel-adapter.ts`（抽象基类）、`channel-router.ts`、`conversation-engine.ts`、`delivery-layer.ts`、`permission-broker.ts`、`markdown/{ir,render,telegram,discord,feishu}.ts`（先转成统一 IR，再按平台渲染）、`security/rate-limiter.ts`。以 Claude Code / Codex 的 skill 形式安装，后台 daemon（`daemon.sh`）运行，`doctor` 做自检。
- **审批**：`permission-gateway.ts` 在 SDK 的 `canUseTool` 里挂起 → 发 Allow/Deny 按钮（TG/Discord）或卡片（飞书）；不支持按钮的平台（QQ/微信）用文本 `/perm ...` 或快捷回复 `1/2/3`；**5 分钟超时自动拒绝**。
- **流式**：TG/Discord 用草稿预览（`sendPreview` 返回 `sent | skip | degrade`，可以自动降级）；飞书用 **CardKit v2 流式卡片**（`onStreamText/onToolEvent/onStreamEnd`，节流 200ms）；QQ 和微信没有流式预览。
- **飞书实现细节**：用 `@larksuiteoapi/node-sdk` 的 `WSClient` + `EventDispatcher`，注册 `card.action.trigger`；源码注释写着要 **monkey-patch `WSClient.handleEventData`**，因为 SDK 当时只处理 `type="event"`，卡片回调是 `type="card"`，不打补丁会被丢掉（新版 SDK 是否已修复：**未核实**）。
- **安全**：config.env 权限 600；日志按模式脱敏；按用户/频道/guild 设白名单。

### 2.3 claude-code-telegram（Python，2.8k★，仓库已转到 overwirehq）
- 只支持 Claude（SDK 为主、CLI 兜底）+ Telegram。
- 会话按「用户 + 项目目录」持久化（SQLite）；`/repo` 切仓库时自动恢复对应会话；可选「project threads」模式，一个 Telegram topic 一个项目。
- 流式：「Working... (8s)」加实时工具行；`/verbose 0|1|2`（和我们的 msgmode 一样）；typing 状态一直保持。
- 安全：`ALLOWED_USERS` 白名单 + 可选 token 认证、`APPROVED_DIRECTORY` 目录沙箱、防路径穿越、令牌桶限速、审计日志、`CLAUDE_MAX_COST_PER_USER` 单用户花费上限。
- 其他：webhook API server（GitHub HMAC）、cron 调度器、通知服务、语音转写（Whisper/Voxtral/whisper.cpp）、会话导出为 MD/HTML/JSON、classic 模式（内联键盘快捷操作）、成本追踪。
- 工具审批：README 只写了「16 个可配置工具的 allow/disallow 列表」，**没看到逐次审批按钮**（未核实）。

### 2.4 happy（slopus，24k★）/ hapi（tiann，5.3k★）
- 路线：**不走 IM，自己做 App**。`happy claude` / `happy codex` 包装本地 CLI，经 E2E 加密中继同步到手机 App，App 能收推送、一键审批、多人共看一个会话。happy 现在转向 desktop + 多模型 harness（README 提到 Astra/Fable/Grok）。
- hapi：「本地优先」的 Happy 替代；支持 Claude/Codex/Cursor/Grok/OpenCode/Kimi/Copilot/Pi 等；手机上一键审批、Web 终端、语音助手、workspace 浏览器；relay 用 WireGuard+TLS 端到端加密，也可以走 Cloudflare Tunnel / Tailscale。
- 对我们的启发：「本地终端 ↔ 远程」**无缝接力**（我们有 `/session set`，可以再顺一点）；审批推送体验；多 agent 统一会话列表。

### 2.5 CloudCLI / claudecodeui（14k★）
- Web/PWA UI，支持 Claude/Cursor/Codex/OpenCode，能自动发现已有会话，带插件系统（终端、成本计算、任务队列等）。不属于 IM 桥，但「会话自动发现」和「成本插件」可以参考。

### 2.6 Claude-Code-Remote（1.3k★，2025-12 后停更）
- 通过 Claude **hooks**（Stop/Notification）发通知 → 邮件/TG/LINE；回邮件或回消息时，把命令经 **tmux / PTY 注入**终端。
- 有意思的地方：**邮件通道**带完整执行轨迹；这是一种「通知驱动」模式，不是「对话驱动」。

### 2.7 微信 Channel 系（Johnixr 312★、LinekForge → forge-hub）
- 用官方 **Channels/MCP 协议**把微信消息推进**正在运行的交互式** Claude Code 会话（`claude --dangerously-load-development-channels server:wechat`），回复走 `wechat_reply` 工具。
- LinekForge 版本支持 **微信内远程审批**（借 Channels 的 permission relay）、重启后回放最近 200 条记忆、随机时间心跳、白名单；后来并入 forge-hub，支持多通道和多实例路由。
- 局限：只支持 Claude、依赖 research preview flag、会话关掉通道就断、一个 ClawBot 只能连一个 agent 实例，需要 claude.ai 登录。

### 2.8 claude-code-discord（zebbern，233★）
- 每个会话开一个 Discord thread；会话中途可以中断、换模型、换权限模式、rewind；AskUserQuestion 和权限审批都用按钮；MCP 管理；RBAC（`ADMIN_ROLE_IDS/USER_IDS`）；频道监控（其他 bot 报警后自动开 thread 排查，30 秒防抖）；有 Docker compose 部署。

### 2.9 codex-feishu（JayZtwo）
- 基于 Codex `app-server`（`thread/start`、`turn/start` RPC）+ 飞书长连接；流式更新卡片；**审批卡片**（命令和文件改动）；线程列表卡片、切换和新建按钮；「桌面线程忙时只读跟随」；launchd / PowerShell 守护；`doctor`。

### 2.10 claude-code-slack-bot（mpociot，2025-06 停更）
- 早期参考：Socket Mode、一个 thread 一个会话、编辑消息做流式。

---

## 3. 能力对照与缺口（按建议优先级排序）

简写：CC=cc-connect，C2IM=Claude-to-IM，TG=claude-code-telegram，DC=claude-code-discord，Ours=cli-in-wechat。

| 优先级 | 我们缺的能力 | 谁做得好 | 价值 / 难度 | 备注 |
|---|---|---|---|---|
| **P0** | **真正的工具权限审批**（safe 模式下逐次 Allow/Deny/Allow-all + 超时自动拒绝） | CC、C2IM、DC、forge-hub、codex-feishu | 高 / 中 | Claude SDK 路径改 `canUseTool` 就能做（已有 AskUserQuestion 的挂起和回复机制可复用）。微信没有按钮，只能「回 1/2/3」或「y/n/all」，可参考 C2IM 的微信做法。要注意审批消息会**占用 context_token 发送配额**。Codex 要换成 app-server 或 exec 的 approval 通道，Gemini 可能要 ACP 模式（**未核实** 细节）。 |
| **P0** | **会话中补充指令（steer）/ 排队**：任务运行中发消息时，要么插进当前 turn，要么明确排队 | CC（`/ps` `/btw`）、DC（queue + Cancel） | 高 / 中 | 当前运行中再发消息的行为需要确认（**未核实**）；常驻进程架构才好做 steer。 |
| **P1** | **常驻进程会话**（stream-json 双向 / app-server / ACP），代替每条消息 spawn `-p` | CC | 高 / 高 | 这是审批、steer、流式三件事的共同基础。工程量最大，可以一个 adapter 一个 adapter 地迁。 |
| **P1** | **流式统一**：Codex/Gemini/Kimi 补上中间进度；进度合并成一条（compact 进度）+ 节流参数 | CC（`stream_preview`、`progress_style`）、TG（`/verbose`） | 中 / 中 | 微信不能编辑消息，只能做「节流 + 合并 + 配额感知」；换到飞书就能原地更新卡片。 |
| **P1** | **平台抽象层 + 第二个平台（飞书）** | CC、C2IM | 高 / 中高 | 见第 4 节。 |
| **P2** | **定时任务 / cron**（自然语言），以及主动推送 | CC、TG、forge-hub（心跳） | 中 / 中 | 微信主动推送受 context_token 限制（要等用户先发过消息？**未核实** iLink 是否允许无 token 主动发送）。 |
| **P2** | **daemon 化**（launchd/systemd 安装、`doctor` 自检、自更新） | CC、C2IM、codex-feishu | 中 / 低 | 现在要靠 `npm run dev` 前台运行。 |
| **P2** | **成本/用量统计 + 单用户预算** | TG、CC（`/usage`） | 中 / 低 | 我们有 `/budget`、`/stats`，可以补上按用户累计和告警。 |
| **P2** | **空闲自动开新会话**（防上下文漂移） | CC（`reset_on_idle_mins`） | 中 / 低 | 小改动。 |
| **P3** | 多工作区/每个会话一个 git worktree | 官方 Remote Control `--spawn worktree`、CC 多 workspace | 中 / 中 | |
| **P3** | 语音消息 STT（微信自带 voice_item.text 可以直接用） | CC、TG、C2IM | 中 / 低 | C2IM 的做法是只用微信自带的转写文本。 |
| **P3** | 特权命令分级（admin_from）、run_as_user 隔离、入站限速 | CC、TG、DC | 中 / 中 | 多人共用时才需要。 |
| **P3** | Web 管理台 / i18n / 多 bot 群内 relay | CC | 低 / 高 | 不建议跟。 |
| **P3** | webhook 触发（CI 报警 → 自动排查） | TG、DC、官方 Channels | 低 / 中 | |

**我们已经有、别人少有的**：`>>` 工具接力和 `@a>b` 链式调用（CC 的多 bot relay 是近似功能）；微信引用消息智能路由；`/resume` 编号浏览；配额感知的 outbox 和「继续」恢复（这是 iLink 特有的问题，CC 也做了 send budget）。

---

## 4. 多平台支持专题（issue #17：飞书）

### 4.1 别人怎么抽象平台

**cc-connect（Go）：最小核心接口 + 大量可选能力接口**

```go
type Platform interface {
    Name() string
    Start(handler MessageHandler) error
    Reply(ctx, replyCtx any, content string) error
    Send(ctx, replyCtx any, content string) error
    Stop() error
}
// 可选：MessageUpdater / StreamingCardPlatform{CreateStreamingCard→Update/Finalize}
//      InlineButtonSender / CardSender / ImageSender / FileSender
//      TypingIndicator / ProgressUpdateThrottler / ReplyContextReconstructor
//      FormattingInstructionProvider / CommandRegistrar ...
```
- `replyCtx any` 是一个不透明的回复上下文，由平台自己定义（微信放 context_token，飞书放 message_id/chat_id）。core 不解析它。
- 引擎在运行时做类型断言，平台不支持某能力时自动降级（例如没有按钮就退回文本 allow/deny）。

**Claude-to-IM（TS）：抽象基类 + 可选钩子 + 注册表**
- 必须实现：`start/stop/isRunning/consumeOne()/send(OutboundMessage)/validateConfig/isAuthorized`。
- 可选：`answerCallback`、`getPreviewCapabilities/sendPreview/endPreview`（草稿式流式）、`onStreamText/onToolEvent/onStreamEnd`（卡片式流式）、`onMessageStart/End`（typing）。
- `registerAdapterFactory(type, factory)` 注册；markdown 先转统一 IR，再按平台渲染；审批放在独立的 `permission-broker`，和平台解耦。

**共同点**：① 入站消息统一成 `{platform, chatId, userId, text, media[], replyTo, raw}`；② 出站按能力分层：纯文本 → 编辑 → 卡片/按钮 → 流式卡片；③ 审批、AskUserQuestion 作为「交互请求」，由平台决定用按钮还是文本编号来渲染；④ 会话 key = `platform:chatId[:threadId]`；⑤ 平台特有的限流和配额放在平台层（cc-connect 的 `outgoing_rate_limit.platforms.*`）。

### 4.2 飞书开放平台能提供什么（以官方文档为准）

| 能力 | 说明 | 来源 |
|---|---|---|
| **长连接（WebSocket）收事件** | **不需要公网 IP/域名/内网穿透**；SDK 负责加解密和鉴权；Node SDK `@larksuiteoapi/node-sdk` ≥ 1.24.0；**只支持企业自建应用**；事件处理必须在 **3 秒内**完成（否则重推）；每个应用最多 50 条连接；**集群模式**，多客户端时随机只有一个收到 | [官方：使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case) |
| **卡片回调** | `card.action.trigger`，用来接按钮点击（审批、选项）；cc-connect 文档要求订阅这个事件；C2IM 源码说 Node SDK 的 WSClient 要打补丁才能收到 `type="card"`（新版是否修复：**未核实**）；回调里应先快速 ACK，再异步更新卡片（三方经验） | [cc-connect docs/feishu.md](https://github.com/chenhg5/cc-connect/blob/main/docs/feishu.md)、C2IM `feishu-adapter.ts` |
| **更新已发卡片（PATCH message）** | 只能更新 14 天内的消息；卡片 ≤ 30KB；**单条消息 5 QPS**；需要 `config.update_multi: true`；权限 `im:message` / `im:message:send_as_bot` / `im:message:update` 任一 | [官方：更新已发送的消息卡片](https://open.larkoffice.com/document/server-docs/im-v1/message-card/patch.md) |
| **CardKit 流式卡片** | 先建卡片实体，作为 interactive 消息发出，再按元素推送**累计文本**（sequence 严格递增），结束时退出 streaming_mode；流式期间不能放按钮/折叠面板（三方说法）；建议每张卡 < 10 QPS（三方说法）；有三方博客称普通消息编辑存在未公开的次数上限（约 20–30 次）（**未核实**） | [三方：feishu-streaming-card](https://pypi.org/project/feishu-streaming-card/)、[CSDN 踩坑文](https://damodev.csdn.net/697c7eb5a16c6648a98634d5.html)；官方 CardKit 文档**未直接核实** |
| **所需权限（典型）** | `im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`，加事件 `im.message.receive_v1`、回调 `card.action.trigger`；发版本要经过管理员审核 | cc-connect docs/feishu.md、C2IM README |
| **文件** | 消息资源下载有大小限制，cc-connect 用 HTTP Range 分块下载绕开 code=234037 | cc-connect v1.5.1-beta.1 changelog |

**和微信 iLink 对比**：飞书能**编辑消息/流式卡片**、有**按钮回调**、能**主动发消息**（不受 context_token 配额限制）、支持群聊 @、有 thread（话题）。代价是要建企业自建应用、配权限、发版审核，比扫码麻烦。用户在 issue #17 提到的痛点是「每个微信号只能建一个机器人」，飞书一个租户可以建多个应用，能对应多个 agent 或项目。

### 4.3 给我们加平台抽象层的可行性评估（只评估，不建议现在动手）

**现状耦合度（实测）**
- `Router`（1575 行）直接持有 `ILinkClient`，调用面不大：`onMessage` ×1、`sendText` ×14、`sendImage` ×2、`sendFile` ×2、`sendVideo` ×2、`startTyping` ×3，另外通过类型断言用了 `getDeliveryStatus`、`recoverPending`（配额和恢复）。入口类型是 `WeixinMessage`，实际只读 `from_user_id` 和 `content` 等少数字段。
- 媒体：`DownloadedMedia` 已经和平台无关；下载和 AES 解密在 `utils/media.ts`，属于微信专有。
- 微信专有逻辑集中在 `src/ilink/`（auth、client、outbox、quota、delivery-planner、text-chunk），边界比较清楚。
- Adapter 层（CLI 侧）已经有 `CLIAdapter` 接口，**和平台无关**，不需要改。

**建议的抽象形态（供决策参考）**
- 定义 `ChatPlatform` 接口：`start(onMessage)`、`sendText(chatKey, text, opts)`、`sendMedia(...)`、`startTyping(...)`；可选能力 `updateMessage`、`sendInteractive(prompt, options) → Promise<choice>`（审批和 AskUserQuestion 共用）、`createStreamingCard`、`deliveryStatus/recoverPending`（微信配额专用）。
- 入站统一成 `InboundMessage { platform, chatKey, userId, text, refText, media[], raw }`；会话 key 从 `uid` 改成 `platform:uid`（**需要迁移现有 session 文件**）。
- 把 `ILinkClient` 包成 `WeixinPlatform`，行为不变（第一步只做「无功能变化的重构」）。
- `formatter.ts` 按平台渲染 markdown：微信是纯文本，飞书是卡片 markdown。

**工作量粗估（未核实，按单人熟悉代码估算）**

| 阶段 | 内容 | 估算 |
|---|---|---|
| 1 | 抽出 `ChatPlatform` 接口 + `WeixinPlatform` 包装 + session key 迁移 + 回归测试 | 2–4 人日 |
| 2 | 飞书基础版：WSClient 收消息、文本回复、白名单、私聊 | 2–3 人日 |
| 3 | 飞书增强：卡片 markdown、PATCH/CardKit 流式、按钮审批（`card.action.trigger`）、图片和文件收发 | 4–7 人日 |
| 4 | 配置和文档（多平台 config schema、飞书建应用指引） | 1–2 人日 |
| 合计 | | **约 9–16 人日** |

**风险**
- 路由器里有不少微信特有语义（引用消息路由、「继续」恢复、配额裁剪、typing），抽象时容易漏掉或把行为改坏，需要先补测试。
- 飞书 WS 的 3 秒处理时限：收到事件要立即 ACK，然后异步跑 CLI（我们现在微信长轮询是同步串行，模型不同）。
- 单应用多连接是集群模式：同一个飞书应用不能多开实例（和我们的单实例锁一致）。
- 如果先做 P0 审批，最好一开始就把它设计成「交互请求」抽象，再接平台，避免以后返工。

**替代方案**：不自己做多平台，在 README 里引导需要飞书的用户用 cc-connect（它已经支持个人微信和飞书）。缺点是等于把用户让出去。或者只把我们的 CLI 层做成 ACP/Bridge 协议，接进 cc-connect 的 Bridge（docs/bridge-protocol.md）——这条路**未核实**是否可行。

---

## 5. 来源
- cc-connect：https://github.com/chenhg5/cc-connect （README、`core/interfaces.go`、`docs/usage.md`、`docs/feishu.md`、`docs/weixin.md`、`config.example.toml`）
- Claude-to-IM-skill：https://github.com/op7418/Claude-to-IM-skill ；核心库：https://github.com/op7418/Claude-to-IM （`src/lib/bridge/channel-adapter.ts`、`adapters/feishu-adapter.ts`）
- claude-code-telegram：https://github.com/overwirehq/claude-code-telegram
- happy：https://github.com/slopus/happy ；hapi：https://github.com/tiann/hapi
- CloudCLI：https://github.com/siteboon/claudecodeui
- Claude-Code-Remote：https://github.com/JessyTsui/Claude-Code-Remote
- 微信 Channel：https://github.com/Johnixr/claude-code-wechat-channel 、https://github.com/LinekForge/claude-code-wechat 、https://github.com/LinekForge/forge-hub
- claude-code-discord：https://github.com/zebbern/claude-code-discord
- codex-feishu：https://github.com/JayZtwo/codex-feishu
- claude-code-slack-bot：https://github.com/mpociot/claude-code-slack-bot
- OpenClaw：https://github.com/openclaw/openclaw
- Claude Code Remote Control：https://code.claude.com/docs/en/remote-control
- Claude Code Channels：https://code.claude.com/docs/en/channels 、https://code.claude.com/docs/en/channels-reference
- Codex in Slack：https://developers.openai.com/codex/integrations/slack
- 飞书长连接：https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
- 飞书更新卡片：https://open.larkoffice.com/document/server-docs/im-v1/message-card/patch.md
- 飞书流式卡片（三方）：https://pypi.org/project/feishu-streaming-card/ 、https://damodev.csdn.net/697c7eb5a16c6648a98634d5.html
- 本仓库 issue #17：https://github.com/sgaofen/cli-in-wechat/issues/17
