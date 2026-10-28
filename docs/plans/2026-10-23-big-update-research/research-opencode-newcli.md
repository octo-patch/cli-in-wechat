# 调研：OpenCode 现状 + 候选新 CLI（2026-10-23）

> 只读调研，没有改任何仓库文件。npm 版本和周下载量是 2026-10-23 用 `npm view` 和 `api.npmjs.org` 实时查的；GitHub 星数用 GitHub API 查。没能直接核实的内容都标了 **未核实**。
> 当前仓库：`src/adapters/` 有 claude / codex / gemini / kimi / opencode（opencode.ts、opencode-jsonl.ts、opencode-sdk.ts），**没有任何 ACP 客户端**。

---

## Part A — OpenCode

### A1. 版本现状

| 包 | 最新版本 | 周下载 | 备注 |
|---|---|---|---|
| `opencode-ai`（V1 CLI） | **1.19.4**（2026-10-22） | 218 万 | npm `latest` 仍指向 1.x |
| `@opencode-ai/sdk`（V1 SDK，仓库在用 `^1.18.18`） | **1.19.4** | 1733 万 | 含 `./v2` 子路径导出 |
| `@opencode/cli`（**V2 CLI**） | **2.1.4**（2026-10-24） | 32 万 | 2.0.0 于 2026-09-11 发布 |
| `@opencode/client`（V2 HTTP 客户端） | 2.1.4 | 31.5 万 | |
| `@opencode/sdk`（V2 SDK） | 2.1.4 | 5 万 | 进程内宿主，基于 Effect，**不开监听端口** |
| Homebrew core `opencode` | **2.1.3** | — | Homebrew core 已经跟到 V2 |

仓库已改名为 `anomalyco/opencode`（原 sst/opencode），22 万星，MIT。

1.18 以来值得注意的 release（来源 https://github.com/anomalyco/opencode/releases ）：
- 1.18.31：修复 ACP 在 load/resume/fork 时 session 的 model、effort、mode 恢复问题（`opencode acp` 仍在维护）。
- 1.19.0：新增 `opencode upgrade --major` 升级到 V2；不再自动更新。
- 1.19.1：**session 分享功能下线**（share 链接、share 命令都没了）。
- 1.19.2：1.x 锁在 1.x 线；**Homebrew core 安装跳过 1.x 更新，改跟 V2**。
- 1.19.3/1.19.4：reasoning 变体配置；Bun 1.4.4 安全更新。

OpenCode 2.0 的主要变化（来源 https://alternativeto.net/news/2026/10/opencode-2-0-officially-launches-with-background-agents-code-mode-and-a-rebuilt-api/ 、 https://capitalandcompute.net/blog/opencode-2-0-what-changed/ ）：
- 改成共享后台服务（`opencode service status`），**server API 完全重做**，V1 插件不兼容。
- 权限配置：`permission` 改成有序的 `permissions` 数组；工具名改了：`bash→shell`、`task→subagent`、`write/patch→edit`。
- `agent/mode→agents`、`provider→providers` 等配置键改名；读 AGENTS.md 不读 CLAUDE.md；不再跑 LSP。
- V2 安装器会**替换** `opencode` 命令。用户用 brew 或 `npm i -g @opencode/cli` 装的话，PATH 里的 `opencode` 就是 V2。
- `@opencode/sdk` 2.x 的 README（看的是 npm pack 出来的文件）：`OpenCode.create()` → `opencode.sessions.create({location:{directory}})` → `opencode.sessions.prompt({sessionID,text})`，不开端口；默认数据库在内存，持久化要传 `database.path`。依赖 `effect@4` 和 `@types/bun`，**能不能在 Node 20 上跑：未核实**。

### A2. opencode-sdk.ts 里过时或有风险的地方（按严重程度排）

1. **【确定的 bug】权限事件名已经变了。** adapter 监听的是 `case 'permission.updated'`（opencode-sdk.ts:420）。但 1.19.4 服务端源码里发的事件是 **`permission.asked`**（`packages/schema/src/v1/permission.ts:61` 有 `define({ type: "permission.asked" ... })`，回复事件叫 `permission.replied`）。`permission.updated` 只在 SDK 根入口那份旧的生成类型里还有。
   - 后果：safe/plan 模式下没人拒绝权限，session 会一直挂到 1 小时超时；auto 模式下只要配置里有任何 `ask` 规则，也会挂住。
   - 新事件的 payload 是 `{id, sessionID, permission, patterns[], metadata, always[], tool?{messageID,callID}}`，**没有 `title` 字段**，所以拒绝提示应改用 `permission` + `patterns`。
   - 回复接口：新的是 `POST /permission/{requestID}/reply`，body 为 `{reply:'once'|'always'|'reject', message?}`（v2 客户端里是 `client.permission.reply`）。旧的 `POST /session/{id}/permissions/{permissionID}`（`permission.respond`）在 1.19.4 的 httpapi 里还在，可以继续用，但已不是主路径。
   - 建议同时处理 `permission.asked` 和 `permission.updated`，单测的 fake 也要补上 `permission.asked`。
