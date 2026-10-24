# cli-in-wechat 大版本更新计划（2026-10-23）

> 状态：**阶段 1（调研 + 计划）完成，等待确认范围**。本文只是计划，还没有改任何代码。
> 调研原始笔记（带来源链接、版本号、「未核实」标注）在 [`2026-10-23-big-update-research/`](./2026-10-23-big-update-research/)：
> `research-claude.md`、`research-codex.md`、`research-gemini-kimi-acp.md`、`research-opencode-newcli.md`、`research-longtail-cli.md`、`research-bridges.md`。

---

## 0. 总原则：精简、好用、轻量

用户明确要求这次更新要让项目「非常之精简好用轻量」。落到工程上就是下面这些硬约束，后面每个 PR 都按它们取舍：

1. **一个 CLI 只保留一条执行路径。** 不做「SDK 加 CLI 加 JSONL」三套并存。现在 OpenCode 就有 3 个文件，以后不再出现这种情况。
2. **不新增运行时依赖，并且要减依赖。**
   - Claude 去掉 `@anthropic-ai/claude-agent-sdk`（用户 2026-10-24 决定）。SDK 0.3 会自带一个 268MB 的平台原生二进制，node_modules 会从 122MB 涨到 367MB，而桥接本来就要求本机已经装好 `claude`。改为直接 spawn 本机 `claude`，用双向 stream-json，审批走 `--permission-prompt-tool stdio` 的控制协议，cc-connect 也是这么做的。
   - ACP 客户端自己写一个很薄的 JSON-RPC over stdio（大约 300 行），不引入 `@agentclientprotocol/sdk`。原因是这个 SDK 的 2.0 四天前刚发布就删掉了旧 API，在 Node 20 上能不能跑也没核实。
   - Codex 自己解析 `exec --json`，不引入 `@openai/codex-sdk`。这个 SDK 本身也只是 spawn `codex exec` 再解析输出。
3. **长尾 CLI 不写代码，只写配置。** 一个通用 ACP 适配器加少量预设，就能覆盖 30 多个 CLI。用户也可以自己在 config 里加。
4. **命令精简。** router 里现在有大约 66 个斜杠命令分支，其中不少已经弃用，或者只对某一个 CLI 生效。计划把常用的留成一级命令，其余收进 `/set`，帮助文本按当前工具的能力自动生成。
5. **能用默认值就不给开关。**

---

## 1. 调研结论（一页版）

### 1.1 各 CLI 最新状态（截至 2026-10-23）

| CLI | 最新版本 | 本机 | 关键变化 |
|---|---|---|---|
| Claude Code / Agent SDK | CLI 2.1.310，SDK `@anthropic-ai/claude-agent-sdk` 0.3.310 | 2.1.300 | 我们锁在 `^0.2.81`，只能装到 0.2.141。0.3.x 的变化：打包方式改了，新增 peer deps（zod 4 等），permissionMode 新增 `auto`（分类器自动审批），支持流式输入（原生图片、`interrupt()`、`setPermissionMode()`），增加了 `tool_progress`/`task_*` 子代理事件、`listSessions`/`forkSession`。 |
| Codex CLI | 0.164.0（SDK 同号） | 0.153.0 | `exec --json` 输出 JSONL 事件流（`thread.started`/`item.*`/`turn.completed{usage}`）。支持 `exec resume <id>`、`-i` 传图、`-c model_reasoning_effort=`。`--full-auto` 已移除。`app-server`（JSON-RPC）是唯一支持「审批回调」的接口，但仍是 experimental。`mcp-server` 已移除。 |
| Gemini CLI | 0.65.0 | 未装 | **文件夹信任默认开启**：不受信任的目录里，yolo 会被静默降级为 default，非交互模式下写操作全部被拒。`stream-json` 已可用。新增 `--session-id`。新增 `plan` 审批模式。`--acp` 已转正。**个人账号 2026-06-18 起停止服务，迁到 Antigravity CLI `agy`**（二手来源，未核实官方原文）。 |
| Kimi Code | 2.3.1 | 未装 | 新增 `--output-format stream-json`（最后会带真实会话 ID）。新增会话锁：并发 `--continue` 会以退出码 4 失败。提供 `kimi acp`。旧版 Python kimi-cli 已归档。 |
| OpenCode | V1 1.19.4（npm latest），V2 2.1.4（新包名 `@opencode/*`） | 未装 | 1.19 起权限事件改名为 `permission.asked`（旧名 `permission.updated` 不再发出）。新增 `question.asked`。**V2 的 server API 整个重做了**，Homebrew 已经跟到 V2，所以用户 PATH 里的 `opencode` 很可能就是 V2，而 V1 SDK 连上去大概率会全挂。`opencode acp` 在 V1 和 V2 都有。 |