2. **question 工具**：服务端有 `question.asked`，配套 `/question/{id}/reply` 和 `/question/{id}/reject` 接口。没处理的话，模型一调 question 工具就会挂住。这个事件正好能映射到 `ExecOptions.askUser`。server 模式下 question 工具是否默认开启：**未核实**。
3. **用的是根入口的旧类型**：`@opencode-ai/sdk` 的 `./v2` 子路径（`@opencode-ai/sdk/v2`）才对应当前服务端（有 `permission.asked`、`message.part.delta`、`session.status`、`question.*`）。建议把 import 迁到 `/v2`，去掉 `as any` / `@ts-ignore`。
4. **V2 兼容风险**：`createOpencode()` 会从 PATH 起 `opencode serve`。如果用户的 `opencode` 是 V2（比如 brew 装的），V1 SDK 对 V2 的新 API 很可能全挂。`resolveModelArg` 里调的 `opencode models` 输出格式在 V2 是否变了：**未核实**。建议启动时检测 `opencode --version` 的主版本，遇到 2.x 给出明确报错或回退方案。
5. **图片**：现在只在文本里拼文件路径（`buildMediaPrompt`）。SDK 的 prompt 支持 `FilePartInput {type:'file', mime, url, filename}`，图片可以用 data URL 或 file URL 原生传给模型。
6. 固定探测 `127.0.0.1:4096` 还是老问题；1.19.1 分享功能下线跟本 adapter 无关。
7. **长期方向**：`opencode acp` 在 V1（1.19.4）和 V2（2.1.4）里**都有**。ACP 注册表里同时列了 `opencode` 和 `opencode-v2` 两项，启动参数都是 `acp`。做通用 ACP adapter 的话，可以一次兼容 V1 和 V2，不用再追两套 SDK。
   （模型过滤由 PR #33 负责，这里不涉及。）

---

## Part B — 候选新 CLI

### B0. 关键发现

1. **ACP 已经是事实标准。** 官方注册表 https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json 现在列了 43 个 agent，其中有 Qwen Code、Copilot、Cursor、CodeBuddy、Qoder、Factory Droid、Cline、Auggie、goose、Kimi、Gemini、OpenCode（V1 和 V2）、Kilo、MiniMax Code、GLM Agent、pi-acp、Amp（第三方 amp-acp）、Mistral Vibe 等。ACP 规范版本 schema-v1.26.0（2026-10-16）；TS SDK `@agentclientprotocol/sdk` 是 **2.0.2**（主版本刚升到 2）。
   **结论：先做一个通用 ACP adapter，之后每加一个 CLI 基本就是一行配置。**
2. **竞品重叠**：Qwen Code 0.26 自带 `qwen configure-weixin` 和 `qwen channel start`（用 iLink bot 扫码登录微信，跟本项目走同一套微信 iLink 接口），还有钉钉、飞书 channel。CodeBuddy Code 也自带微信、企微远程控制（见其 CHANGELOG）。本项目的差异化在于"一个微信同时驱动多家 CLI"。（证据：npm pack 解出来的 `@qwen-code/qwen-code@0.26.0` cli.js，以及 `@tencent-ai/codebuddy-code@2.174.0` 的 CHANGELOG.md）
3. **本机 `~/.local/bin/qwen` 不是 Qwen Code**：它是个 bash 包装脚本，内容是"pi + 本地 Qwen3.8-27B（mlx-dspark 服务，端口 8099）"。按要求跑了 `qwen --version` 和 `qwen --help`，结果两次都触发了"拉起本地模型服务"，而且都启动失败（模型路径报错），事后确认没有残留进程。Qwen Code 的参数是从 npm 包和官方文档核实的。

### B1. 逐个对比

| CLI | 最新版本 | 热度 | 非交互 / 流式 JSON | 续接 session | 权限 | 模型 | 图片 | ACP | SDK | 授权 / 许可 | 中国热度 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Qwen Code** `@qwen-code/qwen-code` | 0.26.0 | 2.87 万星；npm 4.8 万/周 | `-p`；`-o text\|json\|stream-json`（Claude Code 风格：`system/session_start`、`assistant`、`result`）；`--include-partial-messages`；`--input-format stream-json` | `--continue`、`--resume [id]`、`--session-id` | `--approval-mode plan\|default\|auto-edit\|auto\|yolo`、`-y` | `-m` | 有 `--image` 字符串（**具体用法未核实**），ACP 可传图 | `--acp`（`--experimental-acp` 已弃用） | `@qwen-code/sdk` 0.1.22（TS），另有 Python/Java alpha | Apache-2.0；**Qwen OAuth 免费额度已于 2026-04-15 关闭**，现在要用阿里云 Coding Plan、Token Plan 或自带 key | **高**（阿里系，国内直连） |
| **CodeBuddy Code** `@tencent-ai/codebuddy-code` | 2.174.0 | npm 13.2 万/周 | `-p/--print`；`--output-format text\|json\|stream-json`；`--input-format` | `--resume`、`--continue`、`--session-id` | `--permission-mode`、`-y/--dangerously-skip-permissions`（非交互必须加） | `--model` | 未核实 | `--acp` | `@tencent-ai/agent-sdk` 0.3.289 | 闭源；腾讯云 CodeBuddy 账号；国内版免费额度未核实 | **高**（腾讯；参数几乎是 Claude Code 的翻版） |
| **GitHub Copilot CLI** `@github/copilot` | 1.0.103 | npm 129.8 万/周；1.1 万星 | `-p`；`--output-format json`（JSONL）；`-s/--silent` | `-r/--resume[=id\|name]`、`--continue` | `--allow-all-tools`（程序化调用必须加）、`--allow-all`、`--allow-tool/--deny-tool`、`--no-ask-user` | `--model`（含 `auto`） | `--attachment PATH` | `--acp` | `@github/copilot-sdk` 1.0.26（117 万/周） | 闭源；需要 Copilot 订阅（有 Free 档）；token 用细粒度 PAT（需 "Copilot Requests" 权限），经典 `ghp_` 不支持 | 中（国内访问 GitHub 稳定性一般，**未核实**） |
| **Cursor CLI**（`agent` / `cursor-agent`） | 2026.10.22 | `@cursor/sdk` 50 万/周 | `-p`；`--output-format text\|json\|stream-json`；`--stream-partial-output` | `--resume [chatId]`、`--continue` | `-f/--force/--yolo`、`--sandbox`、`--trust`、`--approve-mcps` | `--model` | 未核实 | `agent acp`（隐藏子命令） | `@cursor/sdk` 1.0.40 | 闭源；Cursor 订阅 + `CURSOR_API_KEY` | 中高（国内 Cursor 用户多；地区与模型限制未核实） |
| **Qoder CLI** `@qoder-ai/qodercli` | 1.1.78（注册表里写的是 0.2.14） | npm 5.6k/周 | `-p`；`-o text\|json\|stream-json` | 未核实 | `--yolo`（等价于 `--permission-mode bypass_permissions`） | 未核实 | 未核实 | `--acp` | 未核实 | 阿里 Qoder 账号；国内版是 `qoderclicn` | 中高（iFlow 停服后官方推荐迁到这里） |
| **Factory Droid** `droid` | 0.249.0 | npm 5.9k/周 | `droid exec`；`-o text\|json\|stream-json\|stream-jsonrpc`；`--input-format stream-json` | `-s/--session-id`（必须带 prompt） | 默认只读；`--auto low\|medium\|high`；`--skip-permissions-unsafe` | `-m` | 未核实 | `exec --output-format acp-daemon` | `@factory/droid-sdk` 0.10.0 | 闭源；需要 Factory 账号 | 低 |
| **Cline CLI** `cline` | 3.0.73 | 7.08 万星（含 IDE 插件）；npm 4.8 万/周 | `cline --json "..."`（JSONL，最后一行 `run_result`） | `--id <session-id>` | `--auto-approve <bool>`（非 ACP 下默认 true）、`-p/--plan` | `-m`（BYOK） | 未核实 | `--acp` | 未核实 | Apache-2.0；BYOK，可接国产模型 | 中 |
| **Augment Auggie** | 0.36.0 | npm 1.9 万/周 | `--print`、`--quiet`、`--output-format json` | `-c`、`-r [id]` | `--permission <rule>`、`--ask` | `--model` | `--image` | `--acp` | `@augmentcode/auggie-sdk` 0.2.0 | 闭源；付费 credits | 低 |
| **goose** `aaif-goose/goose` | v1.56.0 | 5.56 万星 | `goose run -t`；`--output-format text\|json\|stream-json`；`--no-session` | 有 session 机制（参数未核实） | 未核实 | 配置文件 | 未核实 | `goose acp` | Rust 库 | Apache-2.0；BYOK；已归 Linux 基金会 AAIF | 低中 |
| **pi** `@mariozechner/pi-coding-agent` | 0.73.1 | npm 18.5 万/周 | `-p`；`--mode json`（JSONL 事件）；`--mode rpc` | `-c`、`-r`、`--session <id>` | **没有权限弹窗**（设计如此） | `--model provider/id[:thinking]` | `pi -p @img.png "..."` | 第三方 `pi-acp` 0.0.34 | `@mariozechner/pi-agent-core` | MIT；BYOK，本地模型友好 | 低中；**用户本机就在用** |
| **Amp** `@sourcegraph/amp` | 0.0.1792800065 | npm 1.6 万/周 | `-x/--execute`；`--stream-json`（必须配合 execute） | `amp threads continue <id>` | `--dangerously-allow-all`（第三方示例，未核实） | `/mode`（smart/free 等） | 未核实 | 只有第三方 `amp-acp` | `@sourcegraph/amp-sdk` | 闭源；有 Free 模式（限流），按量付费 | 低 |
| **Crush** `charmbracelet/crush` | v0.98.2 | 2.88 万星；`@charmland/crush` 5.7k/周 | `crush run`；`-q`、`--yolo`、`--session`、`--continue`、`--model`；**没有 JSON 流式输出**（文档里没有，未核实） | 有 | `--yolo` | `--model` | 未核实 | 没有（未核实） | 无 | FSL-1.1 类许可（GitHub 标为 NOASSERTION） | 低 |
| **Kiro CLI**（AWS） | 2.x（未核实） | Kiro 仓库 4.4k 星 | `kiro-cli chat --no-interactive`；JSON 流未核实 | 未核实 | `--trust-all-tools`、`--trust-tools=...` | 未核实 | 未核实 | 文档列了 ACP（具体参数未核实） | 无 | headless 要 `KIRO_API_KEY`，只有 Pro/Pro+/Power 订阅有 | 低（国内可用性未核实） |
| **Aider** | v0.86.0（**2025-08** 之后没再发版） | 4.97 万星 | `--message`、`--yes-always`；没有结构化 JSON 流 | 只有聊天历史文件 | `--yes-always` | `--model` | 支持（`/add` 图片） | 无 | Python 脚本接口 | Apache-2.0 | 低；**项目基本停更** |
| **iFlow CLI** | 0.5.19 | 5k 星 | — | — | — | — | — | — | — | **2026-04-17 已停服**，官方建议迁到 Qoder | 不考虑 |
| Trae | `bytedance/trae-agent` 1.2 万星，偏研究用途 | — | 没找到官方 headless CLI 包（未核实） | | | | | | | MIT | 国内 IDE 很火，但没有可用的 CLI |