### 1.2 现有适配器体检（确认坏掉或过时的）

| # | 适配器 | 问题 | 后果 | 严重度 |
|---|---|---|---|---|
| 1 | claude | `canUseTool` 除了 AskUserQuestion 一律放行 | **`/mode safe` 等同于 bypass，`plan` 模式也能写文件** | P0 |
| 2 | claude | SDK 抛错一律回退到 CLI 重跑；官方文档说出错时会先给 result 再抛异常 | **同一个任务可能执行两次** | P0 |
| 3 | claude | 依赖锁在 `^0.2.81` | 用不上 0.3 的任何新能力 | P1 |
| 4 | claude | 并行工具调用用 `pendingToolName` 配对；子代理消息（`parent_tool_use_id`）没有过滤 | 工具结果挂错；子代理刷屏 | P1 |
| 5 | claude | 图片只把路径写进文本 | 模型看不到图（除非它自己去 Read） | P1 |
| 6 | claude | CLI 回退路径漏传 `--max-turns`，safe 模式也没传 `--permission-mode default`；注释说这两个参数「已移除」，这是错的 | 回退路径失去轮次上限 | P2 |
| 7 | codex | `exec resume --last` 取的是「这个 cwd 下最近的会话」 | **多个微信用户共用 workDir 时会串会话**，连本机手动跑的 codex 也会被接上 | P0 |
| 8 | codex | resume 分支把 sandbox/model/search/add-dir 全丢了 | 第二轮起可能变成只读沙箱，或回到默认模型 | P0 |
| 9 | codex | `-c tools.web_search=live` 这个键不对，应为 `web_search="live"` | `/search` 很可能根本不生效 | P1 |
| 10 | codex | 只拿原始 stdout | 声明了支持流式，实际一次都没调 `onIntermediate`；没有 effort，没有图片，没有 usage | P1 |
| 11 | gemini | 没处理文件夹信任 | **yolo 被降级，写操作全部失败**；修法是设环境变量 `GEMINI_CLI_TRUST_WORKSPACE=true` | P0 |
| 12 | gemini | `--output-format json` 的 `response` 只有最后一段文字；`stats.duration_ms` 根本不存在 | 回答被截断；没有流式 | P1 |
| 13 | gemini | 认证错误的提示还停留在 API key 时代 | 个人账号停服后，用户会看不懂报错 | P2 |
| 14 | kimi | `--continue` 会串会话，并发时触发会话锁，退出码 4 | **多会话下直接失败** | P0 |
| 15 | kimi | 用 `text` 输出，stdout 为空时把 stderr（thinking、版本号）当成答案发出去 | 回复里混进杂质 | P1 |
| 16 | opencode-sdk | 监听的是 `permission.updated`（第 420 行附近），1.19 起已改名为 `permission.asked` | **safe/plan 模式，或配置里有 `ask` 规则时，任务卡死到 1 小时超时** | P0 |
| 17 | opencode-sdk | 没处理 `question.asked`；import 还没迁到 `@opencode-ai/sdk/v2`；V2 服务端完全不兼容 | 提问时卡住；V2 用户整个不可用 | P1 |

### 1.3 生态大势

- **ACP（Agent Client Protocol）已经是事实标准。** 官方注册表收录了 46 个以上的 agent，Gemini、Kimi、Qwen Code、Copilot、Cursor、Droid、Devin、Goose、Kiro、Cline、Junie、Qoder、CodeBuddy、MiniMax Code、Antigravity、OpenCode 都原生支持。协议本身统一了流式输出、thinking、权限请求（`session/request_permission`）、图片输入和会话恢复（`session/load`）。
- **stream-json 方言在向「类 Claude」格式收敛。** CodeBuddy 的参数几乎照抄 Claude Code，Qwen Code 的 stream-json 也是 Claude 格式。
- **竞品已经很强。** cc-connect（Go 写的，16k★）已经支持个人微信 ilink、飞书、钉钉等 13 个以上平台，CLI 覆盖我们现有的五个加任意 ACP agent，还能逐次审批、任务中补充指令、节流流式、cron。Qwen Code 0.26 和 CodeBuddy 也自带了微信远程控制，用的是同一套 iLink。
  - **我们的差异化**：一个 Node 包、零配置、一个微信同时驱动多家 CLI（`>>` 工具接力和 `@a>b` 链式调用是独有功能）、配额感知的投递。所以要在「轻」和「体验」上做透，不在平台数量上跟它们拼。