注册表里其他中国相关的 agent：`kimi`（仓库已支持）、`glm-acp-agent`、`minimax-code`（`@minimax-ai/code`，注意别跟 PR #33 撞车）、`kilo`（Kilo Code，`@kilocode/cli` 7.8.17，是 OpenCode 的 fork，`kilo acp`）。

### B2. 推荐（按优先级）

**0）先做通用 ACP adapter**（前提）。用 `@agentclientprotocol/sdk` 2.x，按 stdio 起子进程，走 `initialize → session/new | session/load → session/prompt` 流程：
- `session/update` 流可以映射到 `onIntermediate`：消息块对应 text，思考块对应 thinking，tool_call 对应 tool_use/tool_result。
- `session/request_permission` 映射到 `/mode`：auto 选 allow_always，safe/plan 选 reject。也可以接 `askUser` 让用户在微信里点选。
- 图片用 ACP 的 image content block（base64）传。
- 续接靠 agent 是否支持 `loadSession` 能力，sessionId 存进 `settings.sessionIds`。
- 每家 CLI 只需一条配置 `{command, args}`，直接照抄注册表里的写法。
- **工作量：中等，约 2–3 人日**（含测试 fake）。之后每加一个 CLI 约 0.5 人日（配置 + 实测 + 文档）。
- 附带好处：OpenCode V1 和 V2 都能走 `opencode acp`，Kimi、Gemini 也能统一过来。

**1）Qwen Code**：国内最热门的开源 CLI，Apache-2.0，ACP 和 stream-json 都有，而且它的 stream-json 是 Claude Code 格式，也可以直接复用 claude.ts 的解析器。工作量：走 ACP 很轻松；单独写 adapter 约 1 人日。要提醒用户：OAuth 免费额度已经没了，得配 Coding Plan 或 API key。

**2）CodeBuddy Code（腾讯）**：周下载 13 万，国内用户多，参数基本照搬 Claude Code（`-p --output-format stream-json --permission-mode --resume --session-id -y`），还支持 `--acp`。工作量：走 ACP 很轻松；直接复制 claude adapter 约 0.5–1 人日。

**3）GitHub Copilot CLI**：全球装机量最大的候选（130 万/周），有 `--acp`、`-p --output-format json`、`--attachment` 传图、`--resume`。工作量：走 ACP 很轻松；单独写 adapter 约 1 人日。国内网络和订阅门槛要在文档里写清楚。

**4）备选**：Cursor CLI（stream-json 和 ACP 都有，国内 Cursor 用户多，但必须有订阅）或 pi（用户自己在用、MIT、本地模型友好，`--mode json` 很容易解析，走 `pi-acp` 或原生 JSONL 都行）。

**不推荐**：iFlow（已停服）、Aider（停更、没有 JSON 流）、Crush（没有 JSON 输出也没有 ACP，许可证有限制）、Kiro（必须付费订阅，国内不可用）、Amp（只有第三方 ACP，热度低）。

---

## 来源
- OpenCode releases：https://github.com/anomalyco/opencode/releases
- 1.19.4 源码（权限事件 / 路由）：https://github.com/anomalyco/opencode/blob/v1.19.4/packages/schema/src/v1/permission.ts 、 https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts 、 .../groups/session.ts
- OpenCode 2.0：https://alternativeto.net/news/2026/10/opencode-2-0-officially-launches-with-background-agents-code-mode-and-a-rebuilt-api/ 、 https://capitalandcompute.net/blog/opencode-2-0-what-changed/ 、 https://thenewstack.io/?p=22840157
- Homebrew：https://formulae.brew.sh/api/formula/opencode.json
- ACP 注册表：https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json ；Zed：https://zed.dev/blog/acp-registry 、 https://zed.dev/docs/ai/external-agents.html
- Qwen Code headless：https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/ ；免费额度关闭：https://inventivehq.com/blog/qwen-code-still-free-2026-shutdown
- Copilot CLI：https://docs.github.com/en/copilot/reference/cli-command-reference
- Cursor CLI：https://cursor.com/docs/cli/reference/parameters
- CodeBuddy：https://www.workbuddy.ai/docs/cli/headless 、 https://www.workbuddy.ai/docs/cli/release-notes/v2.52.0 、 https://zed.dev/acp/agent/codebuddy-code
- Qoder：https://docs.qoder.com/cli/headless 、 https://docs.qoder.com/en/cli/acp 、 https://help.aliyun.com/en/lingma/qodercli-cn/product-overview/what-is-qoder-cli-cn
- iFlow 停服：https://github.com/router-for-me/CLIProxyAPI/issues/2561
- Factory Droid：https://docs.factory.ai/droid-exec/overview
- Cline CLI：https://docs.cline.bot/cline-cli/cli-reference
- Auggie：https://docs.augmentcode.com/cli/reference
- goose：https://www.mankier.com/1/goose-run 、 https://www.mankier.com/1/goose-acp
- Amp：https://ampcode.com/docs/cli/streaming-json 、 https://ampcode.com/news/amp-free
- Crush：https://next-docs.charm.land/crush/cli/run.html 、 https://github.com/charmbracelet/crush/releases
- Kiro：https://kiro.dev/docs/cli/headless/ 、 https://kiro.dev/changelog/cli/2-0/
- 本地核实：npm pack 了 `@qwen-code/qwen-code@0.26.0`、`@tencent-ai/codebuddy-code@2.174.0`、`@augmentcode/auggie@0.36.0`、`@mariozechner/pi-coding-agent@0.73.1`、`@opencode-ai/sdk@1.19.4`、`@opencode/sdk@2.1.4`（解压在 scratchpad，没有执行任何代码）