- **微信的硬约束**：消息不能编辑；每条入站消息大约只有 10 条出站配额（见 `src/ilink/quota.ts`）。所以流式输出只能「节流加合批」，审批消息也要占配额，设计时必须精打细算。

---

## 2. 目标架构：三种接入方式

```
                 ┌─ 原生适配器（只给头部 CLI）：claude(stream-json 双向 + stdio 控制协议) / codex(exec --json)
CLIAdapter ──────┼─ AcpAdapter（通用）：一份代码 + 预设表 → gemini? kimi? qwen copilot cursor droid devin goose kiro qoder codebuddy mcode agy …
                 └─ StreamJsonAdapter（通用，类 Claude 格式）+ TextAdapter：给没有 ACP、或 ACP 不稳的 CLI，以及用户自定义 CLI
```

- **原生适配器**只留给能力明显超过 ACP 包装层的 CLI：Claude 有 stdio 控制协议里的 can_use_tool、子代理事件和会话管理；Codex 的 ACP 只是第三方包装。
- **AcpAdapter**：
  - **进程模型**：按（用户 × agent × workDir）常驻一个子进程，空闲 N 分钟后回收，崩溃了下一条消息重新拉起。为了先轻量，第一版可以先做「每条消息 spawn 一次：`initialize → session/load|new → prompt` 后退出」，常驻作为后续优化。
  - **权限**：`session/request_permission` 按模式处理——auto 直接批准，safe 走统一的「交互请求」发到微信，plan 一律拒绝。
  - **会话恢复**：用 `session/load`。恢复时会重放历史，要把重放的历史屏蔽掉，不能刷到微信。
  - **图片**：通过 ACP 的 image content block 原生传入。
  - **Windows**：prompt 不经过 argv，顺带绕开了 cmd.exe 转义问题。
- **自定义 CLI**：在 `config.json` 里加一个 `agents` 数组，每项写 `{ name, command, args, protocol: "acp" | "claude-stream-json" | "text", alias? }`。不做 JSONPath 那套通用映射，太重。内置预设也用同样的格式，用户可以覆盖。
- **统一的「交互请求」**：把现有的 `AskUserRequest` 扩展成平台无关的 `InteractionRequest`（类型为 `question` 或 `approval`）。微信端回 `1` 表示允许一次，`2` 表示本会话总是允许，`3` 表示拒绝，5 分钟超时就拒绝。以后接飞书时，可以直接把它渲染成卡片按钮，不用返工。

---

## 3. 每个 CLI 的适配清单

### Claude Code（原生，CLI 双向 stream-json，无 SDK）
> 用户 2026-10-24 决定：去掉 Agent SDK，只保留一条执行路径。
- [ ] 删除 `@anthropic-ai/claude-agent-sdk` 依赖，以及只为它引入的 peer deps。
- [ ] spawn 本机 `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`。user 消息从 stdin 写入，图片用原生 image content block（base64）。控制协议（`control_request`/`control_response`，包括 initialize、can_use_tool、interrupt）以 SDK 0.3.310 包内的实现为准。
- [ ] 一次 execute 只 spawn 一次，不设任何回退，因此不会重复执行。
- [ ] 工具结果用 `tool_use_id` 配对；过滤掉 `parent_tool_use_id` 不为空的子代理消息，子代理只显示「开始/完成」两行。
- [ ] 补上 `disallowedTools`、`--add-dir`、`--max-turns`；读取 `total_cost_usd` 和 usage；在 system init 消息里提前拿到 session_id；`tool_progress` 当作心跳，用来重置空闲超时；取消时先发 interrupt，再兜底 kill。
- [ ] 模式：auto 继续映射到 bypass（用户 2026-10-24 确认，不改用 auto 分类器），safe 映射到 default，plan 映射到 plan（不能写文件）。
- [ ] can_use_tool：AskUserQuestion 走 askUser。其他工具在 C1 之前先拒绝并给出提示；C1 之后走 InteractionRequest，提供允许一次、本会话总是允许（用协议里的 permission suggestions）、拒绝三个选项。

### Codex CLI（原生，exec --json）
- [ ] 改用 `codex exec --json`，自己解析 JSONL（类型照抄 SDK 的 `index.d.ts`）。
- [ ] **按 `thread_id` 恢复会话**（`exec resume <id>`），并且恢复时把全部选项带上，选项要放在 `resume` 之前。
- [ ] 把 `item.*` 事件映射成 IntermediateMessage：command_execution、file_change、mcp_tool_call、web_search、reasoning、todo_list。
- [ ] 支持 effort（`-c model_reasoning_effort=`），把能力声明里的 `hasEffort` 打开；图片走 `-i`；联网搜索改成正确的 `web_search="live"`；读取 `usage`。
- [ ] 审批：exec 模式没有审批回调。safe 模式先映射成 `--sandbox workspace-write` 加 `approval_policy=never`（在沙箱内自动执行）。真正在微信里审批需要 app-server，放到 P2，可选。

### Gemini CLI
- [ ] **P0 热修**：启动时设环境变量 `GEMINI_CLI_TRUST_WORKSPACE=true`；改用 `--output-format stream-json`；首轮用 `--session-id <uuid>` 由桥接层自己指定会话 ID，后续用 `--resume <id>`；审批模式和 `/mode` 对应（safe→default，plan→plan）。
- [ ] 认证失败时提示：个人账号已停服，请改用 API Key，或者换 `agy`。
- 待你决定：长期是保留原生 stream-json 适配器，还是迁到 AcpAdapter 并删掉 `gemini.ts`？（推荐迁 ACP，这样才有微信内审批和图片输入。）

### Kimi Code
- [ ] **P0 热修**：改用 `--output-format stream-json`，从输出里拿真实会话 ID，后续用 `-S <id>` 恢复，不再用 `--continue`；stdout 为空时不再把 stderr 当成答案。
- 同 Gemini：长期推荐迁到 `kimi acp`。在 `-p` 模式下 `/mode` 是无效的，走 ACP 就能有真正的审批。

### OpenCode
- [ ] **P0 热修**：同时监听 `permission.asked` 和旧的 `permission.updated`，兼容新旧版本；回复改用 `POST /permission/{id}/reply`；处理 `question.asked`，接到 askUser。
- [ ] 检测服务端是不是 V2，是的话给出明确报错，不能静默卡死。
- **不碰模型列表和模型过滤**，这部分归 PR #33。
- 待你决定：长期是否改走 `opencode acp`？这样能同时兼容 V1 和 V2，可以删掉 `opencode-sdk.ts`、`opencode.ts`、`opencode-jsonl.ts` 三个文件和 `@opencode-ai/sdk` 依赖，也最符合「轻量」原则。代价是 PR #32 刚做的 SDK 流式工作会作废。

---

## 4. 新增 CLI

按接入方式分层（完整的约 60 个 CLI 见 `research-longtail-cli.md`）：

| 层级 | 接入方式 | CLI |
|---|---|---|
| **一等预设（推荐内置）** | ACP 预设 | **Qwen Code**（`qwen --acp`）、**GitHub Copilot CLI**（`copilot --acp --stdio`）、**Cursor CLI**（`agent acp`）、**Factory Droid**、**Devin CLI**（`devin acp`）、**CodeBuddy（腾讯）**、**Qoder**、**MiniMax Code**（`mcode acp`） |
| 一等（需要专门处理） | 原生 stream-json | **Antigravity `agy`**（Gemini 个人用户的去处；有 ACP，但需要实测）、**pi**（`--mode rpc`，按 LF 分帧，**它没有权限系统**） |
| 文档预设（不写代码） | ACP 配置示例 | Goose、Kiro、Cline、Auggie、OpenHands、Junie、Mistral Vibe、Grok、Kilo 等 |
| 不支持 | — | iFlow（已停服）、Roo（已归档）、Plandex（停更）、Jules（只有云端）；百度 Comate、通义灵码、TRAE IDE、DeepSeek 没找到官方 headless CLI |

国产 CLI 里真正可用的有：CodeBuddy（npm 周下载 13 万）、Kimi Code、Qwen Code（注意它的免费 OAuth 额度 2026-04-15 已关闭）、Qoder、MiniMax Code、智谱 ZCode。

> 注意：本机 `~/.local/bin/qwen` 不是 Qwen Code，而是「pi + 本地 Qwen3.8-27B」的包装脚本。

切换命令：保留现有的 `/cc /cx /gm /km /oc`，新增一个通用的 `/use <名字>`，覆盖预设和自定义 CLI。不再给每个新 CLI 单独加两个字母的命令，帮助文本里只列出本机实际装了的。

---

## 5. 通用功能（从同类项目借鉴，按优先级）

| 优先级 | 功能 | 说明 |
|---|---|---|
| P0 | **真正的工具审批** | 就是第 2 节的 InteractionRequest。参考 Claude-to-IM 在微信里「回 1/2/3」的做法。要考虑审批消息占用配额，同一轮里多个审批请求合并成一条发出。 |
| P1 | 流式补齐 | Codex、Gemini、Kimi、ACP 都接入 IntermediateMessage，沿用 router 现有的节流合批逻辑，不另起一套。 |
| P1 | 命令瘦身 | 删掉已弃用的命令（`/verbose`、`/thinking`）；CLI 专属开关（`/bare /name /profile /ext /include /approval /ephemeral` 等）收进 `/set <键> <值>`，`/status` 只显示当前工具相关的项。**这是一次破坏性变更**，会在 README 里写迁移说明。 |
| P2 | 任务运行中又来新消息 | 目前的行为待确认。需要先跟 #27 的 Agent 生命周期设计对齐，再决定是排队还是补充指令（steer）。 |
| P2 | 用量和费用 | Claude 的 `total_cost_usd`、Codex 的 `usage`、ACP 的 usage 统一放进 `/stats`。 |
| P2 | Codex app-server | 只为了「Codex 在微信里审批」这一个需求，可选。 |
| P3（只评估） | 飞书和多平台（issue #17） | 见第 7 节。 |
| 不跟 | Web 管理台、cron、语音、run_as_user、i18n | 和轻量原则冲突，或者需求不明确。语音可以直接用微信自带的 `voice_item.text`，成本很低，以后单独再议。 |

---

## 6. PR 拆分（每个 PR 都基于最新的 `origin/main`，独立可合，都带测试）

测试做法沿用 `test/opencode-*.test.ts`：用假子进程或 mock SDK 抓 argv 和事件，**不调用真实的付费推理**。本机装了 Claude Code 2.1.300 和 codex 0.153，可以做冒烟测试，其余 CLI 在 PR 里写明没有实测。

### A 波：现有适配器修复（只改适配器层，不碰 router，可以和 #27 并行）
| PR | 内容 | 依赖 |
|---|---|---|
| **A1 codex** | 改用 exec --json 解析；按 thread_id 恢复；恢复时带全部选项；流式事件；effort；图片；web_search；usage | 无 |
| **A2 gemini** | 信任环境变量；stream-json；`--session-id`；审批模式映射；报错文案 | 无 |
| **A3 kimi** | stream-json；`-S <id>`；不再拿 stderr 当答案 | 无 |
| **A4 opencode** | `permission.asked`、`question.asked`、V2 检测 | 避开 #33 的模型列表改动 |
| **A5 claude**（#40） | 去掉 Agent SDK，改为 CLI 双向 stream-json 加 stdio 控制协议；不重复执行；tool_use_id 配对；子代理过滤；原生图片；心跳；费用；auto 仍走 bypass | 无（审批放到 C1） |

### B 波：通用接入层（新文件为主，router 只加最少的注册代码）
| PR | 内容 | 依赖 |
|---|---|---|
| **B1 AcpAdapter** | 手写一个很薄的 ACP 客户端；第一版每条消息 spawn 一次；权限按模式处理（auto 批准、plan 拒绝；safe 先拒绝并提示「审批功能将在后续版本支持」，C1 之后改成发到微信）；`session/load` 并屏蔽历史重放；图片；内置第 4 节的一等预设 | 无 |
| **B2 自定义 CLI 配置** | `config.json` 里的 `agents` 字段；`claude-stream-json` 和 `text` 两种通用解析器；CodeBuddy 和 Qwen 的 stream-json 也可以走这里 | B1 |
| **B3 agy / pi**（可选） | 两个原生 stream-json 或 RPC 的小适配器 | 由你决定做不做 |

### C 波：router 侧（**等 #27 合并后再 rebase**，改动尽量小）
| PR | 内容 | 依赖 |
|---|---|---|
| **C1 微信内审批** | 把 AskUserRequest 扩展成 InteractionRequest；接上 Claude canUseTool、OpenCode 权限、ACP request_permission；合并审批消息、控制配额；超时就拒绝 | #27、A4、A5、B1 |
| **C2 `/use` 和动态帮助** | 按注册表生成工具列表和帮助；新增 `/use` | #27、B1 |
| **C3 命令瘦身** | 引入 `/set`；删掉已弃用命令；精简 `/status` | #27 |
| （可选）C4 | 运行中新消息怎么处理 | #27 落地之后另行设计 |

### D 波：收尾
| PR | 内容 |
|---|---|
| **D1** | 更新 README 和文档（支持矩阵、自定义 CLI 写法、命令迁移表）；版本号从 0.1.0 升到 **0.2.0**（含破坏性变更）；CHANGELOG |

建议顺序：先并行做 A1–A5，然后 B1→B2，等 #27 合并后做 C1→C2→C3，最后 D1。

---

## 7. 多平台和飞书（issue #17）—— 只评估，由你决定

- **可行性**：可行。`Router` 只调用了 `ILinkClient` 的 6 个左右方法，微信专有的逻辑集中在 `src/ilink/`，CLI 适配器层完全不用改。
- **飞书能提供什么**：长连接 WebSocket，不需要公网 IP，但只对企业自建应用开放；事件要在 3 秒内回 ACK；有交互卡片，可以做审批按钮；卡片可以原地更新（14 天内的消息、不超过 30KB、单条 5 QPS），能做真正的流式输出。
- **工作量粗估 9–16 人日**：抽出平台接口 2–4 天，飞书基础版 2–3 天，卡片、流式和审批 4–7 天，配置和文档 1–2 天。
- **风险**：
  - router 里微信特有的逻辑（引用消息路由、「继续」恢复、配额裁剪）在抽象时容易改坏。
  - 会话 key 要从 `uid` 改成 `平台:uid`，现有会话文件需要迁移。
  - 和 #27 的投递生命周期改造高度重叠，必须等 #27 稳定之后再做。
- **建议**：这次大更新先不做。但 C1 的 InteractionRequest 会按平台无关的方式设计（Claude 一侧对接 stdio 控制协议里的 can_use_tool），给以后接飞书留好接口。要不要立项，由你决定。

---

## 8. 风险与兼容性

1. **Claude 去掉 SDK**：stdio 控制协议没有正式文档，是参照 SDK 包内的实现来写的；以后 CLI 升级时可能会变，需要靠测试 fixture 加冒烟测试来盯住。好处是依赖为零，和用户本机 `claude` 的版本、登录态保持一致。
2. **会话 ID 迁移**：Codex 和 Kimi 旧存的哨兵值 `'last'` / `'continue'` 需要兼容。读到旧值时当作「没有会话」，开一个新会话，并提示用户一次。
3. **行为变化**：safe 模式从「实际上是 bypass」变成「真的会问你」，这是用户能感知到的变化，要在 README 和 `/mode` 的提示里写清楚。命令瘦身也是破坏性变更，所以升到 0.2.0。
4. **ACP 的不确定性**：各家的模式 ID 不统一；OAuth 不能交互登录（必须提前登录或用 API Key）；有些 CLI 的 ACP 还在 preview（比如 Copilot）。预设只收录核实过的，其余只写文档。
5. **配额**：审批和流式都要占出站配额。C1 必须给最终答案预留配额，不能让审批消息把它挤掉。
6. **协调**：
   - 不碰 #27 涉及的入站和投递生命周期。C 波统一等 #27 合并之后再 rebase。
   - OpenCode 的模型列表不动，留给 #33。
   - 主 checkout 不碰。
7. **真实测试覆盖**：本机只能实测 Claude 和 Codex。Gemini、Kimi、OpenCode 和 ACP 的各家 CLI 只能用假子进程测协议，会在 PR 里标明「未实测」。

---

## 9. 需要你确认的事

1. **范围**：A、B、C、D 四波都做？还是先只做 A 波（修 bug）加 B1（ACP）？
2. **Gemini、Kimi、OpenCode 长期是否迁到 ACP，并删掉原生适配器？**（推荐：A 波先热修，B1 稳定之后再迁，迁完删旧代码。）
3. **新 CLI 内置哪些**：推荐 Qwen Code、Copilot、Cursor、CodeBuddy、Droid、Devin 作为 ACP 一等预设，`agy` 和 `pi` 是否做专用适配器（B3）？
4. **`/mode auto` 对 Claude 的映射**：继续用 bypass，还是换成新的 `auto` 分类器？
5. **命令瘦身（C3）是破坏性变更**，可以接受吗？
6. **飞书**：这次不做（推荐），还是另开一个项目？
